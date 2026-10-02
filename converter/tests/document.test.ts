import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool, textOf } from "./helpers.js";

const canPdfDocx = hasTool("pdf2docx") || hasTool("soffice");

test("pdf -> docx", { skip: !canPdfDocx && "pdf2docx/soffice not installed" }, async () => {
  const { out, cleanup } = await convertFixture("sample.pdf", "docx");
  try {
    assert.ok((await stat(out.path)).size > 0);
    assert.match(out.contentType, /wordprocessingml/);
    assert.equal(out.filename, "converted.docx");
    assert.match(textOf(out.path), /Hello Converter/);
  } finally { await cleanup(); }
});

const canCalibre = hasTool("ebook-convert");

test("pdf -> txt", { skip: !hasTool("pdftotext") && "pdftotext not installed" }, async () => {
  const { out, cleanup } = await convertFixture("sample.pdf", "txt");
  try {
    assert.match(out.contentType, /text\/plain/);
    assert.match(await readFile(out.path, "utf8"), /Hello Converter/);
  } finally { await cleanup(); }
});

test("pdf -> rtf", { skip: !hasTool("soffice") && "soffice not installed" }, async () => {
  const { out, cleanup } = await convertFixture("sample.pdf", "rtf");
  try {
    const body = await readFile(out.path, "utf8");
    assert.ok(body.startsWith("{\\rtf"));
    assert.match(body, /Hello Converter/);
    assert.equal(out.filename, "converted.rtf");
  } finally { await cleanup(); }
});

// Magic/marker checks per Calibre output format.
const EBOOK_CHECKS: Record<string, (b: Buffer) => boolean> = {
  epub: (b) => b.subarray(0, 2).toString() === "PK" && b.includes("application/epub+zip"),
  mobi: (b) => b.subarray(60, 68).toString() === "BOOKMOBI",
  azw3: (b) => b.subarray(60, 68).toString() === "BOOKMOBI",
  lrf: (b) => b.subarray(0, 6).equals(Buffer.from("L\0R\0F\0", "latin1")),
  pdb: (b) => b.length > 78, // PalmDOC: 78-byte header + records
  fb2: (b) => b.toString("utf8").includes("<FictionBook") && b.toString("utf8").includes("Hello Converter"),
  rb: (b) => b.subarray(0, 4).equals(Buffer.from([0xb0, 0x0c, 0xb0, 0x0c])),
  oeb: (b) => b.subarray(0, 2).toString() === "PK" && b.includes("content.opf"),
};

for (const [to, check] of Object.entries(EBOOK_CHECKS)) {
  test(`pdf -> ${to}`, { skip: !canCalibre && "calibre not installed" }, async () => {
    const { out, cleanup } = await convertFixture("sample.pdf", to);
    try {
      assert.ok(check(await readFile(out.path)), `bad ${to} output`);
      assert.equal(out.filename, to === "oeb" ? "converted.oeb.zip" : `converted.${to}`);
    } finally { await cleanup(); }
  });
}

for (const to of ["png", "jpg"]) {
  test(`pdf -> ${to} (1 page: single image)`, { skip: !hasTool("pdftoppm") && "pdftoppm not installed" }, async () => {
    const { out, cleanup } = await convertFixture("sample.pdf", to);
    try {
      const b = await readFile(out.path);
      if (to === "png") assert.equal(b.subarray(1, 4).toString(), "PNG");
      else assert.deepEqual([...b.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      assert.equal(out.filename, `converted.${to}`);
    } finally { await cleanup(); }
  });
  test(`pdf -> ${to} (2 pages: zip)`, { skip: !hasTool("pdftoppm") && "pdftoppm not installed" }, async () => {
    const { out, cleanup } = await convertFixture("sample-2p.pdf", to);
    try {
      assert.equal(out.contentType, "application/zip");
      assert.equal(out.filename, "converted.zip");
      const list = spawnSync("unzip", ["-Z1", out.path]).stdout.toString().trim().split("\n").sort();
      assert.deepEqual(list, [`page-1.${to}`, `page-2.${to}`]);
    } finally { await cleanup(); }
  });
}
