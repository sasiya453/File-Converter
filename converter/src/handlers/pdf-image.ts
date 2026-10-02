// PDF -> raster images (PNG/JPG) via poppler's pdftoppm.
// 1 page -> single image. Multiple pages -> ZIP of all pages (page-01.png, ...).
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { zipDir } from "../tools/calibre.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

export const MAX_PDF_PAGES = 200;
const DPI = "150";

export async function pdfToImages(ctx: JobContext): Promise<JobOutput> {
  const ext = ctx.to === "jpg" ? "jpg" : "png";
  const pagesDir = join(ctx.workDir, "pages");
  await mkdir(pagesDir);
  const fmt = ext === "jpg" ? ["-jpeg", "-jpegopt", "quality=90"] : ["-png"];
  await run("pdftoppm", [...fmt, "-r", DPI, "-l", String(MAX_PDF_PAGES), ctx.input, join(pagesDir, "page")],
    { cwd: ctx.workDir, signal: ctx.signal });
  const files = (await readdir(pagesDir)).filter((f) => f.endsWith(`.${ext}`)).sort();
  if (files.length === 0) throw new HttpError(422, "pdftoppm produced no pages");
  if (files.length === 1) return { path: join(pagesDir, files[0]!), contentType: mimeFor(ext), filename: `converted.${ext}` };
  const zip = await zipDir(pagesDir, ctx.workDir, ctx.signal);
  return { path: zip, contentType: mimeFor("zip"), filename: "converted.zip" };
}

register("pdf", ["png", "jpg"], pdfToImages);
