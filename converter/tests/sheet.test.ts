import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool } from "./helpers.js";
import { SHEET_ROWS } from "../src/handlers/sheet.js";
import { mimeFor } from "../src/mime.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.sheet.rows;

test("SHEET_ROWS equal the matrix rows", () => {
  assert.deepEqual(Object.keys(SHEET_ROWS).sort(), Object.keys(rows).sort());
  for (const [src, targets] of Object.entries(SHEET_ROWS)) assert.deepEqual(targets, rows[src], src);
});

const HELLO = /Hello Converter/;
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const unzipText = (p: string, member: string) => spawnSync("unzip", ["-p", p, member]).stdout.toString();
const CHECKS: Record<string, (p: string, b: Buffer) => boolean> = {
  pdf: (p, b) => b.subarray(0, 5).toString() === "%PDF-" && HELLO.test(spawnSync("pdftotext", [p, "-"]).stdout.toString()),
  xls: (_p, b) => b.subarray(0, 8).equals(OLE2) && (b.includes("Hello Converter") || b.includes(Buffer.from("Hello Converter", "utf16le"))),
  xlsx: (p, b) => b.subarray(0, 2).toString() === "PK" && HELLO.test(unzipText(p, "xl/sharedStrings.xml")),
  ods: (p, b) => b.includes("application/vnd.oasis.opendocument.spreadsheet") && HELLO.test(unzipText(p, "content.xml")),
};

for (const [src, targets] of Object.entries(SHEET_ROWS)) for (const to of targets) {
  test(`${src} -> ${to}`, { skip: !hasTool("soffice") && "libreoffice not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      assert.ok(CHECKS[to]!(out.path, await readFile(out.path)), `bad ${to} output`);
      assert.equal(out.filename, `converted.${to}`);
      assert.equal(out.contentType, mimeFor(to));
    } finally { await cleanup(); }
  });
}
