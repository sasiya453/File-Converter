// Raster image -> raster image via ImageMagick (Task 12).
// Rules: still targets use the first frame (largest frame for ICO); JPG/JPEG is flattened on white;
// ICO is downscaled to fit 256 px (the ICO limit); GIF<->WEBP keeps the animation, with a first-frame fallback.
import { join } from "node:path";
import { register } from "../registry.js";
import { mimeFor } from "../mime.js";
import { magick, identify } from "../tools/imagemagick.js";
import type { JobContext, JobOutput } from "../types.js";

export const RASTER_SOURCES = ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "tif", "tiff", "gif", "ico"];
export const RASTER_TARGETS = ["png", "jpg", "jpeg", "jp2", "webp", "bmp", "tif", "tiff", "gif", "ico"];

/** ImageMagick coder name per target extension (explicit, never inferred from user data). */
const CODER: Record<string, string> = {
  png: "PNG", jpg: "JPEG", jpeg: "JPEG", jp2: "JP2", webp: "WEBP", bmp: "BMP",
  tif: "TIFF", tiff: "TIFF", gif: "GIF", ico: "ICO",
};

/** Target-specific output options. */
function outputArgs(to: string): string[] {
  switch (to) {
    case "jpg": case "jpeg": return ["-background", "white", "-alpha", "remove", "-alpha", "off", "-quality", "90"];
    case "webp": return ["-quality", "90"];
    case "jp2": return ["-quality", "90"];
    case "tif": case "tiff": return ["-compress", "lzw"];
    case "ico": return ["-resize", "256x256>"]; // ICO max is 256 px; never upscale
    default: return [];
  }
}

const ANIMATED = new Set(["gif", "webp"]);

/** Index of the largest frame (used for ICO sources, which hold several icon sizes). */
async function largestFrame(ctx: JobContext): Promise<number> {
  const { stdout } = await identify(["-format", "%w %h\n", ctx.input], ctx.workDir, ctx.signal);
  let best = 0, bestArea = -1;
  stdout.trim().split("\n").forEach((line, i) => {
    const [w, h] = line.split(" ").map(Number);
    const area = (w ?? 0) * (h ?? 0);
    if (area > bestArea) { bestArea = area; best = i; }
  });
  return best;
}

export async function rasterToRaster(ctx: JobContext): Promise<JobOutput> {
  const to = ctx.to;
  const out = join(ctx.workDir, `converted.${to}`);
  const dest = `${CODER[to]}:${out}`;
  const frame = ctx.from === "ico" ? await largestFrame(ctx) : 0;
  const still = [`${ctx.input}[${frame}]`, "-auto-orient", "-strip", ...outputArgs(to), dest];
  if (ANIMATED.has(ctx.from) && ANIMATED.has(to)) {
    try {
      await magick([ctx.input, "-coalesce", "-strip", ...outputArgs(to), ...(to === "gif" ? ["-layers", "Optimize"] : []), dest],
        ctx.workDir, ctx.signal);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      await magick(still, ctx.workDir, ctx.signal); // e.g. IM6 without animated WebP support
    }
  } else {
    await magick(still, ctx.workDir, ctx.signal);
  }
  return { path: out, contentType: mimeFor(to), filename: `converted.${to}` };
}

for (const src of RASTER_SOURCES) register(src, RASTER_TARGETS.filter((t) => t !== src), rasterToRaster);
