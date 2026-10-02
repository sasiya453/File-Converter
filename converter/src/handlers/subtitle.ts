// Task 23: subtitles. All work is done by py/subconv.py (pysubs2 + custom
// readers/writers for SBV, LRC, DFXP/TTML, QT.TXT and Spruce STL).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "../registry.js";
import { run } from "../run.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

export const SUBCONV = fileURLToPath(new URL("../../py/subconv.py", import.meta.url));
export const SUBTITLE_FORMATS = ["srt", "vtt", "stl", "sbv", "sub", "ass", "ssa", "lrc", "dfxp", "ttml", "qt.txt"];

const MIME: Record<string, string> = {
  srt: "application/x-subrip", vtt: "text/vtt", ttml: "application/ttml+xml", dfxp: "application/ttaf+xml",
};
const mime = (ext: string) => `${MIME[ext] ?? "text/plain"}; charset=utf-8`;

/** Frame rate for frame-based formats (MicroDVD .sub, STL). Optional `options.fps`, default 25. */
export function fpsOption(options: Record<string, unknown>): string {
  const v = Number(options.fps ?? 25);
  if (!Number.isFinite(v) || v < 1 || v > 120) throw new HttpError(400, "fps must be between 1 and 120");
  return String(v);
}

export async function convertSubtitle(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, `converted.${ctx.to}`);
  try {
    await run("python3", [SUBCONV, ctx.from, ctx.to, ctx.input, out, fpsOption(ctx.options)], { cwd: ctx.workDir, signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted || (e instanceof HttpError && e.status !== 422)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(422, `invalid subtitle file: ${msg.slice(-200)}`);
  }
  return { path: out, contentType: mime(ctx.to), filename: `converted.${ctx.to}` };
}

// Every non-diagonal cell of the SUBTITLE section is ✓ in the matrix.
for (const src of SUBTITLE_FORMATS) register(src, SUBTITLE_FORMATS.filter((t) => t !== src), convertSubtitle);
