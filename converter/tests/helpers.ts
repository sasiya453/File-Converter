import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { lookup } from "../src/registry.js";
import "../src/handlers/index.js";
import type { JobOutput } from "../src/types.js";

export const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

export const hasTool = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

/** Run a registered handler on a fixture in a fresh temp dir; returns output + cleanup. */
export async function convertFixture(fixture: string, to: string, options: Record<string, unknown> = {}) {
  const from = extname(fixture).slice(1).toLowerCase();
  const handler = lookup(from, to);
  if (!handler) throw new Error(`no handler ${from}->${to}`);
  const workDir = await mkdtemp(join(tmpdir(), "test-job-"));
  const input = join(workDir, `input.${from}`);
  await copyFile(join(FIXTURES, fixture), input);
  const out: JobOutput = await handler({ input, workDir, from, to, options, signal: AbortSignal.timeout(120_000) });
  return { out, cleanup: () => rm(workDir, { recursive: true, force: true }) };
}

/** Extract plain text from an office/ebook output for content assertions. */
export function textOf(path: string): string {
  const r = spawnSync("python3", ["-c",
    "import sys,zipfile,re;z=zipfile.ZipFile(sys.argv[1]);print(re.sub(r'<[^>]+>','',z.read('word/document.xml').decode()))", path]);
  return r.stdout.toString();
}
