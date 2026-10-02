import { spawn, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
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
 * Tools that are safe to run under an address-space (RLIMIT_AS) cap. LibreOffice, Calibre
 * (QtWebEngine/Chromium), Java and FontForge reserve large virtual ranges up front and
 * crash under RLIMIT_AS, so they only get the other caps (file size, core, open files).
 * Those run one instance per job (per-job profile) and the queue caps concurrency.
 */
export const AS_LIMITED_TOOLS = new Set([
  "ffmpeg", "ffprobe", "gs", "convert", "magick", "identify", "tesseract", "pdftoppm", "pdftotext",
  "ddjvu", "djvutxt", "rsvg-convert", "heif-convert", "avifdec", "7z", "img2pdf", "zip", "unzip", "woff2_compress",
  "woff2_decompress",
]);

const mb = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Math.floor((Number.isFinite(v) && v > 0 ? v : def) * 1024 * 1024);
};

/** Niceness for tool processes, so the HTTP server (health checks, /jobs) stays responsive. */
const toolNice = () => Math.min(19, Math.max(0, Number(process.env.TOOL_NICE ?? 10) || 0));

let prlimitPath: string | null | undefined;
function prlimitBinary(): string | null {
  if (process.env.USE_PRLIMIT === "0") return null;
  if (prlimitPath === undefined) {
    prlimitPath = spawnSync("prlimit", ["--version"], { stdio: "ignore" }).status === 0 ? "prlimit" : null;
  }
  return prlimitPath;
}

/**
 * Wrap a command with `prlimit` (util-linux, always present on Debian) so one runaway
 * tool cannot fill the disk or eat all RAM:
 *  - every tool: max output file size (TOOL_MAX_FILE_MB, default 2048), no core dumps, ≤ 1024 open files;
 *  - AS_LIMITED_TOOLS also get an address-space cap (TOOL_MAX_MEM_MB, default 4096).
 * The tool also runs under `nice -n TOOL_NICE` (default 10) so the HTTP server stays responsive.
 * prlimit and nice both exec() the tool, so the PID / process group stay the same and the
 * timeout's process-group kill still works. Disabled with USE_PRLIMIT=0 or when prlimit is missing.
 */
export function withLimits(cmd: string, args: string[]): { cmd: string; args: string[] } {
  const pl = prlimitBinary();
  if (!pl) return { cmd, args };
  const limits = [`--fsize=${mb("TOOL_MAX_FILE_MB", 2048)}`, "--core=0", "--nofile=1024"];
  if (AS_LIMITED_TOOLS.has(basename(cmd))) limits.push(`--as=${mb("TOOL_MAX_MEM_MB", 4096)}`);
  const nice = toolNice();
  return { cmd: pl, args: [...limits, "--", ...(nice > 0 ? ["nice", "-n", String(nice)] : []), cmd, ...args] };
}

/**
 * Run a tool as a subprocess. Arguments are passed as an argv array (never through
 * a shell), so user-controlled values cannot inject commands. The process gets a
 * minimal environment and is killed when the job's AbortSignal fires.
 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new HttpError(504, "timeout"));
    const wrapped = withLimits(cmd, args);
    const child = spawn(wrapped.cmd, wrapped.args, {
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
      // prlimit/nice could not exec the tool (missing binary): same as a spawn error without the wrapper.
      else if (code === 127 && wrapped.cmd !== cmd && /failed to execute|No such file/.test(stderr)) reject(new HttpError(500, `${cmd}: not found`));
      else reject(new HttpError(422, `${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
