// Async job API: POST /jobs validates + enqueues, the worker pool converts and
// delivers the result to Telegram itself, then deletes the "⏳ Converting…" message.
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { lookup } from "../registry.js";
import { HttpError } from "../types.js";
import { TelegramClient, TelegramError, SEND_METHODS, TELEGRAM_UPLOAD_LIMIT, redact, type SendMethod } from "../telegram.js";
import { errorText, JOB_EXPIRED, type JobErrorKind } from "../shared/job-messages.js";
import { JobQueue } from "./queue.js";
import { download, newWorkDir, LIMITS, FORMAT_RE, allowedUrl, timeoutFor } from "./common.js";
import { hasEnoughDisk } from "./resources.js";

export interface JobPayload {
  jobId: string;
  fileUrl: string;
  from: string;
  to: string;
  section: string;
  options: Record<string, string | number | boolean>;
  chatId: number;
  statusMessageId: number;
  replyToMessageId?: number;
  originalName: string;
  delivery: { method: SendMethod; ext: string };
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SECTION_RE = /^[a-z]{1,16}$/;
const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/i;

const bad = (msg: string): never => { throw new HttpError(400, msg); };
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Strictly validate a /jobs body. Throws HttpError(400) with a short reason. */
export function validateJob(body: unknown): JobPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("body must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.jobId !== "string" || !JOB_ID_RE.test(b.jobId)) bad("invalid jobId");
  if (typeof b.fileUrl !== "string" || b.fileUrl.length > 2048 || !allowedUrl(b.fileUrl)) bad("fileUrl not allowed");
  if (typeof b.from !== "string" || !FORMAT_RE.test(b.from)) bad("invalid from");
  if (typeof b.to !== "string" || !FORMAT_RE.test(b.to)) bad("invalid to");
  if (typeof b.section !== "string" || !SECTION_RE.test(b.section)) bad("invalid section");
  if (!Number.isSafeInteger(b.chatId) || b.chatId === 0) bad("invalid chatId");
  if (!isPosInt(b.statusMessageId)) bad("invalid statusMessageId");
  if (b.replyToMessageId !== undefined && b.replyToMessageId !== null && !isPosInt(b.replyToMessageId)) bad("invalid replyToMessageId");
  if (typeof b.originalName !== "string" || b.originalName.length > 512) bad("invalid originalName");
  const d = b.delivery as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") bad("invalid delivery");
  if (!SEND_METHODS.includes(d!.method as SendMethod)) bad("invalid delivery.method");
  if (typeof d!.ext !== "string" || !/^[a-z0-9][a-z0-9.]{0,9}$/.test(d!.ext)) bad("invalid delivery.ext");
  const options: Record<string, string | number | boolean> = {};
  if (b.options !== undefined && b.options !== null) {
    if (typeof b.options !== "object" || Array.isArray(b.options)) bad("invalid options");
    const entries = Object.entries(b.options as Record<string, unknown>);
    if (entries.length > 16) bad("too many options");
    for (const [k, v] of entries) {
      if (!OPTION_KEY_RE.test(k)) bad("invalid option key");
      if (typeof v === "string" ? v.length > 64 : !(typeof v === "number" && Number.isFinite(v)) && typeof v !== "boolean") bad("invalid option value");
      options[k] = v as string | number | boolean;
    }
  }
  options.section = b.section as string;
  return {
    jobId: b.jobId as string, fileUrl: b.fileUrl as string, from: b.from as string, to: b.to as string,
    section: b.section as string, options, chatId: b.chatId as number, statusMessageId: b.statusMessageId as number,
    replyToMessageId: (b.replyToMessageId as number | undefined) ?? undefined,
    originalName: b.originalName as string,
    delivery: { method: d!.method as SendMethod, ext: d!.ext as string },
  };
}

/** "report.final.pdf" + "docx" -> "report.final.docx" (handles .qt.txt); unsafe chars replaced. */
export function outputName(original: string, ext: string): string {
  const base = (original || "file").replace(/[\\/]/g, "_").replace(/\.qt\.txt$/i, "").replace(/\.[^.]+$/, "") || "file";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]+/g, "_").slice(0, 200) || "file";
  return `${clean}.${ext}`;
}

/** A document target that came back as a ZIP (e.g. multi-page PDF -> PNG) gets the .zip extension. */
export function resultExt(deliveryExt: string, method: SendMethod, contentType: string, filename: string): string {
  if (method !== "sendDocument" || deliveryExt.endsWith("zip")) return deliveryExt;
  return /application\/zip/i.test(contentType) || /\.zip$/i.test(filename) ? "zip" : deliveryExt;
}

/** Converter/Telegram failure -> user-facing error kind (same mapping the Worker used). */
export function errorKind(e: unknown): JobErrorKind {
  if (e instanceof HttpError) {
    if (e.status === 504) return "timeout";
    if (e.status === 413) return "too_large";
    if (e.status === 400) return "unsupported";
    if (e.status === 422) return "invalid_input";
    return "failed";
  }
  if (e instanceof TelegramError && (e.status === 413 || /too (big|large)/i.test(e.description))) return "too_large";
  return "failed";
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

export interface JobRunnerDeps { telegram: () => TelegramClient }

/** Convert one job and deliver it. Never throws (errors are reported to the user). */
export async function processJob(job: JobPayload, deps: JobRunnerDeps): Promise<void> {
  const tg = deps.telegram();
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutFor(job.from, job.to, job.section));
  let workDir = "";
  let bytes = 0;
  try {
    const handler = lookup(job.from, job.to);
    if (!handler) throw new HttpError(400, `unsupported conversion ${job.from}->${job.to}`);
    // Disk can fill up while the job waited in the queue.
    if (!(await hasEnoughDisk())) throw new HttpError(507, "not enough free disk space");
    workDir = await newWorkDir();
    const input = join(workDir, `input.${job.from}`); // fixed name: never a user-supplied filename on disk
    await download(job.fileUrl, input, signal);
    const out = await handler({ input, workDir, from: job.from, to: job.to, options: job.options, signal });
    bytes = (await stat(out.path)).size;
    if (bytes > Math.min(LIMITS.maxOutput, TELEGRAM_UPLOAD_LIMIT)) throw new HttpError(413, "output exceeds 50 MB");
    const name = outputName(job.originalName, resultExt(job.delivery.ext, job.delivery.method, out.contentType, out.filename));
    const params: Record<string, string | number | boolean> = { chat_id: job.chatId };
    if (job.replyToMessageId) {
      params.reply_parameters = JSON.stringify({ message_id: job.replyToMessageId, allow_sending_without_reply: true });
    }
    if (job.delivery.method === "sendVideo") params.supports_streaming = true;
    await tg.upload(job.delivery.method, out.path, name, out.contentType, params);
    await tg.deleteMessage(job.chatId, job.statusMessageId).catch(() => undefined);
    log({ evt: "job_ok", jobId: job.jobId, from: job.from, to: job.to, section: job.section, kind: "ok",
      method: job.delivery.method, bytes, ms: Date.now() - started });
  } catch (e) {
    const kind = signal.aborted && !(e instanceof TelegramError) ? "timeout" : errorKind(e);
    log({ evt: "job_fail", jobId: job.jobId, from: job.from, to: job.to, section: job.section, kind, bytes,
      ms: Date.now() - started, msg: redact(e instanceof Error ? e.message : String(e)).slice(0, 500) });
    await notify(tg, job, errorText(kind));
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Edit the status message; if that fails (deleted, too old) send a new message instead. */
async function notify(tg: TelegramClient, job: JobPayload, text: string): Promise<void> {
  try { await tg.editMessageText(job.chatId, job.statusMessageId, text); }
  catch {
    await tg.call("sendMessage", { chat_id: job.chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
      .catch((e) => log({ evt: "notify_fail", jobId: job.jobId, msg: redact(String(e)).slice(0, 200) }));
  }
}

export interface JobServiceOptions {
  concurrency?: number;
  maxQueue?: number;
  maxAgeMs?: number;
  telegram?: () => TelegramClient;
}

export function createJobService(o: JobServiceOptions = {}) {
  const telegram = o.telegram ?? (() => new TelegramClient(process.env.BOT_TOKEN ?? ""));
  const queue = new JobQueue<JobPayload>({
    concurrency: o.concurrency ?? Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS ?? 2) || 2),
    maxQueue: o.maxQueue ?? Math.max(0, Number(process.env.MAX_QUEUE ?? 20) || 20),
    maxAgeMs: o.maxAgeMs ?? Number(process.env.JOB_MAX_AGE_MS ?? 10 * 60 * 1000),
    run: (job) => processJob(job, { telegram }),
    onExpired: async (job) => {
      log({ evt: "job_fail", jobId: job.jobId, from: job.from, to: job.to, section: job.section, kind: "expired", bytes: 0, ms: 0 });
      await notify(telegram(), job, JOB_EXPIRED);
    },
  });
  return { queue };
}
