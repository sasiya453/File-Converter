import type { Env } from "../env";
import type { Telegram, TgCallbackQuery } from "../telegram";
import { decodeCallback } from "./keyboard";
import { loadSession } from "./session";
import { isAllowed } from "../matrix";
import { SESSION_EXPIRED, UNSUPPORTED_HTML } from "../messages";

/** Handles a target-format button press. Conversion pipeline is wired up in Task 1. */
export async function handleCallback(env: Env, tg: Telegram, cq: TgCallbackQuery): Promise<void> {
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
  await tg.answerCallback(cq.id, "This conversion is not implemented yet.");
}
