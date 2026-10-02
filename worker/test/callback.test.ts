import { describe, it, expect } from "vitest";
import { handleCallback, jobIdFor, submitErrorMessage } from "../src/flow/callback";
import { Telegram } from "../src/telegram";
import { ConverterError, type ConverterClient, type JobRequest } from "../src/converter";
import type { Env } from "../src/env";
import {
  CONVERTER_BUSY, CONVERTER_UNAVAILABLE, CONVERTER_WAKING, CONVERTING, RATE_LIMITED, SESSION_EXPIRED, UNSUPPORTED_HTML,
  CONVERSION_FAILED,
} from "../src/messages";

function fakeKV(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { map: m, kv: { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); } } as unknown as KVNamespace };
}
const session = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ fileId: "F1", fileName: "report.pdf", source: "pdf", sections: ["document"], createdAt: 0, messageId: 41, ...extra });

function setup(opts: { limit?: string; session?: string | null } = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    const result = method === "getFile" ? { file_path: "documents/file_1.pdf" }
      : method === "sendMessage" ? { message_id: 77, chat: { id: 1, type: "private" } } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const store = fakeKV(opts.session === null ? {} : { "session:1": opts.session ?? session() });
  const env = { SESSIONS: store.kv, BOT_TOKEN: "123:ABC", RATE_LIMIT_PER_MIN: opts.limit ?? "5" } as unknown as Env;
  return { env, kv: store.map, tg: new Telegram("123:ABC", fetchImpl), calls };
}
const cq = (data: string, id = "4242424242") =>
  ({ id, from: { id: 9 }, data, message: { message_id: 5, chat: { id: 1, type: "private" } } });

function fakeConverter(impl: ConverterClient["submitJob"]) {
  const jobs: JobRequest[] = [];
  const conv: ConverterClient = {
    submitJob: async (job, hooks) => { jobs.push(job); return impl(job, hooks); },
    convert: async () => { throw new Error("sync convert must not be used by the bot flow"); },
  };
  return { conv, jobs };
}

describe("callback → async job", () => {
  it("pdf -> docx: submits one job with the full payload and does not wait for a result", async () => {
    const { conv, jobs } = fakeConverter(async (j) => ({ jobId: j.jobId, position: 0 }));
    const { env, tg, calls, kv } = setup();
    await handleCallback(env, tg, cq("c|document|docx"), conv);
    expect(jobs).toEqual([{
      jobId: "cq_4242424242", fileUrl: "https://api.telegram.org/file/bot123:ABC/documents/file_1.pdf", from: "pdf",
      to: "docx", section: "document", options: { section: "document" }, chatId: 1, statusMessageId: 77,
      replyToMessageId: 41, originalName: "report.pdf", delivery: { method: "sendDocument", ext: "docx" },
    }]);
    // No upload and no delete in the Worker any more: the converter does that.
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage", "getFile"]);
    expect(calls[1]!.body.text).toBe(CONVERTING);
    expect(kv.has("job:cq_4242424242")).toBe(true);
  });

  it("passes the special delivery methods from matrix/delivery.ts", async () => {
    const { conv, jobs } = fakeConverter(async (j) => ({ jobId: j.jobId, position: 1 }));
    const s = setup({ session: session({ source: "mp4", fileName: "clip.mp4", sections: ["video"] }) });
    await handleCallback(s.env, s.tg, cq("c|video|stream", "q1aaaaaaa"), conv);
    await handleCallback(s.env, s.tg, cq("c|video|videonote", "q2aaaaaaa"), conv);
    await handleCallback(s.env, s.tg, cq("c|video|audionote", "q3aaaaaaa"), conv);
    expect(jobs.map((j) => j.delivery)).toEqual([
      { method: "sendVideo", ext: "mp4" }, { method: "sendVideoNote", ext: "mp4" }, { method: "sendVoice", ext: "ogg" },
    ]);
  });

  it("shows the waking-up message while the Space starts", async () => {
    const { conv } = fakeConverter(async (j, hooks) => { await hooks?.onWaking?.(); return { jobId: j.jobId, position: 0 }; });
    const { env, tg, calls } = setup();
    await handleCallback(env, tg, cq("c|document|docx"), conv);
    const edit = calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body).toMatchObject({ chat_id: 1, message_id: 77, text: CONVERTER_WAKING });
  });

  for (const [kind, text] of [["busy", CONVERTER_BUSY], ["unavailable", CONVERTER_UNAVAILABLE],
    ["unsupported", UNSUPPORTED_HTML], ["failed", CONVERSION_FAILED]] as const) {
    it(`submit error "${kind}" edits the status message and allows a retry`, async () => {
      const { conv } = fakeConverter(async () => { throw new ConverterError("x", kind); });
      const { env, tg, calls, kv } = setup();
      await handleCallback(env, tg, cq("c|document|docx"), conv);
      const edit = calls.find((c) => c.method === "editMessageText")!;
      expect(edit.body).toMatchObject({ message_id: 77, text });
      expect(kv.has("job:cq_4242424242")).toBe(false);
    });
  }

  it("a retried webhook (same callback id) does not submit twice", async () => {
    const { conv, jobs } = fakeConverter(async (j) => ({ jobId: j.jobId, position: 0 }));
    const { env, tg, calls } = setup();
    await handleCallback(env, tg, cq("c|document|docx"), conv);
    await handleCallback(env, tg, cq("c|document|docx"), conv);
    expect(jobs).toHaveLength(1);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("rejects ✗ targets, expired sessions and rate-limits without submitting", async () => {
    const { conv, jobs } = fakeConverter(async () => { throw new Error("should not run"); });
    const s1 = setup();
    await handleCallback(s1.env, s1.tg, cq("c|document|pdf"), conv); // diagonal is ✗
    expect(s1.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    const s2 = setup({ limit: "0" });
    await handleCallback(s2.env, s2.tg, cq("c|document|docx"), conv);
    expect(s2.calls[0]!.body.text).toBe(RATE_LIMITED);
    const s3 = setup({ session: null });
    await handleCallback(s3.env, s3.tg, cq("c|document|docx"), conv);
    expect(s3.calls[0]!.body.text).toBe(SESSION_EXPIRED);
    expect(jobs).toHaveLength(0);
  });

  it("jobIdFor gives a converter-valid id", () => {
    expect(jobIdFor(cq("x", "123"))).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(jobIdFor(cq("x", "9".repeat(100)))).toHaveLength(64);
    expect(submitErrorMessage(new Error("x"))).toBe(CONVERSION_FAILED);
  });
});
