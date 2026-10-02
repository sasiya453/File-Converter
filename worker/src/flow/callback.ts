import type { Env } from "../env";
import type { Telegram, TgCallbackQuery } from "../telegram";
import { decodeCallback } from "./keyboard";
import { loadSession } from "./session";
import { checkRateLimit } from "./ratelimit";
import { isAllowed } from "../matrix";
import { deliveryFor } from "../matrix/delivery";
import { makeConverter, ConverterError, type ConverterClient } from "../converter";
import {
  CONVERSION_FAILED, CONVERSION_TIMEOUT, CONVERTING, RATE_LIMITED, RESULT_TOO_LARGE,
  SESSION_EXPIRED, UNSUPPORTED_HTML,
} from "../messages";

/** "report.final.pdf" + "docx" -> "report.final.docx" (handles the .qt.txt double extension). */
export function outputName(original: string, ext: string): string {
  const base = (original || "file").replace(/\.qt\.txt$/i, "").replace(/\.[^./\\]+$/, "") || "file";
  return `${base}.${ext}`;
}

/**
 * Final extension: normally the delivery's ext, but if the converter returned a
 * ZIP for a document target (e.g. a multi-page PDF -> PNG gives all pages zipped), use .zip.
 */
export function resultExt(deliveryExt: string, method: string, result: { contentType: string; filename?: string }): string {
  if (method !== "sendDocument" || deliveryExt.endsWith("zip")) return deliveryExt;
  const zipped = /application\/zip/i.test(result.contentType) || /\.zip$/i.test(result.filename ?? "");
  return zipped ? "zip" : deliveryExt;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ConverterError) {
    if (e.kind === "timeout") return CONVERSION_TIMEOUT;
    if (e.kind === "too_large") return RESULT_TOO_LARGE;
    if (e.kind === "unsupported") return UNSUPPORTED_HTML;
  }
  return CONVERSION_FAILED;
}

/** Handles a target-format button press: validate → rate limit → convert → deliver. */
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
  const limit = Number(env.RATE_LIMIT_PER_MIN ?? 5);
  if (!(await checkRateLimit(env.SESSIONS, cq.from.id, limit))) {
    await tg.answerCallback(cq.id, RATE_LIMITED);
    return;
  }
  await tg.answerCallback(cq.id);

  const status = await tg.sendMessage(chatId, CONVERTING);
  const delivery = deliveryFor(choice.section, choice.target);
  const started = Date.now();
  try {
    const { url } = await tg.getFileUrl(session.fileId);
    const result = await converter.convert({
      fileUrl: url, from: session.source, to: choice.target, options: { section: choice.section },
    });
    await tg.upload(delivery.method, delivery.field, result.body, outputName(session.fileName, resultExt(delivery.ext, delivery.method, result)), {
      chat_id: chatId, ...(delivery.extra ?? {}),
    });
    console.log(JSON.stringify({ evt: "convert_ok", from: session.source, to: choice.target, ms: Date.now() - started }));
  } catch (e) {
    console.error(JSON.stringify({ evt: "convert_fail", from: session.source, to: choice.target, err: String(e).slice(0, 500) }));
    await tg.sendMessage(chatId, errorMessage(e)).catch(() => undefined);
  } finally {
    await tg.deleteMessage(chatId, status.message_id).catch(() => undefined);
  }
}
