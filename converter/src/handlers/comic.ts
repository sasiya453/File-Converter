// Task 19: comic archives (CBZ = zip, CBR = rar) -> PDF, and DJVU -> PDF / text / e-book.
import { join, extname } from "node:path";
import { readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { magick } from "../tools/imagemagick.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";
import { toEbook, EBOOK_TARGETS } from "./document.js";

export const MAX_ENTRIES = 1000;
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);

/**
 * Check the archive listing before extracting anything: no absolute paths, no `..`
 * components (zip-slip), at most MAX_ENTRIES entries and MAX_UNPACKED_BYTES in total
 * (zip bomb guard). `7z l -slt` prints one "Path = …" / "Size = …" block per entry.
 */
export function checkListing(slt: string): void {
  const blocks = slt.split(/\r?\n\r?\n/).filter((b) => /^Path = /m.test(b) && /^Size = /m.test(b));
  if (blocks.length > MAX_ENTRIES) throw new HttpError(422, `archive has more than ${MAX_ENTRIES} entries`);
  let total = 0;
  for (const b of blocks) {
    const path = /^Path = (.*)$/m.exec(b)![1]!;
    if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
      throw new HttpError(422, "archive contains an unsafe path");
    }
    total += Number(/^Size = (\d*)$/m.exec(b)?.[1] || 0);
    if (total > MAX_UNPACKED_BYTES) throw new HttpError(422, "archive is too large when unpacked");
  }
}

/** Natural sort ("page2" < "page10"). */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** Recursively collect regular image files (symlinks are ignored). */
async function images(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const st = await lstat(join(dir, r));
    if (st.isDirectory()) { if (!name.startsWith("__MACOSX")) found.push(...await images(dir, r)); }
    else if (st.isFile() && !name.startsWith(".") && IMAGE_EXT.has(extname(name).toLowerCase())) found.push(r);
  }
  return found;
}

/** Extract a CBZ/CBR with 7z (handles zip, RAR4 and RAR5) into workDir/pages; returns sorted image paths. */
export async function extractComic(ctx: JobContext): Promise<string[]> {
  const opts = { cwd: ctx.workDir, signal: ctx.signal };
  let listing: string;
  try { listing = (await run("7z", ["l", "-slt", "-p", "--", ctx.input], opts)).stdout; }
  catch { throw new HttpError(422, "not a valid comic archive (or it is password protected)"); }
  checkListing(listing);
  const dest = join(ctx.workDir, "pages");
  await mkdir(dest);
  await run("7z", ["x", "-y", "-p", "-snl-", `-o${dest}`, "--", ctx.input], opts);
  const pages = (await images(dest)).sort(naturalCompare).map((r) => join(dest, r));
  if (pages.length === 0) throw new HttpError(422, "the archive contains no images");
  return pages;
}

/** Images -> one PDF page each. img2pdf is lossless; ImageMagick handles what img2pdf rejects (e.g. alpha). */
export async function comicToPdf(ctx: JobContext): Promise<JobOutput> {
  const pages = await extractComic(ctx);
  const out = join(ctx.workDir, "converted.pdf");
  try {
    await run("img2pdf", ["-o", out, "--", ...pages], { cwd: ctx.workDir, signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    await magick([...pages, "-background", "white", "-alpha", "remove", "-alpha", "off", "-compress", "jpeg", "-quality", "92",
      `PDF:${out}`], ctx.workDir, ctx.signal);
  }
  return { path: out, contentType: mimeFor("pdf"), filename: "converted.pdf" };
}

register(["cbz", "cbr"], "pdf", comicToPdf);

// ---- DJVU ----
export async function djvuToPdf(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.pdf");
  await run("ddjvu", ["-format=pdf", "-quality=85", ctx.input, out], { cwd: ctx.workDir, signal: ctx.signal });
  return { path: out, contentType: mimeFor("pdf"), filename: "converted.pdf" };
}

export const DJVU_OCR_MAX_PAGES = 50;

/**
 * Text of the DJVU: its hidden text layer, or (scanned DJVU without one) Tesseract OCR
 * of the first DJVU_OCR_MAX_PAGES pages. 422 if there is still no text.
 */
async function djvuText(ctx: JobContext): Promise<string> {
  const opts = { cwd: ctx.workDir, signal: ctx.signal };
  const clean = (t: string) => t.replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  let text = clean((await run("djvutxt", [ctx.input], opts)).stdout);
  if (!text) {
    const tiff = join(ctx.workDir, "djvu-pages.tif");
    await run("ddjvu", ["-format=tiff", `-page=1-${DJVU_OCR_MAX_PAGES}`, "-scale=300", ctx.input, tiff], opts);
    text = clean((await run("tesseract", [tiff, "stdout", "-l", "eng"], opts)).stdout);
  }
  if (!text) throw new HttpError(422, "the DJVU file contains no recognisable text");
  return text + "\n";
}

export async function djvuToTxt(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.txt");
  await writeFile(out, await djvuText(ctx));
  return { path: out, contentType: mimeFor("txt"), filename: "converted.txt" };
}

/** DJVU -> text layer -> Calibre (DOCX, RTF and all e-book targets). */
export async function djvuViaText(ctx: JobContext): Promise<JobOutput> {
  const txt = join(ctx.workDir, "djvu-text.txt");
  await writeFile(txt, await djvuText(ctx));
  return toEbook({ ...ctx, input: txt, from: "txt" });
}

register("djvu", "pdf", djvuToPdf);
register("djvu", "txt", djvuToTxt);
register("djvu", ["docx", "rtf", ...EBOOK_TARGETS], djvuViaText);
