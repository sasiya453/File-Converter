// Minimal Telegram Bot API client for delivering job results straight from the converter.
// The bot token is only ever placed in the request URL and is never logged.
import { openAsBlob } from "node:fs";

export type SendMethod = "sendDocument" | "sendPhoto" | "sendVideo" | "sendVideoNote" | "sendVoice" | "sendAudio";

/** Multipart field name for each upload method. */
export const METHOD_FIELD: Record<SendMethod, string> = {
  sendDocument: "document",
  sendPhoto: "photo",
  sendVideo: "video",
  sendVideoNote: "video_note",
  sendVoice: "voice",
  sendAudio: "audio",
};
export const SEND_METHODS = Object.keys(METHOD_FIELD) as SendMethod[];

/** Telegram's upload limit for bots (multipart). */
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(public method: string, public status: number, public description: string) {
    super(`Telegram ${method} failed (${status}): ${description}`);
  }
}

/** Replace any bot token in a string (e.g. a Telegram file URL) with a placeholder. */
export function redact(s: string): string {
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

export class TelegramClient {
  constructor(
    private token: string,
    private apiBase = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
    private timeoutMs = 120_000,
  ) {}

  private url(method: string) { return `${this.apiBase.replace(/\/$/, "")}/bot${this.token}/${method}`; }

  private async parse<T>(method: string, res: Response): Promise<T> {
    let data: { ok?: boolean; result?: T; description?: string } = {};
    try { data = (await res.json()) as typeof data; } catch { /* non-JSON */ }
    if (!res.ok || !data.ok) throw new TelegramError(method, res.status, redact(data.description ?? `HTTP ${res.status}`));
    return data.result as T;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse<T>(method, res);
  }

  /**
   * Upload a file from disk. `fs.openAsBlob` gives a disk-backed Blob, so FormData
   * streams it from the file instead of buffering the whole result in memory.
   */
  async upload<T = unknown>(method: SendMethod, path: string, filename: string, contentType: string,
    params: Record<string, string | number | boolean>): Promise<T> {
    const blob = await openAsBlob(path, { type: contentType });
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append(METHOD_FIELD[method], blob, filename);
    const res = await fetch(this.url(method), { method: "POST", body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    return this.parse<T>(method, res);
  }

  editMessageText(chatId: number, messageId: number, text: string) {
    return this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true,
    });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
}
