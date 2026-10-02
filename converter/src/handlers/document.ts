// Document family handlers (PDF, DOC, DOCX, TXT, RTF, ODT ...).
import { join } from "node:path";
import { stat, copyFile } from "node:fs/promises";
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

/** LibreOffice Writer export filters per target (no quotes: argv, not a shell). */
export const LO_WRITER_FILTERS: Record<string, string> = {
  pdf: "pdf:writer_pdf_Export",
  doc: "doc:MS Word 97",
  docx: "docx:MS Word 2007 XML",
  rtf: "rtf:Rich Text Format",
  odt: "odt:writer8",
  txt: "txt:Text (encoded):UTF8",
};

/** Generic Writer-family conversion with headless LibreOffice (DOC/DOCX/TXT/RTF/ODT sources). */
export async function toLibreOffice(ctx: JobContext): Promise<JobOutput> {
  const filter = LO_WRITER_FILTERS[ctx.to];
  if (!filter) throw new HttpError(400, `no LibreOffice filter for ${ctx.to}`);
  const p = await soffice(ctx.input, ctx.workDir, filter, ctx.signal);
  if (!(await nonEmpty(p))) throw new HttpError(422, "LibreOffice produced an empty file");
  return out(p, ctx.to);
}

// Task 4: DOC row (matrix: PDF, DOCX, TXT, RTF, ODT; all other targets are ✗).
register("doc", ["pdf", "docx", "txt", "rtf", "odt"], toLibreOffice);

// Task 5: DOCX row (matrix: PDF, DOC, TXT, RTF, ODT + all e-book targets; PNG/JPG are ✗).
register("docx", ["pdf", "doc", "txt", "rtf", "odt"], toLibreOffice);
register("docx", EBOOK_TARGETS, toEbook);

/**
 * Task 6: TXT and TEXT rows (matrix: PDF, DOC, DOCX, RTF, ODT + all e-book targets).
 * `.text` is plain text with another extension; LibreOffice and Calibre pick their
 * import filter from the extension, so the input is copied to `.txt` first.
 * LO gets an explicit UTF-8 text import filter (argv, not a shell, so no quotes).
 */
async function asTxt(ctx: JobContext): Promise<JobContext> {
  if (ctx.from !== "text") return ctx;
  const input = join(ctx.workDir, "input-text.txt");
  await copyFile(ctx.input, input);
  return { ...ctx, input };
}

export async function textToLibreOffice(ctx: JobContext): Promise<JobOutput> {
  const c = await asTxt(ctx);
  const filter = LO_WRITER_FILTERS[c.to];
  if (!filter) throw new HttpError(400, `no LibreOffice filter for ${c.to}`);
  const p = await soffice(c.input, c.workDir, filter, c.signal, ["--infilter=Text (encoded):UTF8"]);
  if (!(await nonEmpty(p))) throw new HttpError(422, "LibreOffice produced an empty file");
  return out(p, c.to);
}

export async function textToEbook(ctx: JobContext): Promise<JobOutput> {
  return toEbook(await asTxt(ctx));
}

register(["txt", "text"], ["pdf", "doc", "docx", "rtf", "odt"], textToLibreOffice);
register(["txt", "text"], EBOOK_TARGETS, textToEbook);

// Task 7: RTF row (matrix: PDF, DOC, DOCX, TXT, ODT + all e-book targets).
register("rtf", ["pdf", "doc", "docx", "txt", "odt"], toLibreOffice);
register("rtf", EBOOK_TARGETS, toEbook);

// Task 8: ODT row (matrix: PDF, DOC, DOCX, TXT, RTF + all e-book targets).
register("odt", ["pdf", "doc", "docx", "txt", "rtf"], toLibreOffice);
register("odt", EBOOK_TARGETS, toEbook);
