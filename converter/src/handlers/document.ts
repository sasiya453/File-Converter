// Document family handlers (PDF, DOC, DOCX, TXT, RTF, ODT ...).
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { soffice } from "../tools/libreoffice.js";
import { ebookConvert, zipDir } from "../tools/calibre.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

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

/** PDF -> TXT via poppler's pdftotext (keeps the physical layout). */
export async function pdfToTxt(ctx: JobContext): Promise<JobOutput> {
  const dest = join(ctx.workDir, "out.txt");
  await run("pdftotext", ["-layout", "-enc", "UTF-8", ctx.input, dest], { cwd: ctx.workDir, signal: ctx.signal });
  if (!(await nonEmpty(dest))) throw new HttpError(422, "PDF contains no extractable text (scanned PDF?)");
  return out(dest, "txt");
}

/** PDF -> RTF: PDF -> DOCX (pdf2docx, flowing text) -> RTF with LibreOffice. */
export async function pdfToRtf(ctx: JobContext): Promise<JobOutput> {
  const docx = await pdfToDocx(ctx);
  const p = await soffice(docx.path, ctx.workDir, "rtf:Rich Text Format", ctx.signal);
  return out(p, "rtf");
}

/** Any Calibre-readable input -> e-book format. OEB is a directory, delivered zipped. */
export async function toEbook(ctx: JobContext): Promise<JobOutput> {
  const p = await ebookConvert(ctx.input, ctx.workDir, ctx.to, ctx.signal);
  if (ctx.to === "oeb") return { path: await zipDir(p, ctx.workDir, ctx.signal), contentType: mimeFor("zip"), filename: "converted.oeb.zip" };
  return out(p, ctx.to);
}

export const EBOOK_TARGETS = ["epub", "mobi", "azw3", "lrf", "oeb", "pdb", "fb2", "rb"];

register("pdf", "txt", pdfToTxt);
register("pdf", "rtf", pdfToRtf);
register("pdf", EBOOK_TARGETS, toEbook);
