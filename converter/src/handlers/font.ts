// Task 21: fonts (TTF, OTF, EOT, WOFF, WOFF2, SVG font, PFB).
// Pipeline: input -> plain sfnt (TTF/OTF) -> target.
//   unwrap:   WOFF/WOFF2/EOT -> sfnt via fontTools (py/fontconv.py)
//   outlines: SVG font / PFB -> TTF, and TTF<->OTF, sfnt -> SVG font via FontForge
//   wrap:     sfnt -> WOFF/WOFF2 (fontTools), TrueType sfnt -> EOT (fontconv.py)
import { join } from "node:path";
import { open, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

/** py/ sits next to src/ and dist/ (the Dockerfile copies it). */
export const FONTCONV = fileURLToPath(new URL("../../py/fontconv.py", import.meta.url));
// Constant FontForge script; file paths are passed as argv ($1, $2), never interpolated.
const FF_SCRIPT = "Open($1); Generate($2)";

/** Copy of the matrix rows (a test asserts it equals matrix.json). */
export const FONT_ROWS: Record<string, string[]> = {
  ttf: ["otf", "eot", "woff", "woff2", "svg"],
  otf: ["ttf", "eot", "woff", "woff2", "svg"],
  eot: ["ttf", "otf", "woff", "woff2", "svg"],
  woff: ["ttf", "otf", "eot", "woff2", "svg"],
  woff2: ["ttf", "otf", "eot", "woff", "svg"],
  svg: ["ttf", "otf", "eot", "woff", "woff2"],
  pfb: ["ttf", "otf", "eot", "woff", "woff2", "svg"],
};

const opts = (ctx: JobContext) => ({ cwd: ctx.workDir, signal: ctx.signal });

async function fontforge(input: string, output: string, ctx: JobContext): Promise<string> {
  try { await run("fontforge", ["-quiet", "-lang=ff", "-c", FF_SCRIPT, input, output], opts(ctx)); }
  catch (e) { if (ctx.signal.aborted) throw e; throw new HttpError(422, "FontForge could not convert this font"); }
  if (!(await magic(output).catch(() => ""))) throw new HttpError(422, "FontForge produced no output");
  return output;
}

async function fontconv(args: string[], ctx: JobContext): Promise<void> {
  try { await run("python3", [FONTCONV, ...args], opts(ctx)); }
  catch (e) {
    if (ctx.signal.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(422, `invalid font: ${msg.slice(-200)}`);
  }
}

async function magic(p: string): Promise<string> {
  const fh = await open(p, "r");
  try { const b = Buffer.alloc(4); const { bytesRead } = await fh.read(b, 0, 4, 0); return b.subarray(0, bytesRead).toString("latin1"); }
  finally { await fh.close(); }
}
const isTrueType = (m: string) => m === "\u0000\u0001\u0000\u0000" || m === "true";

/** Any supported input -> plain sfnt file (TrueType or CFF/OTF). */
export async function toSfnt(ctx: JobContext): Promise<string> {
  switch (ctx.from) {
    case "ttf": case "otf": {
      const m = await magic(ctx.input);
      if (!isTrueType(m) && m !== "OTTO") throw new HttpError(422, "not a TrueType/OpenType font");
      return ctx.input;
    }
    case "woff": case "woff2": case "eot": {
      const out = join(ctx.workDir, "unwrapped.sfnt");
      await fontconv(["unwrap", ctx.input, out], ctx);
      return out;
    }
    case "svg": case "pfb":
      return fontforge(ctx.input, join(ctx.workDir, "outlines.ttf"), ctx);
    default: throw new HttpError(400, `unsupported font source ${ctx.from}`);
  }
}

/** sfnt -> sfnt with TrueType outlines (copy when it already has them). */
async function asTrueType(sfnt: string, ctx: JobContext): Promise<string> {
  if (isTrueType(await magic(sfnt))) {
    if (sfnt.endsWith(".ttf")) return sfnt;
    const ttf = join(ctx.workDir, "font-tt.ttf");
    await copyFile(sfnt, ttf);
    return ttf;
  }
  return fontforge(sfnt, join(ctx.workDir, "font-tt.ttf"), ctx);
}

/** FontForge needs a file extension it recognises. */
async function named(sfnt: string, ctx: JobContext): Promise<string> {
  if (/\.(ttf|otf)$/.test(sfnt)) return sfnt;
  const p = join(ctx.workDir, (await magic(sfnt)) === "OTTO" ? "font-in.otf" : "font-in.ttf");
  await copyFile(sfnt, p);
  return p;
}

export async function convertFont(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, `converted.${ctx.to}`);
  const sfnt = await toSfnt(ctx);
  switch (ctx.to) {
    case "ttf": await copyFile(await asTrueType(sfnt, ctx), out); break;
    case "otf":
      if ((await magic(sfnt)) === "OTTO") await copyFile(sfnt, out);
      else await fontforge(await named(sfnt, ctx), out, ctx);
      break;
    case "woff": case "woff2": await fontconv(["wrap", ctx.to, sfnt, out], ctx); break;
    case "eot": await fontconv(["eot", await asTrueType(sfnt, ctx), out], ctx); break;
    case "svg": await fontforge(await named(sfnt, ctx), out, ctx); break;
    default: throw new HttpError(400, `unsupported font target ${ctx.to}`);
  }
  return { path: out, contentType: mimeFor(ctx.to === "svg" ? "svg" : ctx.to), filename: `converted.${ctx.to}` };
}

// SVG's font targets (ttf/otf/eot/woff/woff2) don't overlap its image targets, so the
// from->to registry key is unambiguous.
for (const [src, targets] of Object.entries(FONT_ROWS)) register(src, targets, convertFont);
