import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertFixture, hasTool } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { FONT_ROWS, FONTCONV } from "../src/handlers/font.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.font.rows;

test("FONT_ROWS equal the matrix rows", () => {
  assert.deepEqual(Object.keys(FONT_ROWS).sort(), Object.keys(rows).sort());
  for (const [src, targets] of Object.entries(FONT_ROWS)) assert.deepEqual(targets, rows[src], src);
});

test("svg font targets do not collide with svg image targets", () => {
  const image: string[] = matrix.sections.image.rows.svg;
  assert.deepEqual(FONT_ROWS.svg!.filter((t) => image.includes(t)), []);
});

/** Glyph names that fontTools sees after unwrapping (works for ttf/otf/woff/woff2). */
function glyphs(path: string): string[] {
  const r = spawnSync("python3", ["-c", "import sys;from fontTools.ttLib import TTFont;print(' '.join(TTFont(sys.argv[1]).getGlyphOrder()))", path]);
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout.toString().trim().split(/\s+/);
}

const CHECKS: Record<string, (p: string, b: Buffer, dir: string) => void> = {
  ttf: (p, b) => { assert.equal(b.readUInt32BE(0), 0x00010000); assert.ok(glyphs(p).includes("H")); },
  otf: (p, b) => { assert.equal(b.subarray(0, 4).toString(), "OTTO"); assert.ok(glyphs(p).includes("H")); },
  woff: (p, b) => { assert.equal(b.subarray(0, 4).toString(), "wOFF"); assert.ok(glyphs(p).includes("H")); },
  woff2: (p, b) => { assert.equal(b.subarray(0, 4).toString(), "wOF2"); assert.ok(glyphs(p).includes("H")); },
  eot: (p, b, dir) => {
    assert.equal(b.readUInt16LE(34), 0x504c, "EOT magic");
    const back = join(dir, "back.ttf");
    assert.equal(spawnSync("python3", [FONTCONV, "unwrap", p, back]).status, 0);
    assert.ok(glyphs(back).includes("H"));
  },
  svg: (_p, b) => { const s = b.toString("utf8"); assert.match(s, /<font[\s>]/); assert.match(s, /<glyph[^>]+unicode="H"/); },
};

const canFonts = hasTool("fontforge") && spawnSync("python3", ["-c", "import fontTools, brotli"]).status === 0;

for (const [src, targets] of Object.entries(FONT_ROWS)) for (const to of targets) {
  test(`${src} -> ${to}`, { skip: !canFonts && "fontforge / fontTools+brotli not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`font.${src}`, to);
    const dir = await mkdtemp(join(tmpdir(), "font-check-"));
    try {
      CHECKS[to]!(out.path, await readFile(out.path), dir);
      assert.equal(out.filename, `converted.${to}`);
    } finally { await cleanup(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("garbage input is a 422", { skip: !canFonts && "font tools not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    for (const from of ["ttf", "woff2", "eot"]) {
      const input = join(dir, `input.${from}`);
      await writeFile(input, "this is not a font at all, just some text padding padding padding padding padding padding");
      await assert.rejects(lookup(from, "woff")!({ input, workDir: dir, from, to: "woff", options: {}, signal: AbortSignal.timeout(30_000) }),
        (e: { status?: number }) => e.status === 422, from);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
