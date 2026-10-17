import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexJournal, CodexTranscriptSource, parseCodexTranscript } from "./codex.ts";
import { NO_CURSOR } from "./cursor.ts";
import { FIRST_TAIL_BYTES, MAX_TRANSCRIPT_BYTES } from "./files.ts";
import { LiveWindows, TICK_FLOOR_MS } from "./live.ts";
import { TranscriptStore } from "./store.ts";
import type { TranscriptEntry } from "./types.ts";

// Codex 0.163 keeps the public session id on a rewind, switches threads.rollout_path, and writes
// only the new branch. history_base names a historical segment, NOT the current session pointer.
// These are synthetic logs with the same shape as the on-disk 2026-10-17 hi -> hello reproduction.
const SESSION = "11111111-aaaa-bbbb-cccc-222222222222";
const BRANCH = "33333333-dddd-eeee-ffff-444444444444";
const NEXT = "55555555-aaaa-bbbb-cccc-666666666666";
const ref = { kind: "id" as const, value: SESSION };

interface HistoryBase {
  thread_id: string;
  end_ordinal_exclusive: number;
  end_byte_offset: number;
}

function header(base?: HistoryBase, instructions?: string): string {
  return `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: SESSION,
      history_mode: "paginated",
      history_base: base,
      base_instructions: instructions === undefined ? undefined : { text: instructions },
    },
  })}\n`;
}

function message(role: "user" | "assistant", text: string): string {
  return `${JSON.stringify({
    timestamp: "2026-10-17T07:29:01.364Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "text", text }] },
  })}\n`;
}

function cutoff(threadId: string, prefix: string, inherited = 0): HistoryBase {
  return {
    thread_id: threadId,
    end_ordinal_exclusive: inherited + prefix.split("\n").length - 1,
    end_byte_offset: Buffer.byteLength(prefix),
  };
}

function words(entries: readonly TranscriptEntry[]): string[] {
  return entries.flatMap((e) => e.parts.flatMap((p) => p.kind === "text" ? [p.text] : []));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "collie-codex-rewind-")));
  const root = join(home, "sessions");
  const dir = join(root, "2026", "10", "17");
  await mkdir(dir, { recursive: true });
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  cleanups.push(async () => {
    db.close();
    await rm(home, { recursive: true, force: true });
  });
  const pointTo = (path: string) => {
    db.query("INSERT OR REPLACE INTO threads (id, rollout_path) VALUES (?, ?)").run(SESSION, path);
  };
  const write = async (id: string, text: string) => {
    const path = join(dir, `rollout-2026-10-17T15-28-33-${id}.jsonl`);
    await Bun.write(path, text);
    return path;
  };
  return { home, root, dir, db, pointTo, write };
}

describe("Codex rewind history", () => {
  test("follows the active pointer after a cached log is rewound, including a WAL-only update", async () => {
    const f = await fixture();
    const old = await f.write(SESSION, header() + message("user", "hi"));
    f.pointTo(old);
    const source = new CodexTranscriptSource(f.root);
    expect(await source.resolve(ref)).toBe(old);
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = await stat(join(f.home, "state_5.sqlite"));

    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, header())) + message("user", "hello"));
    f.pointTo(branch);
    const after = await stat(join(f.home, "state_5.sqlite"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(await source.resolve(ref)).toBe(branch);
    expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBe(branch);
  });

  test("an unavailable index never reopens an abandoned log, and recovery keeps the live generation", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "retained");
    const old = await f.write(SESSION, prefix + message("user", "discarded"));
    const adapter = codexJournal(f.root);
    expect(await adapter.source.resolve(ref)).toBe(old); // cache the legacy lookup before indexing
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + message("user", "current"));
    f.pointTo(branch);
    let now = 0;
    const windows = new LiveWindows(new TranscriptStore(), () => now);
    const before = await windows.window(adapter, ref, { limit: 100 });
    expect(words(before!.upserts)).toEqual(["retained", "current"]);

    // Codex startup can return SQLITE_BUSY_RECOVERY. An exclusive lock makes that unavailable
    // index path deterministic here; ordinary WAL writes do not block readers.
    f.db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    try {
      expect(await adapter.source.resolve(ref)).toBeNull();
      expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBeNull();
      now += TICK_FLOOR_MS;
      expect(await windows.window(adapter, ref, { limit: 100 })).toBeNull();
    } finally {
      f.db.exec("ROLLBACK; PRAGMA locking_mode = NORMAL; SELECT * FROM threads");
    }

    expect(await adapter.source.resolve(ref)).toBe(branch);
    now += TICK_FLOOR_MS;
    const after = await windows.window(adapter, ref, { limit: 100 });
    expect(after!.gen).toBe(before!.gen);
    expect(words(after!.upserts)).toEqual(["retained", "current"]);
  });

  test("History keeps the retained prefix and drops the rewound turn", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "earlier discussion") + message("assistant", "earlier reply");
    await f.write(SESSION, prefix + message("user", "hi") + message("assistant", "old reply"));
    const branch = await f.write(`${SESSION}_${BRANCH}`,
      header(cutoff(SESSION, prefix)) + message("user", "hello") + message("assistant", "new reply"));
    f.pointTo(branch);
    const adapter = codexJournal(f.root);
    const page = await new TranscriptStore().page(adapter, ref, { limit: 100 });
    expect(page).not.toBeNull();
    expect(words(page!.entries)).toEqual(["earlier discussion", "earlier reply", "hello", "new reply"]);
    expect(page!.fileTruncated).toBe(false);
  });

  test("a rewind replaces the live generation and subsequent appends stay incremental", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "earlier discussion");
    const old = await f.write(SESSION, prefix + message("user", "hi"));
    f.pointTo(old);
    const adapter = codexJournal(f.root);
    const store = new TranscriptStore();
    let now = 0;
    const windows = new LiveWindows(store, () => now);
    const before = await windows.window(adapter, ref, { limit: 100 });
    expect(words(before!.upserts)).toEqual(["earlier discussion", "hi"]);

    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + message("user", "hello"));
    f.pointTo(branch);
    now += TICK_FLOOR_MS;
    const after = await windows.window(adapter, ref, { limit: 100, after: { gen: before!.gen, rev: before!.rev } });
    expect(after!.gen).not.toBe(before!.gen);
    expect(words(after!.upserts)).toEqual(["earlier discussion", "hello"]);
    expect(after!.lastPrompt?.text).toBe("hello");
    expect(after!.hasOlder).toBe(false);

    const firstRead = await adapter.source.readSince(branch, NO_CURSOR);
    await appendFile(branch, message("assistant", "new reply"));
    const appended = await adapter.source.readSince(branch, firstRead.cursor);
    expect(appended.reset).toBe(false);
    expect(words(parseCodexTranscript(appended.lines.join("\n")))).toEqual(["new reply"]);
    now += TICK_FLOOR_MS;
    const next = await windows.window(adapter, ref, { limit: 100, after: { gen: after!.gen, rev: after!.rev } });
    expect(next!.gen).toBe(after!.gen);
    expect(words(next!.upserts)).toEqual(["new reply"]);
  });

  test("a second rewind follows the previous segment id and pages through the same history", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "original") + message("assistant", "original reply");
    await f.write(SESSION, prefix + message("user", "discarded first"));
    const firstBase = cutoff(SESSION, prefix);
    const branchPrefix = header(firstBase) + message("user", "kept on first branch");
    await f.write(`${SESSION}_${BRANCH}`, branchPrefix + message("user", "discarded second"));
    const next = await f.write(`${SESSION}_${NEXT}`,
      header(cutoff(BRANCH, branchPrefix, firstBase.end_ordinal_exclusive)) + message("user", "newest"));
    f.pointTo(next);
    const adapter = codexJournal(f.root);
    const store = new TranscriptStore();
    const page = await store.page(adapter, ref, { limit: 2 });
    expect(words(page!.entries)).toEqual(["kept on first branch", "newest"]);
    expect(page!.hasMore).toBe(true);
    const older = await store.page(adapter, ref, { limit: 2, before: page!.entries[0]!.uuid });
    expect(words(older!.entries)).toEqual(["original", "original reply"]);
    expect(older!.hasMore).toBe(false);
    const read = await adapter.source.readSince(next, NO_CURSOR);
    expect(words(parseCodexTranscript(read.lines.join("\n"))))
      .toEqual(["original", "original reply", "kept on first branch", "newest"]);
    expect(read.fromStart).toBe(true);
  });

  test.each([80 * 1024, FIRST_TAIL_BYTES + 1])("large session headers (%d instruction bytes) preserve history within each view's budget", async (bytes) => {
    const f = await fixture();
    const instructions = "x".repeat(bytes);
    const prefix = header(undefined, instructions) + message("user", "original");
    await f.write(SESSION, prefix + message("user", "discarded first"));
    const firstBase = cutoff(SESSION, prefix);
    const branchPrefix = header(firstBase, instructions) + message("user", "first branch");
    await f.write(`${SESSION}_${BRANCH}`, branchPrefix + message("user", "discarded second"));
    const next = await f.write(`${SESSION}_${NEXT}`,
      header(cutoff(BRANCH, branchPrefix, firstBase.end_ordinal_exclusive), instructions) + message("user", "current"));
    f.pointTo(next);
    const adapter = codexJournal(f.root);
    const page = await new TranscriptStore().page(adapter, ref, { limit: 100 });
    expect(words(page!.entries)).toEqual(["original", "first branch", "current"]);
    expect(page!.fileTruncated).toBe(false);

    const live = await adapter.source.readSince(next, NO_CURSOR);
    expect(words(parseCodexTranscript(live.lines.join("\n"))))
      .toEqual(bytes < FIRST_TAIL_BYTES ? ["original", "first branch", "current"] : ["current"]);
    expect(live.fromStart).toBe(bytes < FIRST_TAIL_BYTES);
  });

  test("an indexed rewind wins over a cached legacy filename", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "original");
    const old = await f.write(SESSION, prefix + message("user", "hi"));
    const source = new CodexTranscriptSource(f.root);
    expect(await source.resolve(ref)).toBe(old); // no index row yet: caches the legacy lookup
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + message("user", "hello"));
    f.pointTo(branch);
    expect(await source.resolve(ref)).toBe(branch);
  });

  test("UTF-8 cutoffs and row identities agree between History and the live read", async () => {
    const f = await fixture();
    // JSON permits whitespace after the object. It is part of Codex's content-derived cursor.
    const prefix = header() + message("user", "中文 🦮").slice(0, -1) + "  \n";
    await f.write(SESSION, prefix + message("user", "discarded"));
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + message("user", "new"));
    f.pointTo(branch);
    const source = new CodexTranscriptSource(f.root);
    const history = parseCodexTranscript((await source.load(branch)).text);
    const live = parseCodexTranscript((await source.readSince(branch, NO_CURSOR)).lines.join("\n"));
    expect(words(history)).toEqual(["中文 🦮", "new"]);
    expect(live).toEqual(history);
  });

  test("an unfinished active row is delivered once after an inherited prefix", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "kept");
    await f.write(SESSION, prefix);
    const text = message("assistant", "new reply");
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + text.slice(0, -3));
    const source = new CodexTranscriptSource(f.root);
    const first = await source.readSince(branch, NO_CURSOR);
    expect(words(parseCodexTranscript(first.lines.join("\n")))).toEqual(["kept"]);
    await appendFile(branch, text.slice(-3));
    const second = await source.readSince(branch, first.cursor);
    expect(second.reset).toBe(false);
    expect(words(parseCodexTranscript(second.lines.join("\n")))).toEqual(["new reply"]);
    expect((await source.readSince(branch, second.cursor)).lines).toEqual([]);
  });

  test("a tool result on the new branch folds onto its inherited call", async () => {
    const f = await fixture();
    const call = `${JSON.stringify({ type: "response_item", payload: {
      type: "function_call", name: "shell", arguments: "{}", call_id: "kept-call",
    } })}\n`;
    const prefix = header() + call;
    await f.write(SESSION, prefix);
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)));
    f.pointTo(branch);
    let now = 0;
    const adapter = codexJournal(f.root);
    const windows = new LiveWindows(new TranscriptStore(), () => now);
    const first = await windows.window(adapter, ref, { limit: 100 });
    await appendFile(branch, `${JSON.stringify({ type: "response_item", payload: {
      type: "function_call_output", call_id: "kept-call", output: "done",
    } })}\n`);
    now += TICK_FLOOR_MS;
    const second = await windows.window(adapter, ref, { limit: 100, after: { gen: first!.gen, rev: first!.rev } });
    expect(second!.upserts).toHaveLength(1);
    expect(second!.upserts[0]!.uuid).toBe(first!.upserts[0]!.uuid);
    expect(second!.upserts[0]!.parts[0]).toMatchObject({ kind: "tool", result: { text: "done" } });
  });

  test.each([FIRST_TAIL_BYTES, MAX_TRANSCRIPT_BYTES])("the %d-byte budget covers the chain as a whole", async (budget) => {
    const f = await fixture();
    const padding = (bytes: number) => `${JSON.stringify({ type: "world_state", payload: "x".repeat(bytes) })}\n`;
    const prefix = header() + message("user", "outside the window") + padding(budget * 3 / 4) + message("user", "retained tail");
    await f.write(SESSION, prefix + message("user", "discarded"));
    const branch = await f.write(`${SESSION}_${BRANCH}`,
      header(cutoff(SESSION, prefix)) + padding(budget / 2) + message("user", "current"));
    const source = new CodexTranscriptSource(f.root);
    if (budget === FIRST_TAIL_BYTES) {
      const read = await source.readSince(branch, NO_CURSOR);
      expect(read.fromStart).toBe(false);
      expect(Buffer.byteLength(read.lines.join("\n"))).toBeLessThanOrEqual(budget);
      expect(words(parseCodexTranscript(read.lines.join("\n")))).toEqual(["retained tail", "current"]);
    } else {
      const read = await source.load(branch);
      expect(read.complete).toBe(false);
      expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(budget);
      expect(words(parseCodexTranscript(read.text))).toEqual(["retained tail", "current"]);
    }
  });

  test("a rewind to the beginning has no inherited turns", async () => {
    const f = await fixture();
    await f.write(SESSION, header() + message("user", "discarded"));
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, "")) + message("user", "new start"));
    const source = new CodexTranscriptSource(f.root);
    const read = await source.readSince(branch, NO_CURSOR);
    expect(read.fromStart).toBe(true);
    expect(words(parseCodexTranscript(read.lines.join("\n")))).toEqual(["new start"]);
  });
});

describe("Codex source bounds", () => {
  test("an active path outside its root cannot fall back to the abandoned log", async () => {
    const f = await fixture();
    await f.write(SESSION, header() + message("user", "old"));
    const outside = join(f.home, "outside.jsonl");
    await Bun.write(outside, message("user", "outside"));
    f.pointTo(outside);
    expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBeNull();
    const link = join(f.dir, "outside-link.jsonl");
    await symlink(outside, link);
    f.pointTo(link);
    expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBeNull();
  });

  test("a missing active log cannot fall back to the abandoned log", async () => {
    const f = await fixture();
    await f.write(SESSION, header() + message("user", "old"));
    f.pointTo(join(f.dir, "not-yet-written.jsonl"));
    expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBeNull();
  });

  test("a state database linked out of its home is not read", async () => {
    const f = await fixture();
    const other = await fixture();
    const old = await f.write(SESSION, header() + message("user", "old"));
    const branch = await f.write(`${SESSION}_${BRANCH}`, header() + message("user", "new"));
    other.pointTo(branch);
    await symlink(join(other.home, "state_5.sqlite"), join(f.home, "state_99.sqlite"));
    expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBe(old);
  });

  test("an older unsupported index retains the legacy file lookup", async () => {
    const f = await fixture();
    f.db.exec("DROP TABLE threads; CREATE TABLE threads (id TEXT PRIMARY KEY)");
    const old = await f.write(SESSION, header() + message("user", "old"));
    expect(await new CodexTranscriptSource(f.root).resolve(ref)).toBe(old);
  });

  test("ancestor lookups stay within the root that owns the active file", async () => {
    const f = await fixture();
    const other = await fixture();
    const prefix = header() + message("user", "another home");
    await other.write(SESSION, prefix);
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + message("user", "current"));
    const source = new CodexTranscriptSource([f.root, other.root]);
    const read = await source.load(branch);
    expect(words(parseCodexTranscript(read.text))).toEqual(["current"]);
    expect(read.complete).toBe(false);
  });

  test("an ancestor symlink cannot escape the sessions root", async () => {
    const f = await fixture();
    const prefix = header() + message("user", "outside");
    const outside = join(f.home, "outside.jsonl");
    await Bun.write(outside, prefix);
    await symlink(outside, join(f.dir, `rollout-parent-${SESSION}.jsonl`));
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(cutoff(SESSION, prefix)) + message("user", "current"));
    const read = await new CodexTranscriptSource(f.root).load(branch);
    expect(words(parseCodexTranscript(read.text))).toEqual(["current"]);
    expect(read.complete).toBe(false);
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER, 3])("an invalid ancestor byte cutoff %d yields a partial history", async (end) => {
    const f = await fixture();
    const prefix = header() + message("user", "ancestor");
    await f.write(SESSION, prefix);
    const base = cutoff(SESSION, prefix);
    base.end_byte_offset = end;
    const branch = await f.write(`${SESSION}_${BRANCH}`, header(base) + message("user", "current"));
    const read = await new CodexTranscriptSource(f.root).load(branch);
    expect(words(parseCodexTranscript(read.text))).toEqual(["current"]);
    expect(read.complete).toBe(false);
  });

  test("cyclic ancestry stops without repeating the same log", async () => {
    const f = await fixture();
    const path = await f.write(SESSION, header({ thread_id: SESSION, end_byte_offset: 1, end_ordinal_exclusive: 1 }) + message("user", "current"));
    const read = await new CodexTranscriptSource(f.root).load(path);
    expect(words(parseCodexTranscript(read.text))).toEqual(["current"]);
    expect(read.complete).toBe(false);
  });
});
