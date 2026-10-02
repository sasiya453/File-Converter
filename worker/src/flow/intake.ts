import type { Env } from "../env";
import type { Telegram, TgMessage } from "../telegram";
import { targetsFor, isKnownSource } from "../matrix";
import { extractFile, sniffMagic } from "./detect";
import { buildKeyboard } from "./keyboard";
import { saveSession } from "./session";
import { NO_FILE_HTML, TOO_LARGE_HTML, UNSUPPORTED_HTML, WELCOME_HTML } from "../messages";

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

async function sniffRemote(tg: Telegram, fileId: string): Promise<string | undefined> {
  const { url } = await tg.getFileUrl(fileId);
  const res = await fetch(url, { headers: { range: "bytes=0-511" } });
  if (!res.ok && res.status !== 206) return undefined;
  const buf = new Uint8Array(await res.arrayBuffer()).slice(0, 512);
  return sniffMagic(buf);
}

function isMenuCommand(text: string): boolean {
  const cmd = text.trim().split(/[\s@]/)[0]?.toLowerCase();
  return cmd === "/start" || cmd === "/menu" || cmd === "/help" || text.trim().toLowerCase() === "menu";
}

export async function handleMessage(env: Env, tg: Telegram, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  if (msg.text !== undefined) {
    await tg.sendMessage(chatId, isMenuCommand(msg.text) ? WELCOME_HTML : NO_FILE_HTML);
    return;
  }
  const file = extractFile(msg);
  if (!file) {
    await tg.sendMessage(chatId, NO_FILE_HTML);
    return;
  }
  if (file.fileSize !== undefined && file.fileSize > MAX_DOWNLOAD_BYTES) {
    await tg.sendMessage(chatId, TOO_LARGE_HTML, { reply_to_message_id: msg.message_id });
    return;
  }
  let source = file.ext;
  if (!source || !isKnownSource(source)) {
    try {
      const sniffed = await sniffRemote(tg, file.fileId);
      if (sniffed && isKnownSource(sniffed)) source = sniffed;
    } catch (e) {
      console.warn("sniff failed", String(e));
    }
  }
  if (!source || !isKnownSource(source)) {
    await tg.sendMessage(chatId, UNSUPPORTED_HTML, { reply_to_message_id: msg.message_id });
    return;
  }
  const groups = targetsFor(source);
  await saveSession(env.SESSIONS, chatId, {
    fileId: file.fileId, fileName: file.fileName, source, fileSize: file.fileSize, messageId: msg.message_id,
    sections: groups.map((g) => g.section), createdAt: Date.now(),
  });
  await tg.sendMessage(chatId, `Detected <b>${source.toUpperCase()}</b>. Convert to:`, {
    reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: buildKeyboard(groups) },
  });
}
