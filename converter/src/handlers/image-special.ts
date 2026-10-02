// Special image sources (Task 15): HEIC, AVIF, PSD, EPS, SVG, APNG, TGS.
// Each source is first normalised to a PNG (or GIF for animations) with the right tool and then
// handed to the generic raster handlers from image.ts. Only ✓ cells of the matrix are registered.
import { join } from "node:path";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { magick } from "../tools/imagemagick.js";
import { zipDir } from "../tools/calibre.js";
import { ffmpeg } from "./video.js";
import {
  rasterToRaster, imageToPdf, imageToSendPhoto, imageToOcr, imageToApng, imageToMp4, RASTER_TARGETS,
} from "./image.js";
import { HttpError, type Handler, type JobContext, type JobOutput } from "../types.js";

/** Matrix rows (image section) for the special sources. Kept in sync with matrix.json by the tests. */
export const SPECIAL_ROWS: Record<string, string[]> = {
  heic: ["png", "jpg", "jpeg", "jp2", "bmp", "gif", "ico", "pdf", "sendphoto", "ocr"],
  avif: ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "gif", "ico", "pdf", "sendphoto", "ocr"],
  psd: ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "tif", "tiff", "gif", "ico", "pdf", "sendphoto", "ocr"],
  eps: ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "tif", "tiff", "gif", "ico", "pdf", "sendphoto", "ocr", "apng"],
  svg: ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "tif", "tiff", "gif", "ico", "pdf", "sendphoto", "ocr", "apng"],
  apng: ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "tif", "tiff", "gif", "ico", "pdf", "sendphoto", "mp4"],
  tgs: ["webp", "gif", "gifz", "apng"],
};

const STILL: Record<string, Handler> = { pdf: imageToPdf, sendphoto: imageToSendPhoto, ocr: imageToOcr, apng: imageToApng };
const asPng = (ctx: JobContext, png: string): JobContext => ({ ...ctx, input: png, from: "png" });
const asGif = (ctx: JobContext, gif: string): JobContext => ({ ...ctx, input: gif, from: "gif" });

/** Run the generic handler for `ctx.to` on an already-normalised input. */
function generic(ctx: JobContext): Promise<JobOutput> {
  if (RASTER_TARGETS.includes(ctx.to)) return rasterToRaster(ctx);
  const h = STILL[ctx.to] ?? (ctx.to === "mp4" ? imageToMp4 : undefined);
  if (!h) throw new HttpError(400, `unsupported target ${ctx.to}`);
  return h(ctx);
}

async function firstOk(ctx: JobContext, attempts: Array<() => Promise<unknown>>): Promise<void> {
  let last: unknown;
  for (const a of attempts) {
    try { await a(); return; } catch (e) { if (ctx.signal.aborted) throw e; last = e; }
  }
  throw last instanceof HttpError ? last : new HttpError(422, "could not decode the image");
}

// ---- HEIC / AVIF / PSD: ImageMagick, with libheif/libavif CLI fallbacks ----
async function decodeBitmap(ctx: JobContext): Promise<string> {
  const png = join(ctx.workDir, "normalized.png");
  const opts = { cwd: ctx.workDir, signal: ctx.signal };
  // Explicit coder: a disguised file (e.g. MVG/SVG script renamed .psd) is never handed to another coder.
  const coder = ctx.from.toUpperCase();
  const im = () => magick([`${coder}:${ctx.input}[0]`, "-auto-orient", `PNG32:${png}`], ctx.workDir, ctx.signal);
  const attempts = [im];
  if (ctx.from === "heic" || ctx.from === "avif") attempts.push(() => run("heif-convert", [ctx.input, png], opts));
  if (ctx.from === "avif") attempts.push(() => run("avifdec", [ctx.input, png], opts));
  await firstOk(ctx, attempts);
  return png;
}

// ---- EPS: Ghostscript (never ImageMagick's PS coder; policy-blocked on IM6) ----
const GS_BASE = ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop"];
async function epsToPng(ctx: JobContext): Promise<string> {
  const png = join(ctx.workDir, "normalized.png");
  await run("gs", [...GS_BASE, "-sDEVICE=pngalpha", "-r150", "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
    "-dFirstPage=1", "-dLastPage=1", `-sOutputFile=${png}`, ctx.input], { cwd: ctx.workDir, signal: ctx.signal });
  return png;
}
async function epsToPdf(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.pdf");
  await run("gs", [...GS_BASE, "-sDEVICE=pdfwrite", `-sOutputFile=${out}`, ctx.input], { cwd: ctx.workDir, signal: ctx.signal });
  return { path: out, contentType: mimeFor("pdf"), filename: "converted.pdf" };
}

// ---- SVG: librsvg (no external resource loading outside the job dir) ----
async function svgToPng(ctx: JobContext): Promise<string> {
  const png = join(ctx.workDir, "normalized.png");
  await run("rsvg-convert", ["-f", "png", "-o", png, ctx.input], { cwd: ctx.workDir, signal: ctx.signal });
  return png;
}
async function svgToPdf(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.pdf");
  await run("rsvg-convert", ["-f", "pdf", "-o", out, ctx.input], { cwd: ctx.workDir, signal: ctx.signal });
  return { path: out, contentType: mimeFor("pdf"), filename: "converted.pdf" };
}

// ---- APNG: ffmpeg's APNG demuxer (keeps the animation for GIF/WEBP/MP4) ----
const APNG_IN = (ctx: JobContext) => ["-f", "apng", "-i", ctx.input];
async function apngFrame0(ctx: JobContext): Promise<string> {
  const png = join(ctx.workDir, "normalized.png");
  await ffmpeg([...APNG_IN(ctx), "-frames:v", "1", "-pix_fmt", "rgba", "-f", "image2", "-c:v", "png", png], ctx);
  return png;
}
async function apngToGif(ctx: JobContext): Promise<string> {
  const gif = join(ctx.workDir, "normalized.gif");
  await ffmpeg([...APNG_IN(ctx), "-filter_complex", "[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse",
    "-loop", "0", "-f", "gif", gif], ctx);
  return gif;
}
export async function apngHandler(ctx: JobContext): Promise<JobOutput> {
  if (ctx.to === "gif") {
    const gif = await apngToGif(ctx);
    return { path: gif, contentType: mimeFor("gif"), filename: "converted.gif" };
  }
  if (ctx.to === "webp" || ctx.to === "mp4") return generic({ ...asGif(ctx, await apngToGif(ctx)), to: ctx.to });
  return generic(asPng(ctx, await apngFrame0(ctx)));
}

// ---- TGS (Telegram animated sticker = gzipped Lottie JSON): python-lottie -> GIF ----
export const TGS_MAX_JSON = 16 * 1024 * 1024;
async function tgsToGif(ctx: JobContext): Promise<string> {
  let json: Buffer;
  try { json = gunzipSync(await readFile(ctx.input), { maxOutputLength: TGS_MAX_JSON }); }
  catch { throw new HttpError(422, "invalid TGS sticker (not gzipped Lottie JSON or too large)"); }
  const lottieJson = join(ctx.workDir, "sticker.json");
  await writeFile(lottieJson, json);
  const raw = join(ctx.workDir, "lottie.gif");
  await run("lottie_convert.py", ["--input-format", "lottie", "--output-format", "gif", lottieJson, raw],
    { cwd: ctx.workDir, signal: ctx.signal, maxStderr: 4096 });
  // python-lottie writes palette indices that ImageMagick rejects ("invalid colormap index"):
  // re-encode with ffmpeg (palettegen keeps transparency) so every downstream tool can read it.
  const gif = join(ctx.workDir, "normalized.gif");
  await ffmpeg(["-i", raw, "-filter_complex", "[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse",
    "-loop", "0", "-f", "gif", gif], ctx);
  return gif;
}
/** GIFZ (assumption): ZIP with the animated GIF plus every frame as a PNG. */
async function gifToGifz(ctx: JobContext, gif: string): Promise<JobOutput> {
  const dir = join(ctx.workDir, "gifz");
  await mkdir(join(dir, "frames"), { recursive: true });
  await copyFile(gif, join(dir, "animation.gif"));
  await magick([gif, "-coalesce", join(dir, "frames", "frame-%03d.png")], ctx.workDir, ctx.signal);
  const zip = await zipDir(dir, ctx.workDir, ctx.signal);
  return { path: zip, contentType: mimeFor("zip"), filename: "converted.zip" };
}
export async function tgsHandler(ctx: JobContext): Promise<JobOutput> {
  const gif = await tgsToGif(ctx);
  if (ctx.to === "gif") return { path: gif, contentType: mimeFor("gif"), filename: "converted.gif" };
  if (ctx.to === "gifz") return gifToGifz(ctx, gif);
  return generic({ ...asGif(ctx, gif), to: ctx.to }); // webp (animated) / apng
}

// ---- registration ----
const viaPng = (decode: (ctx: JobContext) => Promise<string>, pdf?: Handler): Handler =>
  async (ctx) => (ctx.to === "pdf" && pdf ? pdf(ctx) : generic(asPng(ctx, await decode(ctx))));

register("heic", SPECIAL_ROWS.heic!, viaPng(decodeBitmap));
register("avif", SPECIAL_ROWS.avif!, viaPng(decodeBitmap));
register("psd", SPECIAL_ROWS.psd!, viaPng(decodeBitmap));
register("eps", SPECIAL_ROWS.eps!, viaPng(epsToPng, epsToPdf));
register("svg", SPECIAL_ROWS.svg!, viaPng(svgToPng, svgToPdf));
register("apng", SPECIAL_ROWS.apng!, apngHandler);
register("tgs", SPECIAL_ROWS.tgs!, tgsHandler);
