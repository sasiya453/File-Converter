// Helpers shared by POST /convert (sync) and POST /jobs (async).
import type { IncomingMessage } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../types.js";
import { workRoot } from "./resources.js";

export const LIMITS = {
  maxInput: 20 * 1024 * 1024,
  maxOutput: 50 * 1024 * 1024,
  maxBody: 16 * 1024,
};
export const FORMAT_RE = /^[a-z0-9][a-z0-9.]{0,9}$/;

export { timeoutFor } from "./resources.js";

/** SSRF guard: only URLs starting with one of ALLOWED_URL_PREFIXES may be downloaded. */
export function allowedUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.username || url.password) return false;
  const prefixes = (process.env.ALLOWED_URL_PREFIXES ?? "https://api.telegram.org/file/").split(",").map((p) => p.trim()).filter(Boolean);
  return prefixes.some((p) => url.href.startsWith(p));
}

/** Constant-time Bearer token check. */
export function authorized(req: IncomingMessage): boolean {
  const token = process.env.CONVERTER_TOKEN ?? "";
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  if (!token || got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > LIMITS.maxBody) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
}

/** Stream a URL to disk with a hard size cap (no redirects). */
export async function download(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal, redirect: "error" });
  if (!res.ok || !res.body) throw new HttpError(502, `download failed: ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > LIMITS.maxInput) throw new HttpError(413, "input too large");
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > LIMITS.maxInput) cb(new HttpError(413, "input too large")); else cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), limiter, createWriteStream(dest));
}

/** Per-job private dir under WORK_ROOT (created on demand: /tmp is empty on a fresh HF container). */
export async function newWorkDir(): Promise<string> {
  const root = workRoot();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "job-"));
}
