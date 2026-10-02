import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertFixture } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { SUBTITLE_FORMATS, SUBCONV } from "../src/handlers/subtitle.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.subtitle.rows;
const canPy = spawnSync("python3", ["-c", "import pysubs2"]).status === 0;

test("subtitle registry matches the matrix exactly", () => {
  assert.deepEqual([...SUBTITLE_FORMATS].sort(), Object.keys(rows).sort());
  for (const src of SUBTITLE_FORMATS) for (const to of SUBTITLE_FORMATS) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

/** Convert any subtitle file back to SRT with the same helper, then parse cue start times + text. */
async function cues(path: string, fmt: string): Promise<{ start: number; text: string }[]> {
  const dir = await mkdtemp(join(tmpdir(), "sub-check-"));
  try {
    const srt = join(dir, "back.srt");
    const r = fmt === "srt" ? { status: 0 } : spawnSync("python3", [SUBCONV, fmt, "srt", path, srt, "25"]);
    assert.equal(r.status, 0, `re-read ${fmt}`);
    const text = await readFile(fmt === "srt" ? path : srt, "utf8");
    return text.trim().split(/\n\s*\n/).map((b) => {
      const ls = b.split("\n");
      const m = /^(\d+):(\d\d):(\d\d),(\d+)/.exec(ls[1]!)!;
      return { start: ((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1000 + +m[4]!, text: ls.slice(2).join(" ") };
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

for (const src of SUBTITLE_FORMATS) for (const to of rows[src]!) {
  test(`${src} -> ${to}`, { skip: !canPy && "pysubs2 not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      assert.equal(out.filename, `converted.${to}`);
      const got = await cues(out.path, to);
      assert.equal(got.length, 2, "two cues");
      assert.match(got[0]!.text, /Hello Converter/);
      assert.match(got[1]!.text, /Second line ü/);
      // ±50 ms tolerance (frame-based / centisecond formats round)
      assert.ok(Math.abs(got[0]!.start - 1000) <= 50, `start 1 = ${got[0]!.start}`);
      assert.ok(Math.abs(got[1]!.start - 3000) <= 50, `start 2 = ${got[1]!.start}`);
    } finally { await cleanup(); }
  });
}

test("garbage subtitle input is a 422", { skip: !canPy && "pysubs2 not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    for (const from of ["srt", "ttml", "lrc"]) {
      const input = join(dir, `input.${from}`);
      await writeFile(input, "nothing useful here");
      await assert.rejects(lookup(from, "vtt")!({ input, workDir: dir, from, to: "vtt", options: {}, signal: AbortSignal.timeout(30_000) }),
        (e: { status?: number }) => e.status === 422, from);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("TTML with an XML entity declaration is rejected (billion laughs guard)", { skip: !canPy && "pysubs2 not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    const input = join(dir, "input.ttml");
    await writeFile(input, '<?xml version="1.0"?><!DOCTYPE tt [<!ENTITY a "aaaa">]><tt><body><div><p begin="1s" end="2s">&a;</p></div></body></tt>');
    await assert.rejects(lookup("ttml", "srt")!({ input, workDir: dir, from: "ttml", to: "srt", options: {}, signal: AbortSignal.timeout(30_000) }),
      (e: { status?: number }) => e.status === 422);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid fps option is a 400", async () => {
  await assert.rejects(lookup("srt", "sub")!({ input: "/nonexistent", workDir: tmpdir(), from: "srt", to: "sub", options: { fps: "abc" }, signal: AbortSignal.timeout(5_000) }),
    (e: { status?: number }) => e.status === 400);
});
