import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
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
