import { join } from "node:path";
import { stat } from "node:fs/promises";
import { run } from "../run.js";
import { HttpError } from "../types.js";

/** Run Calibre's ebook-convert. Returns the output path (a directory for OEB). */
export async function ebookConvert(input: string, workDir: string, ext: string, signal: AbortSignal,
  extraArgs: string[] = []): Promise<string> {
  const dest = join(workDir, `out.${ext}`);
  await run("ebook-convert", [input, dest, ...extraArgs], { cwd: workDir, signal });
  try { await stat(dest); } catch { throw new HttpError(422, "ebook-convert produced no output"); }
  return dest;
}

/** Zip the contents of a directory (e.g. OEB output) into `<dir>.zip`. */
export async function zipDir(dir: string, workDir: string, signal: AbortSignal): Promise<string> {
  const zipPath = `${dir}.zip`;
  await run("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: dir, signal });
  return zipPath;
}
