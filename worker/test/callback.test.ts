import { describe, it, expect } from "vitest";
import { handleCallback, outputName, resultExt } from "../src/flow/callback";
import { Telegram } from "../src/telegram";
import { ConverterError, type ConverterClient } from "../src/converter";
import type { Env } from "../src/env";
import { CONVERSION_TIMEOUT, CONVERTING, RATE_LIMITED } from "../src/messages";

function fakeKV(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); } } as unknown as KVNamespace;
}
const session = JSON.stringify({ fileId: "F1", fileName: "report.pdf", source: "pdf", sections: ["document"], createdAt: 0 });

function setup(converter: ConverterClient, limit = "5") {
  const calls: { method: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = init.body instanceof FormData ? init.body : JSON.parse(String(init.body));
    calls.push({ method, body });
    const result = method === "getFile" ? { file_path: "documents/file_1.pdf" }
      : method === "sendMessage" ? { message_id: 77, chat: { id: 1, type: "private" } } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const env = { SESSIONS: fakeKV({ "session:1": session }), BOT_TOKEN: "T", RATE_LIMIT_PER_MIN: limit } as unknown as Env;
  return { env, tg: new Telegram("T", fetchImpl), calls };
}
const cq = (data: string) => ({ id: "q", from: { id: 9 }, data, message: { message_id: 5, chat: { id: 1, type: "private" } } });

describe("callback pipeline", () => {
  it("pdf -> docx: converts and sends document, deletes status", async () => {
    let req: unknown;
    const conv: ConverterClient = { convert: async (r) => { req = r; return { body: new Blob(["x"]), contentType: "x" }; } };
    const { env, tg, calls } = setup(conv);
    await handleCallback(env, tg, cq("c|document|docx"), conv);
    expect(req).toEqual({ fileUrl: "https://api.telegram.org/file/botT/documents/file_1.pdf", from: "pdf", to: "docx", options: { section: "document" } });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage", "getFile", "sendDocument", "deleteMessage"]);
    expect((calls[1]!.body as { text: string }).text).toBe(CONVERTING);
    const form = calls[3]!.body as FormData;
    expect(form.get("chat_id")).toBe("1");
    expect((form.get("document") as unknown as File).name).toBe("report.docx");
  });
  it("maps converter timeout to a user message", async () => {
    const conv: ConverterClient = { convert: async () => { throw new ConverterError("t", "timeout"); } };
    const { env, tg, calls } = setup(conv);
    await handleCallback(env, tg, cq("c|document|docx"), conv);
    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => (c.body as { text: string }).text);
    expect(texts).toEqual([CONVERTING, CONVERSION_TIMEOUT]);
    expect(calls.at(-1)!.method).toBe("deleteMessage");
  });
  it("rejects ✗ targets and rate-limits", async () => {
    const conv: ConverterClient = { convert: async () => { throw new Error("should not run"); } };
    const s1 = setup(conv);
    await handleCallback(s1.env, s1.tg, cq("c|document|pdf"), conv); // diagonal is ✗
    expect(s1.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    const s2 = setup(conv, "0");
    await handleCallback(s2.env, s2.tg, cq("c|document|docx"), conv);
    expect((s2.calls[0]!.body as { text: string }).text).toBe(RATE_LIMITED);
  });
  it("outputName", () => {
    expect(outputName("a.b.pdf", "docx")).toBe("a.b.docx");
    expect(outputName("subs.qt.txt", "srt")).toBe("subs.srt");
    expect(outputName("", "txt")).toBe("file.txt");
  });
  it("resultExt switches to zip for multi-page image results", () => {
    expect(resultExt("png", "sendDocument", { contentType: "application/zip", filename: "converted.zip" })).toBe("zip");
    expect(resultExt("png", "sendDocument", { contentType: "image/png" })).toBe("png");
    expect(resultExt("oeb.zip", "sendDocument", { contentType: "application/zip" })).toBe("oeb.zip");
    expect(resultExt("jpg", "sendPhoto", { contentType: "application/zip" })).toBe("jpg");
  });
});
