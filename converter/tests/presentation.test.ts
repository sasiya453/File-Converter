import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool } from "./helpers.js";
import { PRESENTATION_ROWS } from "../src/handlers/presentation.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.presentation.rows;

test("PRESENTATION_ROWS equal the matrix rows", () => {
  assert.deepEqual(Object.keys(PRESENTATION_ROWS).sort(), Object.keys(rows).sort());
  for (const [src, targets] of Object.entries(PRESENTATION_ROWS)) assert.deepEqual(targets, rows[src], src);
});

const HELLO = /Hello Converter/;
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** Format check + "Hello Converter" text check per target. */
const CHECKS: Record<string, (p: string, b: Buffer) => boolean> = {
  pdf: (p, b) => b.subarray(0, 5).toString() === "%PDF-" && HELLO.test(spawnSync("pdftotext", [p, "-"]).stdout.toString()),
  ppt: (_p, b) => b.subarray(0, 8).equals(OLE2) && b.includes(Buffer.from("Hello Converter", "utf16le")),
  pps: (_p, b) => b.subarray(0, 8).equals(OLE2) && b.includes(Buffer.from("Hello Converter", "utf16le")),
  pot: (_p, b) => b.subarray(0, 8).equals(OLE2) && b.includes(Buffer.from("Hello Converter", "utf16le")),
  pptx: (p, b) => b.subarray(0, 2).toString() === "PK" && HELLO.test(spawnSync("unzip", ["-p", p, "ppt/slides/slide1.xml"]).stdout.toString()),
  odp: (p, b) => b.includes("application/vnd.oasis.opendocument.presentation") && HELLO.test(spawnSync("unzip", ["-p", p, "content.xml"]).stdout.toString()),
};

for (const [src, targets] of Object.entries(PRESENTATION_ROWS)) for (const to of targets) {
  test(`${src} -> ${to}`, { skip: !hasTool("soffice") && "libreoffice not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      assert.ok(CHECKS[to]!(out.path, await readFile(out.path)), `bad ${to} output`);
      assert.equal(out.filename, `converted.${to}`);
    } finally { await cleanup(); }
  });
}
