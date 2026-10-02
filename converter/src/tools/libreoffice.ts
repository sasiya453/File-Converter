import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../run.js";
import { HttpError } from "../types.js";

/**
 * Convert with headless LibreOffice. Each job uses its own profile dir inside
 * workDir so parallel jobs never share/lock a user installation.
 * `filter` is the LibreOffice --convert-to spec, e.g. "docx:MS Word 2007 XML" (no shell, so no quotes).
 */
export async function soffice(input: string, workDir: string, filter: string, signal: AbortSignal,
  extraArgs: string[] = []): Promise<string> {
  const outDir = join(workDir, "lo-out");
  const profile = pathToFileURL(join(workDir, "lo-profile")).href;
  await run("soffice", [
    `-env:UserInstallation=${profile}`, "--headless", "--norestore", "--nolockcheck",
    ...extraArgs, "--convert-to", filter, "--outdir", outDir, input,
  ], { cwd: workDir, signal });
  const files = await readdir(outDir).catch(() => [] as string[]);
  if (!files[0]) throw new HttpError(422, "LibreOffice produced no output");
  return join(outDir, files[0]);
}
