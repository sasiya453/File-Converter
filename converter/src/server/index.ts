import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import { lookup, listConversions } from "../registry.js";
import { HttpError } from "../types.js";
import "../handlers/index.js";

export const LIMITS = {
  maxInput: 20 * 1024 * 1024,
  maxOutput: 50 * 1024 * 1024,
  timeoutMs: Number(process.env.JOB_TIMEOUT_MS ?? 120_000),
  maxBody: 16 * 1024,
};
const FORMAT_RE = /^[a-z0-9][a-z0-9.]{0,9}$/;

function allowedUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  const prefixes = (process.env.ALLOWED_URL_PREFIXES ?? "https://api.telegram.org/file/").split(",").filter(Boolean);
  return prefixes.some((p) => url.href.startsWith(p.trim()));
}

function authorized(req: IncomingMessage): boolean {
  const token = process.env.CONVERTER_TOKEN ?? "";
  const got = req.headers.authorization ?? "";
  const want = `Bearer ${token}`;
  if (!token || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > LIMITS.maxBody) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
}

async function download(url: string, dest: string, signal: AbortSignal): Promise<void> {
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
  const root = process.env.WORK_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "job-"));
}

function sendError(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

async function handleConvert(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) return sendError(res, 401, "unauthorized");
  const body = (await readJson(req)) as { fileUrl?: unknown; from?: unknown; to?: unknown; options?: unknown };
  const from = String(body.from ?? "").toLowerCase();
  const to = String(body.to ?? "").toLowerCase();
  const fileUrl = String(body.fileUrl ?? "");
  if (!FORMAT_RE.test(from) || !FORMAT_RE.test(to)) throw new HttpError(400, "invalid from/to");
  if (!allowedUrl(fileUrl)) throw new HttpError(400, "fileUrl not allowed");
  const handler = lookup(from, to);
  if (!handler) throw new HttpError(422, `unsupported conversion ${from}->${to}`);
  const options = body.options && typeof body.options === "object" ? (body.options as Record<string, unknown>) : {};

  const signal = AbortSignal.timeout(LIMITS.timeoutMs);
  const workDir = await newWorkDir();
  const started = Date.now();
  try {
    const input = join(workDir, `input.${from}`); // fixed name: never use user-supplied filenames on disk
    await download(fileUrl, input, signal);
    const out = await handler({ input, workDir, from, to, options, signal });
    const st = await stat(out.path);
    if (st.size > LIMITS.maxOutput) throw new HttpError(413, "output exceeds 50 MB");
    const name = basename(out.filename).replace(/[^\w.\-]+/g, "_");
    res.writeHead(200, {
      "content-type": out.contentType,
      "content-length": st.size,
      "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    await pipeline(createReadStream(out.path), res);
    console.log(JSON.stringify({ evt: "job_ok", from, to, ms: Date.now() - started, bytes: st.size }));
  } catch (e) {
    const err = e instanceof HttpError ? e : signal.aborted ? new HttpError(504, "timeout") : new HttpError(500, String(e));
    console.log(JSON.stringify({ evt: "job_fail", from, to, ms: Date.now() - started, status: err.status, msg: err.message.slice(0, 500) }));
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, conversions: listConversions().length }));
        return;
      }
      if (req.method === "POST" && path === "/convert") return await handleConvert(req, res);
      sendError(res, 404, "not found");
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, "internal error");
      sendError(res, err.status, err.message.slice(0, 1000));
    }
  });
}
