import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexTranscriptSource, parseCodexTranscript } from "./codex.ts";
import { NO_CURSOR } from "./cursor.ts";
import { FIRST_TAIL_BYTES, MAX_TRANSCRIPT_BYTES } from "./files.ts";

const PARENT = "11111111-aaaa-bbbb-cccc-222222222222";
const FIRST = "33333333-aaaa-bbbb-cccc-444444444444";
const FORK = "55555555-aaaa-bbbb-cccc-666666666666";
const LAST = "77777777-aaaa-bbbb-cccc-888888888888";
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

interface Base {
  thread_id: string;
  end_byte_offset: number;
  end_ordinal_exclusive: number;
}

function header(id: string, base?: Base, instructions = ""): string {
  return JSON.stringify({
    type: "session_meta",
    payload: { id, history_mode: "paginated", history_base: base, base_instructions: { text: instructions } },
  }) + "\n";
}

function message(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  }) + "\n";
}

function cutoff(id: string, text: string, inherited = 0): Base {
  return {
    thread_id: id,
    end_byte_offset: Buffer.byteLength(text),
    end_ordinal_exclusive: inherited + text.split("\n").length - 1,
  };
}

function words(text: string): string[] {
  return parseCodexTranscript(text).flatMap((entry) =>
    entry.parts.flatMap((part) => part.kind === "text" ? [part.text] : []),
  );
}

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "collie-codex-retained-")));
  homes.push(home);
  const root = join(home, "sessions");
  const dir = join(root, "2026", "10", "19");
  await mkdir(dir, { recursive: true });
  const pathFor = (id: string) => join(dir, "rollout-2026-10-19T12-00-00-" + id + ".jsonl");
  const write = async (id: string, text: string) => {
    const path = pathFor(id);
    await Bun.write(path, text);
    return path;
  };
  return { root, pathFor, write };
}

describe("retained Codex history across forks and large headers", () => {
  test.each(["session", "segment"] as const)("a rewound fork retains its parent's %s", async (parentKind) => {
    const f = await fixture();
    const original = header(PARENT) + message("parent context");
    await f.write(PARENT, original + message("discarded parent turn"));
    let base = cutoff(PARENT, original);
    const expected = ["parent context"];
    if (parentKind === "segment") {
      const segment = header(PARENT, base) + message("retained parent branch");
      await f.write(PARENT + "_" + FIRST, segment + message("discarded parent branch"));
      base = cutoff(FIRST, segment, base.end_ordinal_exclusive);
      expected.push("retained parent branch");
    }
    const fork = header(FORK, base) + message("retained fork turn");
    await f.write(FORK, fork + message("discarded fork turn"));
    const active = await f.write(FORK + "_" + LAST,
      header(FORK, cutoff(FORK, fork, base.end_ordinal_exclusive)) + message("current"));
    expected.push("retained fork turn", "current");

    const source = new CodexTranscriptSource(f.root);
    expect(await source.resolve({ kind: "id", value: FORK })).toBe(active);
    const history = await source.load(active);
    expect(words(history.text)).toEqual(expected);
    expect(history.complete).toBe(true);
    const live = await source.readSince(active, NO_CURSOR);
    expect(words(live.lines.join("\n"))).toEqual(expected);
    expect(live.fromStart).toBe(true);
  });

  test.each([300 * 1024, FIRST_TAIL_BYTES + 1])("headers with %d instruction bytes keep history within each read budget", async (bytes) => {
    const f = await fixture();
    const instructions = "x".repeat(bytes);
    const original = header(PARENT, undefined, instructions) + message("original");
    await f.write(PARENT, original + message("discarded original"));
    const base = cutoff(PARENT, original);
    const branch = header(PARENT, base, instructions) + message("first branch");
    await f.write(PARENT + "_" + FIRST, branch + message("discarded branch"));
    const active = await f.write(PARENT + "_" + LAST,
      header(PARENT, cutoff(FIRST, branch, base.end_ordinal_exclusive), instructions) + message("current"));
    const source = new CodexTranscriptSource(f.root);

    const history = await source.load(active);
    expect(words(history.text)).toEqual(["original", "first branch", "current"]);
    expect(history.complete).toBe(true);
    expect(Buffer.byteLength(history.text)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    const live = await source.readSince(active, NO_CURSOR);
    expect(words(live.lines.join("\n"))).toEqual(
      bytes < FIRST_TAIL_BYTES ? ["original", "first branch", "current"] : ["current"],
    );
    expect(live.fromStart).toBe(bytes < FIRST_TAIL_BYTES);
    expect(Buffer.byteLength(live.lines.join("\n"))).toBeLessThanOrEqual(FIRST_TAIL_BYTES);
  });

  test("a live read clips the oldest context when the combined retained files exceed its budget", async () => {
    const f = await fixture();
    const original = header(PARENT) + message("oldest");
    await f.write(PARENT, original);
    const base = cutoff(PARENT, original);
    const padding = "x".repeat(FIRST_TAIL_BYTES * 3 / 4);
    const branch = header(PARENT, base, padding) + message("retained tail");
    await f.write(PARENT + "_" + FIRST, branch);
    const active = await f.write(PARENT + "_" + LAST,
      header(PARENT, cutoff(FIRST, branch, base.end_ordinal_exclusive), padding) + message("current"));
    const source = new CodexTranscriptSource(f.root);
    const live = await source.readSince(active, NO_CURSOR);
    expect(words(live.lines.join("\n"))).toEqual(["retained tail", "current"]);
    expect(live.fromStart).toBe(false);
    expect(Buffer.byteLength(live.lines.join("\n"))).toBeLessThanOrEqual(FIRST_TAIL_BYTES);
    const history = await source.load(active);
    expect(words(history.text)).toEqual(["oldest", "retained tail", "current"]);
    expect(history.complete).toBe(true);
  });

  test("following a parent from another session still refuses a symlink outside the root", async () => {
    const f = await fixture();
    const other = await fixture();
    const parent = header(PARENT) + message("outside");
    const outside = await other.write(PARENT, parent);
    await symlink(outside, f.pathFor(PARENT));
    const active = await f.write(FORK, header(FORK, cutoff(PARENT, parent)) + message("current"));
    const history = await new CodexTranscriptSource(f.root).load(active);
    expect(words(history.text)).toEqual(["current"]);
    expect(history.complete).toBe(false);
  });
});
