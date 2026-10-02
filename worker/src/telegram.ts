// Minimal Telegram Bot API client (fetch only, no deps).
export interface TgUser { id: number; first_name?: string; username?: string }
export interface TgChat { id: number; type: string }
export interface TgFileBase { file_id: string; file_unique_id: string; file_size?: number }
export interface TgDocument extends TgFileBase { file_name?: string; mime_type?: string }
export interface TgSticker extends TgFileBase { is_animated?: boolean; is_video?: boolean }
export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  document?: TgDocument;
  photo?: TgFileBase[];
  video?: TgDocument;
  audio?: TgDocument;
  voice?: TgDocument;
  video_note?: TgFileBase;
  animation?: TgDocument;
  sticker?: TgSticker;
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }
export interface InlineKeyboardButton { text: string; callback_data: string }
export type InlineKeyboard = InlineKeyboardButton[][];

export class TelegramApiError extends Error {
  constructor(public method: string, public status: number, public description: string) {
    super(`Telegram ${method} failed (${status}): ${description}`);
  }
}

export class Telegram {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new TelegramApiError(method, res.status, data.description ?? "unknown");
    return data.result;
  }

  /** Multipart upload (sendDocument/sendPhoto/sendVideo/...). */
  async upload<T = unknown>(method: string, field: string, file: Blob, filename: string,
    params: Record<string, string | number | boolean>): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append(field, file, filename);
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      body: form,
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new TelegramApiError(method, res.status, data.description ?? "unknown");
    return data.result;
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra,
    });
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async getFileUrl(fileId: string): Promise<{ url: string; path: string; size?: number }> {
    const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!f.file_path) throw new Error("getFile returned no file_path");
    return { url: `https://api.telegram.org/file/bot${this.token}/${f.file_path}`, path: f.file_path, size: f.file_size };
  }
}
