import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { lookup } from "../registry.js";
import { HttpError } from "../types.js";
import { redact } from "../telegram.js";
import { LIMITS, FORMAT_RE, allowedUrl, authorized, readJson, download, newWorkDir, timeoutFor } from "./common.js";
import { createJobService, validateJob, type JobServiceOptions } from "./jobs.js";
import { hasEnoughDisk } from "./resources.js";
import "../handlers/index.js";

export { LIMITS, newWorkDir };

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const sendError = (res: ServerResponse, status: number, message: string) => sendJson(res, status, { error: message });

/** Synchronous conversion (local testing / fallback). Streams the result back in the response. */
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

  const signal = AbortSignal.timeout(timeoutFor(from, to, typeof options.section === "string" ? options.section : undefined));
  if (!(await hasEnoughDisk())) throw new HttpError(507, "not enough free disk space, try again later");
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
    console.log(JSON.stringify({ evt: "convert_ok", from, to, ms: Date.now() - started, bytes: st.size }));
  } catch (e) {
    const err = e instanceof HttpError ? e : signal.aborted ? new HttpError(504, "timeout") : new HttpError(500, String(e));
    console.log(JSON.stringify({ evt: "convert_fail", from, to, ms: Date.now() - started, status: err.status, msg: redact(err.message).slice(0, 500) }));
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function createApp(opts: JobServiceOptions = {}) {
  const jobs = createJobService(opts);
  const startedAt = Date.now();

  async function handleJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return sendError(res, 401, "unauthorized");
    const job = validateJob(await readJson(req));
    if (!lookup(job.from, job.to)) return sendError(res, 422, `unsupported conversion ${job.from}->${job.to}`);
    if (!(await hasEnoughDisk())) {
      // Same answer as a full queue: the Worker shows "busy, try again in a minute".
      console.log(JSON.stringify({ evt: "job_rejected", jobId: job.jobId, from: job.from, to: job.to, reason: "low_disk" }));
      return sendJson(res, 429, { error: "not enough free disk space", jobId: job.jobId });
    }
    const r = jobs.queue.enqueue(job.jobId, job);
    if (r.status === "full") {
      console.log(JSON.stringify({ evt: "job_rejected", jobId: job.jobId, from: job.from, to: job.to, reason: "queue_full" }));
      return sendJson(res, 429, { error: "queue full", jobId: job.jobId });
    }
    if (r.status === "queued") {
      console.log(JSON.stringify({ evt: "job_queued", jobId: job.jobId, from: job.from, to: job.to, section: job.section,
        position: r.position, queued: jobs.queue.queued, running: jobs.queue.running }));
    }
    sendJson(res, 202, { jobId: job.jobId, position: r.position, ...(r.status === "duplicate" ? { duplicate: true } : {}) });
  }

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if ((req.method === "GET" || req.method === "HEAD") && (path === "/health" || path === "/")) {
        return sendJson(res, 200, {
          ok: true, queued: jobs.queue.queued, running: jobs.queue.running,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        });
      }
      if (req.method === "POST" && path === "/jobs") return await handleJobs(req, res);
      if (req.method === "POST" && path === "/convert") return await handleConvert(req, res);
      sendError(res, 404, "not found");
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, "internal error");
      sendError(res, err.status, redact(err.message).slice(0, 1000));
    }
  });
  return Object.assign(server, { jobs });
}
