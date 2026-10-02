import type { Env } from "../env";
import type { Telegram, TgCallbackQuery } from "../telegram";
import { decodeCallback } from "./keyboard";
import { loadSession } from "./session";
import { checkRateLimit } from "./ratelimit";
import { isAllowed } from "../matrix";
import { deliveryFor } from "../matrix/delivery";
import { makeConverter, ConverterError, type ConverterClient, type JobRequest } from "../converter";
import {
  CONVERTER_BUSY, CONVERTER_UNAVAILABLE, CONVERTER_WAKING, CONVERTING, RATE_LIMITED, SESSION_EXPIRED, UNSUPPORTED_HTML,
  errorText,
} from "../messages";

/** How long a jobId is remembered in KV so a re-delivered webhook does not start a second job. */
const JOB_DEDUPE_TTL_SECONDS = 600;

/**
 * Stable job id for a button press. Telegram re-sends the same callback_query id when it
 * retries a webhook, so the converter (and our KV marker) can drop the duplicate.
 */
export function jobIdFor(cq: TgCallbackQuery): string {
  const id = `cq_${String(cq.id).replace(/[^A-Za-z0-9_-]/g, "")}`;
  return id.length >= 8 ? id.slice(0, 64) : id.padEnd(8, "0");
}

/** User-facing text for a failed submit. */
export function submitErrorMessage(e: unknown): string {
  if (e instanceof ConverterError) {
    if (e.kind === "busy") return CONVERTER_BUSY;
    if (e.kind === "unavailable") return CONVERTER_UNAVAILABLE;
    return errorText(e.kind);
  }
  return errorText("failed");
}

/**
 * Handles a target-format button press. The Worker only validates, shows the status
 * message and hands the job to the converter (POST /jobs → 202). The converter converts,
 * uploads the result to Telegram and deletes / edits the status message itself.
 */
export async function handleCallback(env: Env, tg: Telegram, cq: TgCallbackQuery,
  converter: ConverterClient = makeConverter(env)): Promise<void> {
  const chatId = cq.message?.chat.id;
  const choice = decodeCallback(cq.data);
  if (!chatId || !choice) {
    await tg.answerCallback(cq.id);
    return;
  }
  const session = await loadSession(env.SESSIONS, chatId);
  if (!session) {
    await tg.answerCallback(cq.id, SESSION_EXPIRED);
    return;
  }
  if (!isAllowed(choice.section, session.source, choice.target)) {
    await tg.answerCallback(cq.id, UNSUPPORTED_HTML);
    return;
  }
  const jobId = jobIdFor(cq);
  const dedupeKey = `job:${jobId}`;
  if (await env.SESSIONS.get(dedupeKey)) {
    await tg.answerCallback(cq.id).catch(() => undefined);
    return; // a retried webhook for a job we already submitted
  }
  const limit = Number(env.RATE_LIMIT_PER_MIN ?? 5);
  if (!(await checkRateLimit(env.SESSIONS, cq.from.id, limit))) {
    await tg.answerCallback(cq.id, RATE_LIMITED);
    return;
  }
  await env.SESSIONS.put(dedupeKey, "1", { expirationTtl: JOB_DEDUPE_TTL_SECONDS });
  await tg.answerCallback(cq.id);

  const status = await tg.sendMessage(chatId, CONVERTING);
  const delivery = deliveryFor(choice.section, choice.target);
  const started = Date.now();
  try {
    const { url } = await tg.getFileUrl(session.fileId);
    const job: JobRequest = {
      jobId, fileUrl: url, from: session.source, to: choice.target, section: choice.section,
      options: { section: choice.section }, chatId, statusMessageId: status.message_id,
      ...(session.messageId ? { replyToMessageId: session.messageId } : {}),
      originalName: session.fileName || "file", delivery: { method: delivery.method, ext: delivery.ext },
    };
    const accepted = await converter.submitJob(job, {
      onWaking: () => tg.editMessageText(chatId, status.message_id, CONVERTER_WAKING).then(() => undefined),
    });
    // Never log the file URL (it contains the bot token).
    console.log(JSON.stringify({ evt: "job_submitted", jobId, from: session.source, to: choice.target,
      section: choice.section, position: accepted.position, duplicate: !!accepted.duplicate, ms: Date.now() - started }));
  } catch (e) {
    const kind = e instanceof ConverterError ? e.kind : "internal";
    console.error(JSON.stringify({ evt: "job_submit_fail", jobId, from: session.source, to: choice.target, kind,
      ms: Date.now() - started, err: (e instanceof Error ? e.message : String(e)).replace(/bot\d+:[\w-]+/g, "bot<redacted>").slice(0, 300) }));
    // Let the user retry the same button after a busy / unavailable error.
    await env.SESSIONS.delete(dedupeKey).catch(() => undefined);
    const text = submitErrorMessage(e);
    await tg.editMessageText(chatId, status.message_id, text)
      .catch(() => tg.sendMessage(chatId, text).catch(() => undefined));
  }
}
