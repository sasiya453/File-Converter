import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool, textOf } from "./helpers.js";
import { EBOOK_ROWS } from "../src/handlers/ebook.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.ebook.rows;
const canCalibre = hasTool("ebook-convert");

test("EBOOK_ROWS equal the matrix rows", () => {
  for (const [src, targets] of Object.entries(EBOOK_ROWS)) assert.deepEqual(targets, rows[src], src);
});

const HELLO = /Hello Converter/;
const pdfText = (p: string) => spawnSync("pdftotext", [p, "-"]).stdout.toString();

/** Format check per target; text-bearing formats are also checked for the fixture text. */
const CHECKS: Record<string, (p: string, b: Buffer) => boolean> = {
  pdf: (p, b) => b.subarray(0, 5).toString() === "%PDF-" && HELLO.test(pdfText(p)),
  docx: (p, b) => b.subarray(0, 2).toString() === "PK" && HELLO.test(textOf(p)),
  txt: (_p, b) => HELLO.test(b.toString("utf8")),
  rtf: (_p, b) => b.subarray(0, 5).toString() === "{\\rtf" && HELLO.test(b.toString("latin1")),
  epub: (_p, b) => b.subarray(0, 2).toString() === "PK" && b.includes("application/epub+zip"),
  mobi: (_p, b) => b.subarray(60, 68).toString() === "BOOKMOBI",
  azw3: (_p, b) => b.subarray(60, 68).toString() === "BOOKMOBI",
  lrf: (_p, b) => b.subarray(0, 6).equals(Buffer.from("L\0R\0F\0", "latin1")),
  pdb: (_p, b) => b.length > 78,
  fb2: (_p, b) => b.toString("utf8").includes("<FictionBook") && HELLO.test(b.toString("utf8")),
  rb: (_p, b) => b.subarray(0, 4).equals(Buffer.from([0xb0, 0x0c, 0xb0, 0x0c])),
  oeb: (_p, b) => b.subarray(0, 2).toString() === "PK" && b.includes("content.opf"),
};

for (const [src, targets] of Object.entries(EBOOK_ROWS)) for (const to of targets) {
  test(`${src} -> ${to}`, { skip: !canCalibre && "calibre not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      assert.ok(CHECKS[to]!(out.path, await readFile(out.path)), `bad ${to} output`);
      assert.equal(out.filename, to === "oeb" ? "converted.oeb.zip" : `converted.${to}`);
    } finally { await cleanup(); }
  });
}
