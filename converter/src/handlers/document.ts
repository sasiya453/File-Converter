// Document family handlers (PDF, DOC, DOCX, TXT, RTF, ODT ...).
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { soffice } from "../tools/libreoffice.js";
import type { JobContext, JobOutput } from "../types.js";

const out = (path: string, ext: string): JobOutput => ({ path, contentType: mimeFor(ext), filename: `converted.${ext}` });

async function nonEmpty(p: string): Promise<boolean> {
  try { return (await stat(p)).size > 0; } catch { return false; }
}

/**
 * PDF -> DOCX. Primary: pdf2docx (PyMuPDF based, keeps flowing text, tables, images).
 * Fallback: LibreOffice's PDF import (Draw), exported via the Word 2007 filter.
 */
export async function pdfToDocx(ctx: JobContext): Promise<JobOutput> {
  const dest = join(ctx.workDir, "out.docx");
  try {
    await run("pdf2docx", ["convert", ctx.input, dest], { cwd: ctx.workDir, signal: ctx.signal });
    if (await nonEmpty(dest)) return out(dest, "docx");
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    console.warn(JSON.stringify({ evt: "pdf2docx_failed_fallback_lo", msg: String(e).slice(0, 300) }));
  }
  const p = await soffice(ctx.input, ctx.workDir, "docx:MS Word 2007 XML", ctx.signal, ["--infilter=writer_pdf_import"]);
  return out(p, "docx");
}

register("pdf", "docx", pdfToDocx);
