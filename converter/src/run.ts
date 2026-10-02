import { spawn } from "node:child_process";
import { join } from "node:path";
import { HttpError } from "./types.js";

export interface RunOptions {
  cwd: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  maxStderr?: number;
  /** Writable per-job home (defaults to cwd). HOME/XDG_* /TMPDIR point here. */
  home?: string;
}

/**
 * Environment for a tool subprocess. The container runs as uid 1000 with a
 * read-only (or absent) $HOME, so every tool that wants to write a profile/cache
 * (LibreOffice, Calibre, FontForge, fontconfig, ImageMagick, Python) is pointed
 * at the job's own directory. Only a small allowlist of the parent env is passed.
 */
export function toolEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_RUNTIME_DIR: home,
    MAGICK_TEMPORARY_PATH: home,
    PYTHONDONTWRITEBYTECODE: "1",
    // Calibre: config + temp inside the job dir; Qt without a display; Chromium
    // (QtWebEngine, used for PDF output) cannot use its sandbox in an unprivileged container.
    CALIBRE_CONFIG_DIRECTORY: join(home, ".config", "calibre"),
    CALIBRE_TEMP_DIR: home,
    CALIBRE_CACHE_DIRECTORY: join(home, ".cache", "calibre"),
    QT_QPA_PLATFORM: "offscreen",
    QTWEBENGINE_DISABLE_SANDBOX: "1",
    QTWEBENGINE_CHROMIUM_FLAGS: "--no-sandbox",
    OMP_THREAD_LIMIT: "2", // tesseract
    ...extra,
  };
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
      env: toolEnv(opts.home ?? opts.cwd, opts.env),
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
