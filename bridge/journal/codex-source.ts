// Codex's physical logs and the conversation they represent are different after a rewind.
//
// Verified against Codex 0.163.0, 2026-10-17: threads.rollout_path in $CODEX_HOME/state_5.sqlite
// moves to rollout-<time>-<session>_<segment>.jsonl while the public session id stays the same.
// Its session_meta.history_base retains a prefix of an OLDER segment, then this file supplies the
// new rows. A second rewind can name the first segment's suffix id as its base. Historical lookups
// therefore match the last UUID in the filename and never follow the active database pointer.

import { Database, SQLiteError } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";
import type { Cursor, ReadSince } from "./cursor.ts";
import {
  containedRealpath,
  FIRST_TAIL_BYTES,
  loadTail,
  MAX_TRANSCRIPT_BYTES,
  readSinceFile,
  rootList,
  statFile,
} from "./files.ts";
import type { AgentSessionRef, TranscriptSource } from "./types.ts";

/** Public session ids and historical segment ids both have this shape. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Bounds ancestor lookups; each header read is also capped by the view's byte limit. */
const MAX_BASE_DEPTH = 64;
const STATE_DB = /^state_\d+\.sqlite$/;

interface HistoryBase {
  id: string;
  end: number;
  ordinal: number;
}

interface RetainedHistory {
  text: string;
  complete: boolean;
}

/** Null means no inherited history; undefined means a header we could not safely read. */
async function historyBase(path: string, maxBytes: number): Promise<HistoryBase | null | undefined> {
  try {
    // session_meta embeds custom instructions, so its first row can exceed the usual 64 KiB head.
    // Grow only until that row ends, under the same bound as the History or live read.
    const file = Bun.file(path);
    let first = "";
    for (let bytes = Math.min(64 * 1024, maxBytes); ; bytes = Math.min(bytes * 2, maxBytes)) {
      const prefix = Buffer.from(await file.slice(0, bytes).arrayBuffer());
      const newline = prefix.indexOf(0x0a);
      if (newline === -1 && prefix.length === bytes && bytes < maxBytes) continue;
      first = prefix.subarray(0, newline === -1 ? prefix.length : newline).toString("utf8");
      break;
    }
    // SAFETY: JSON.parse produces a JsonValue; asRecord and the field checks below narrow it.
    const row = asRecord(JSON.parse(first) as JsonValue);
    if (row === null || row.type !== "session_meta") return null;
    const payload = asRecord(row.payload);
    if (payload === null) return undefined;
    if (payload.history_base === undefined || payload.history_base === null) return null;
    const base = asRecord(payload.history_base);
    if (base === null || typeof base.thread_id !== "string" || !isCodexSessionId(base.thread_id)) return undefined;
    const end = base.end_byte_offset;
    const ordinal = base.end_ordinal_exclusive;
    if (typeof end !== "number" || !Number.isSafeInteger(end) || end < 0) return undefined;
    if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
    return ordinal === 0 ? null : { id: base.thread_id, end, ordinal };
  } catch {
    return undefined;
  }
}

/** Directory entries in descending order; a missing directory contributes no candidates. */
async function descending(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).toSorted().toReversed();
  } catch {
    return [];
  }
}

/**
 * The database names the ACTIVE log, not its content. Null means no matching entry or an unsupported
 * schema. A result whose path is null means the index or its log is unreadable; it must not fall back
 * to an old branch.
 *
 * Query each time instead of caching the main database's mtime: an update may live only in its WAL.
 * The small read-only connection is closed after the lookup, so no transaction holds Codex's writer.
 */
async function indexedRollout(root: string, id: string): Promise<{ path: string | null } | null> {
  const home = dirname(root);
  const names = (await descending(home)).filter((name) => STATE_DB.test(name))
    .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const name of names) {
    const path = await containedRealpath(join(home, name), home);
    if (path === null) continue;
    let db: Database | undefined;
    let row: { rollout_path: string } | null;
    try {
      db = new Database(path, { readonly: true });
      row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(id);
    } catch (error) {
      // Missing tables/columns in an older schema permit legacy lookup. Recovery (including
      // SQLITE_BUSY_RECOVERY on Codex startup) and other read failures cannot name the active log.
      if (error instanceof SQLiteError && error.code === "SQLITE_ERROR") continue;
      return { path: null };
    } finally {
      db?.close();
    }
    if (row === null) continue;
    const candidate = row.rollout_path;
    return {
      path: typeof candidate === "string" && isAbsolute(candidate)
        ? await containedRealpath(candidate, root)
        : null,
    };
  }
  return null;
}

export class CodexTranscriptSource implements TranscriptSource {
  // Segment identities are immutable. Only these lookups are cached; the active pointer is not.
  private readonly segments = new Map<string, string>();
  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isCodexSessionId(ref.value)) return null;
    const id = ref.value.toLowerCase();
    for (const root of this.roots) {
      const indexed = await indexedRollout(root, id);
      if (indexed !== null) {
        if (indexed.path !== null) return indexed.path;
        continue;
      }
      const path = await this.segment(root, id);
      if (path !== null) return path;
    }
    return null;
  }

  /** Historical ids match either the original file's id or a rewind file's final suffix id. */
  private async segment(root: string, id: string): Promise<string | null> {
    const key = `${root}\0${id.toLowerCase()}`;
    const cached = this.segments.get(key);
    if (cached !== undefined) {
      const checked = await containedRealpath(cached, root);
      if (checked !== null) return checked;
      this.segments.delete(key);
    }
    const suffix = `${id.toLowerCase()}.jsonl`;
    for (const year of await descending(root)) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          for (const name of await descending(dir)) {
            const lower = name.toLowerCase();
            if (!lower.startsWith("rollout-") || !(lower.endsWith(`-${suffix}`) || lower.endsWith(`_${suffix}`))) continue;
            const path = await containedRealpath(join(dir, name), root);
            if (path === null) continue;
            this.segments.set(key, path);
            return path;
          }
        }
      }
    }
    return null;
  }

  private async rootFor(path: string): Promise<string | null> {
    for (const root of this.roots) {
      if (await containedRealpath(path, root) !== null) return root;
    }
    return null;
  }

  /**
   * Read the newest end of the retained prefixes, under ONE byte budget across the entire chain.
   * Byte offsets are physical positions in each parent file; ordinals include its inherited rows.
   * A missing/malformed ancestor leaves a partial history, never the abandoned remainder of a log.
   */
  private async retained(path: string, root: string, limit: number, used: number): Promise<RetainedHistory> {
    const chunks: Buffer[] = [];
    const visited = new Set([path]);
    let base = await historyBase(path, limit);
    let remaining = limit - used;
    let complete = true;
    for (let depth = 0; base !== null; depth++) {
      if (base === undefined || remaining <= 0 || depth >= MAX_BASE_DEPTH) {
        complete = false;
        break;
      }
      const parent = await this.segment(root, base.id);
      if (parent === null || visited.has(parent)) {
        complete = false;
        break;
      }
      visited.add(parent);
      const meta = await statFile(parent);
      const ancestor = await historyBase(parent, limit);
      if (meta === null || base.end > meta.size || (ancestor !== null && ancestor !== undefined && ancestor.ordinal > base.ordinal)) {
        complete = false;
        break;
      }
      const from = Math.max(0, base.end - remaining);
      let chunk = Buffer.from(await Bun.file(parent).slice(from, base.end).arrayBuffer());
      // A recorded cutoff must end at a row boundary. Partial rows belong to the active append
      // reader; admitting one here would splice unrelated JSON fragments across two segments.
      if (base.end > 0 && chunk.at(-1) !== 0x0a) {
        complete = false;
        break;
      }
      remaining -= chunk.length;
      if (from > 0) {
        const newline = chunk.indexOf(0x0a);
        chunk = newline === -1 ? Buffer.alloc(0) : chunk.subarray(newline + 1);
        complete = false;
      }
      chunks.push(chunk);
      if (from > 0) break;
      base = ancestor;
    }
    return { text: Buffer.concat(chunks.toReversed()).toString("utf8"), complete };
  }

  // Retained prefixes are immutable: only the active file's size/mtime can change this view. The
  // physical active path also stays the key, so a rewind naturally creates a new LiveWindow/gen.
  stat = statFile;

  async load(path: string): ReturnType<TranscriptSource["load"]> {
    const root = await this.rootFor(path);
    if (root === null) throw new Error("Codex rollout is unavailable");
    const current = await loadTail(path);
    if (!current.complete) return current;
    const prefix = await this.retained(path, root, MAX_TRANSCRIPT_BYTES, current.size);
    return { ...current, text: prefix.text + current.text, complete: prefix.complete };
  }

  async readSince(path: string, cursor: Cursor): Promise<ReadSince> {
    const root = await this.rootFor(path);
    if (root === null) return { lines: [], cursor, reset: false, fromStart: false };
    const current = await readSinceFile(path, cursor);
    // Ordinary appends still cost only their new rows. A reset that already clipped the active
    // file cannot reach an ancestor within the byte budget, so it needs no extra read either.
    // A reset still needs a fresh reducer: codexCursor's duplicate counts belong to that window.
    if (!current.reset || !current.fromStart) return current;
    const meta = await statFile(path);
    const prefix = await this.retained(path, root, FIRST_TAIL_BYTES, meta?.size ?? FIRST_TAIL_BYTES);
    const lines = prefix.text === "" ? [] : prefix.text.slice(0, -1).split("\n");
    return { ...current, lines: [...lines, ...current.lines], fromStart: prefix.complete };
  }
}
