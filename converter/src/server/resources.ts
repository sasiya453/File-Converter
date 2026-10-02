// Resource safety for a small shared host (HF free Space: ~2 vCPU, 16 GB RAM, ephemeral disk).
import { readdir, rm, stat, statfs, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const MAX_JOB_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default per-family job timeouts (ms). Since jobs are asynchronous, HF's proxy timeout
 * no longer matters; these keep one job from hogging the CPU. Every job stays < 5 min.
 */
export const FAMILY_TIMEOUT_MS: Record<string, number> = {
  video: 110_000,
  ebook: 110_000,
  document: 90_000,
  presentation: 90_000,
  audio: 90_000,
  sheet: 60_000,
  image: 60_000,
  font: 30_000,
  subtitle: 20_000,
};

const envMs = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/**
 * Job timeout for a conversion. Order: `JOB_TIMEOUT_<FAMILY>_MS` env → the family table →
 * `JOB_TIMEOUT_MS` env (fallback for an unknown/missing family, default 120 s). Always ≤ 5 min.
 */
export function timeoutFor(_from: string, _to: string, section?: string): number {
  const fam = section && /^[a-z]{1,16}$/.test(section) ? section : undefined;
  const ms = (fam ? envMs(`JOB_TIMEOUT_${fam.toUpperCase()}_MS`) : undefined)
    ?? (fam ? FAMILY_TIMEOUT_MS[fam] : undefined)
    ?? envMs("JOB_TIMEOUT_MS")
    ?? 120_000;
  return Math.min(ms, MAX_JOB_TIMEOUT_MS);
}

export const workRoot = () => process.env.WORK_ROOT ?? tmpdir();

/** Minimum free disk space on WORK_ROOT before a new job is accepted (MIN_FREE_DISK_MB, default 1024). */
export const minFreeDiskBytes = () => (Number(process.env.MIN_FREE_DISK_MB ?? 1024) || 0) * 1024 * 1024;

/** Free bytes available to us on the WORK_ROOT filesystem (Infinity if it cannot be measured). */
export async function freeDiskBytes(dir = workRoot()): Promise<number> {
  try {
    await mkdir(dir, { recursive: true });
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function hasEnoughDisk(dir = workRoot()): Promise<boolean> {
  return (await freeDiskBytes(dir)) >= minFreeDiskBytes();
}

/**
 * Remove stale per-job dirs (`job-*`) in WORK_ROOT. At startup every job dir is stale
 * (the queue is in memory), so call with `olderThanMs = 0`. Later, a periodic sweep
 * removes anything older than the longest possible job as a safety net.
 */
export async function sweepWorkRoot(olderThanMs = 0, dir = workRoot(), now = Date.now()): Promise<number> {
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith("job-")) continue;
    const p = join(dir, name);
    try {
      if (olderThanMs > 0 && now - (await stat(p)).mtimeMs < olderThanMs) continue;
      await rm(p, { recursive: true, force: true });
      removed++;
    } catch { /* raced with the job's own cleanup */ }
  }
  return removed;
}
