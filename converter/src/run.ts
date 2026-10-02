import { spawn } from "node:child_process";
import { HttpError } from "./types.js";

export interface RunOptions {
  cwd: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  maxStderr?: number;
}

/**
 * Run a tool as a subprocess. Arguments are passed as an argv array (never through
 * a shell), so user-controlled values cannot inject commands. The process gets a
 * minimal environment and is killed when the job's AbortSignal fires.
 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new HttpError(504, "timeout"));
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: opts.cwd, TMPDIR: opts.cwd, LANG: "C.UTF-8", ...opts.env },
      detached: true, // own process group so we can kill the whole tree
    });
    const max = opts.maxStderr ?? 16_384;
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < max) stderr += d.toString(); });
    const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    opts.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => { opts.signal.removeEventListener("abort", kill); reject(new HttpError(500, `${cmd}: ${e.message}`)); });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", kill);
      if (opts.signal.aborted) return reject(new HttpError(504, "timeout"));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new HttpError(422, `${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
