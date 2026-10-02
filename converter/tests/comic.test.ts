import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertFixture, hasTool, textOf, FIXTURES } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { checkListing, naturalCompare, MAX_ENTRIES } from "../src/handlers/comic.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.ebook.rows;
const ALL = ["pdf", "docx", "txt", "rtf", "epub", "mobi", "azw3", "lrf", "oeb", "pdb", "fb2", "rb"];

test("cbz/cbr/djvu registry matches the matrix exactly", () => {
  for (const src of ["cbz", "cbr", "djvu"]) for (const to of ALL) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

test("naturalCompare sorts page numbers numerically", () => {
  assert.deepEqual(["p10.png", "p2.png", "p1.png"].sort(naturalCompare), ["p1.png", "p2.png", "p10.png"]);
});

test("checkListing rejects traversal, absolute paths and too many entries", () => {
  const entry = (p: string) => `Path = ${p}\nSize = 10\n`;
  assert.doesNotThrow(() => checkListing([entry("a/1.png"), entry("2.png")].join("\n")));
  for (const bad of ["../x.png", "a/../../x.png", "/etc/x.png", "C:\\x.png", "a\\..\\x.png"]) {
    assert.throws(() => checkListing(entry(bad)), /unsafe path/, bad);
  }
  assert.throws(() => checkListing(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => entry(`${i}.png`)).join("\n")), /entries/);
  assert.throws(() => checkListing("Path = big.png\nSize = 999999999999\n"), /too large/);
});

const pdfPages = (p: string) => Number(/Pages:\s+(\d+)/.exec(spawnSync("pdfinfo", [p]).stdout.toString())?.[1]);
const can7z = hasTool("7z");

for (const src of ["cbz", "cbr"]) {
  test(`${src} -> pdf (3 pages in natural order)`, { skip: !can7z && "7z not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, "pdf");
    try {
      assert.equal((await readFile(out.path)).subarray(0, 5).toString(), "%PDF-");
      assert.equal(pdfPages(out.path), 3);
      // page order: p1 (red), p2 (green), p10 (blue)
      const colors = [1, 2, 3].map((n) => {
        const r = spawnSync("pdftoppm", ["-f", String(n), "-l", String(n), "-r", "10", "-png", out.path]).stdout;
        const px = spawnSync("convert", ["png:-", "-format", "%[pixel:p{1,1}]", "info:"], { input: r }).stdout.toString();
        return px;
      });
      assert.match(colors[0]!, /red|255,0,0/);
      assert.match(colors[1]!, /green|lime|0,128,0|0,255,0/);
      assert.match(colors[2]!, /blue|0,0,255/);
    } finally { await cleanup(); }
  });
}

test("zip-slip archive is rejected with 422", { skip: !can7z && "7z not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    const input = join(dir, "input.cbz");
    await copyFile(join(FIXTURES, "evil.cbz"), input);
    await assert.rejects(lookup("cbz", "pdf")!({ input, workDir: dir, from: "cbz", to: "pdf", options: {}, signal: AbortSignal.timeout(30_000) }),
      (e: { status?: number; message: string }) => e.status === 422 && /unsafe/.test(e.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- DJVU ----
const canDjvu = hasTool("ddjvu") && hasTool("djvutxt");
const HELLO = /Hello Converter/;
const CHECKS: Record<string, (p: string, b: Buffer) => boolean> = {
  pdf: (_p, b) => b.subarray(0, 5).toString() === "%PDF-",
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

for (const to of rows.djvu!) {
  const needsCalibre = !["pdf", "txt"].includes(to);
  test(`djvu -> ${to}`, { skip: (!canDjvu || (needsCalibre && !hasTool("ebook-convert"))) && "djvulibre/calibre not installed" }, async () => {
    const { out, cleanup } = await convertFixture("sample.djvu", to);
    try {
      assert.ok(CHECKS[to]!(out.path, await readFile(out.path)), `bad ${to} output`);
      assert.equal(out.filename, to === "oeb" ? "converted.oeb.zip" : `converted.${to}`);
    } finally { await cleanup(); }
  });
}

test("scanned djvu (no text layer) -> txt falls back to OCR", { skip: (!canDjvu || !hasTool("tesseract")) && "djvulibre/tesseract not installed" }, async () => {
  const { out, cleanup } = await convertFixture("notext.djvu", "txt");
  try { assert.match(await readFile(out.path, "utf8"), HELLO); } finally { await cleanup(); }
});

test("djvu with no text at all -> txt is a 422", { skip: (!canDjvu || !hasTool("tesseract")) && "djvulibre/tesseract not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    const input = join(dir, "input.djvu");
    await copyFile(join(FIXTURES, "blank.djvu"), input);
    await assert.rejects(lookup("djvu", "txt")!({ input, workDir: dir, from: "djvu", to: "txt", options: {}, signal: AbortSignal.timeout(60_000) }),
      (e: { status?: number }) => e.status === 422);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
