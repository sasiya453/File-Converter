// Task H1: async job API (POST /jobs) with a fake Telegram Bot API server.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { readFile, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { register } from "../src/registry.js";
import { HttpError } from "../src/types.js";
import { TelegramClient, redact } from "../src/telegram.js";
import { validateJob, outputName } from "../src/server/jobs.js";
import { ERROR_TEXT, JOB_EXPIRED } from "../src/shared/job-messages.js";
import { createApp } from "../src/server/index.js";

process.env.CONVERTER_TOKEN = "jobs-token";
const BOT = "123456:SECRET_bot_token-xyz";

interface TgCall { method: string; fields: Record<string, string>; file?: { field: string; name: string; size: number; type: string } }
let calls: TgCall[] = [];
let tgServer: Server, fileServer: Server, tgBase = "", fileBase = "";
let failUploads = false;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function waitFor(pred: (c: TgCall) => boolean, timeoutMs = 5000): Promise<TgCall> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const c = calls.find(pred);
      if (c) return resolve(c);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout; calls: ${JSON.stringify(calls.map((c) => [c.method, c.fields.text ?? ""]))}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

before(async () => {
  tgServer = createServer(async (req, res) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const body = await readBody(req);
    if (!m || m[1] !== BOT) { res.writeHead(404); res.end(JSON.stringify({ ok: false, description: "Not Found" })); return; }
    const method = m[2]!;
    const call: TgCall = { method, fields: {} };
    const ct = req.headers["content-type"] ?? "";
    if (ct.startsWith("multipart/form-data")) {
      const form = await new Request("http://x/", { method: "POST", headers: { "content-type": ct }, body }).formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") call.fields[k] = v;
        else call.file = { field: k, name: v.name, size: v.size, type: v.type };
      }
    } else {
      for (const [k, v] of Object.entries(JSON.parse(body.toString() || "{}"))) call.fields[k] = String(v);
    }
    calls.push(call);
    res.writeHead(200, { "content-type": "application/json" });
    if (failUploads && call.file) { res.end(JSON.stringify({ ok: false, description: "Bad Request: something" })); return; }
    res.end(JSON.stringify({ ok: true, result: { message_id: 999 } }));
  }).listen(0);
  fileServer = createServer((req, res) => {
    if ((req.url ?? "").includes("missing")) { res.writeHead(404); res.end(); return; }
    res.end("hello world");
  }).listen(0);
  tgBase = `http://127.0.0.1:${(tgServer.address() as AddressInfo).port}`;
  fileBase = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}/`;
  process.env.ALLOWED_URL_PREFIXES = fileBase;

  register("jtxt", "jout", async (ctx) => {
    const out = join(ctx.workDir, "out.jout");
    await writeFile(out, (await readFile(ctx.input, "utf8")).toUpperCase());
    return { path: out, contentType: "text/plain", filename: "converted.jout" };
  });
  register("jtxt", "jzip", async (ctx) => {
    const out = join(ctx.workDir, "out.zip");
    await writeFile(out, "PK\u0003\u0004");
    return { path: out, contentType: "application/zip", filename: "converted.zip" };
  });
  register("jtxt", "jbig", async (ctx) => {
    const out = join(ctx.workDir, "big.bin");
    await writeFile(out, "");
    await truncate(out, 51 * 1024 * 1024); // sparse 51 MB file
    return { path: out, contentType: "application/octet-stream", filename: "big.bin" };
  });
  for (const [to, status] of [["junsup", 400], ["jlarge", 413], ["jtime", 504], ["jinval", 422], ["jfail", 500]] as const) {
    register("jtxt", to, async () => { throw new HttpError(status, `boom ${status}`); });
  }
  register("jtxt", "jslow", async (ctx) => {
    await new Promise((r) => setTimeout(r, Number(ctx.options.ms ?? 300)));
    const out = join(ctx.workDir, "out.txt");
    await writeFile(out, "slow");
    return { path: out, contentType: "text/plain", filename: "converted.txt" };
  });
});
after(() => { tgServer.close(); fileServer.close(); });

let seq = 0;
function job(over: Record<string, unknown> = {}) {
  seq++;
  return {
    jobId: `job_${Date.now()}_${seq}`,
    fileUrl: `${fileBase}file/bot${BOT}/documents/file_${seq}.txt`,
    from: "jtxt", to: "jout", section: "document", options: {},
    chatId: 4242, statusMessageId: 100 + seq, originalName: "My Report.v2.jtxt",
    delivery: { method: "sendDocument", ext: "jout" },
    ...over,
  };
}

function startApp(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ telegram: () => new TelegramClient(BOT, tgBase), ...opts }).listen(0);
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const post = (body: unknown, token = "jobs-token") => fetch(`${base}/jobs`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, base, post };
}

describe("POST /jobs delivery", () => {
  let s: ReturnType<typeof startApp>;
  before(() => { s = startApp(); });
  after(() => s.app.close());

  const cases = [
    { method: "sendDocument", field: "document", ext: "jout" },
    { method: "sendPhoto", field: "photo", ext: "jpg" },
    { method: "sendVideo", field: "video", ext: "mp4" },
    { method: "sendVideoNote", field: "video_note", ext: "mp4" },
    { method: "sendVoice", field: "voice", ext: "ogg" },
  ];
  for (const c of cases) {
    test(`success via ${c.method}`, async () => {
      calls = [];
      const j = job({ delivery: { method: c.method, ext: c.ext }, replyToMessageId: 7 });
      const r = await s.post(j);
      assert.equal(r.status, 202);
      const body = (await r.json()) as { jobId: string; position: number };
      assert.equal(body.jobId, j.jobId);
      assert.equal(typeof body.position, "number");
      const up = await waitFor((x) => x.method === c.method);
      assert.equal(up.file?.field, c.field);
      assert.equal(up.file?.name, `My Report.v2.${c.ext}`);
      assert.equal(up.file?.size, "HELLO WORLD".length);
      assert.equal(up.fields.chat_id, "4242");
      assert.equal(JSON.parse(up.fields.reply_parameters ?? "{}").message_id, 7);
      if (c.method === "sendVideo") assert.equal(up.fields.supports_streaming, "true");
      const del = await waitFor((x) => x.method === "deleteMessage");
      assert.equal(del.fields.message_id, String(j.statusMessageId));
      assert.ok(!calls.some((x) => x.method === "editMessageText"));
    });
  }

  test("a document result that is a ZIP gets the .zip extension", async () => {
    calls = [];
    await s.post(job({ to: "jzip", delivery: { method: "sendDocument", ext: "png" } }));
    const up = await waitFor((x) => x.method === "sendDocument");
    assert.equal(up.file?.name, "My Report.v2.zip");
  });

  const errs: Array<[string, keyof typeof ERROR_TEXT]> = [
    ["junsup", "unsupported"], ["jlarge", "too_large"], ["jtime", "timeout"], ["jinval", "invalid_input"], ["jfail", "failed"], ["jbig", "too_large"],
  ];
  for (const [to, kind] of errs) {
    test(`error ${to} -> status message edited with the ${kind} text`, async () => {
      calls = [];
      const j = job({ to });
      assert.equal((await s.post(j)).status, 202);
      const ed = await waitFor((x) => x.method === "editMessageText");
      assert.equal(ed.fields.text, ERROR_TEXT[kind]);
      assert.equal(ed.fields.message_id, String(j.statusMessageId));
      assert.ok(!calls.some((x) => x.file), "nothing uploaded");
    });
  }

  test("download failure -> failed text", async () => {
    calls = [];
    await s.post(job({ fileUrl: `${fileBase}file/bot${BOT}/missing.txt` }));
    const ed = await waitFor((x) => x.method === "editMessageText");
    assert.equal(ed.fields.text, ERROR_TEXT.failed);
  });

  test("Telegram upload failure -> failed text", async () => {
    calls = [];
    failUploads = true;
    try {
      await s.post(job());
      const ed = await waitFor((x) => x.method === "editMessageText");
      assert.equal(ed.fields.text, ERROR_TEXT.failed);
    } finally { failUploads = false; }
  });

  test("duplicate jobId is ignored", async () => {
    calls = [];
    const j = job();
    const r1 = await s.post(j);
    const r2 = await s.post(j);
    assert.equal(r1.status, 202);
    assert.equal(r2.status, 202);
    assert.equal(((await r2.json()) as { duplicate?: boolean }).duplicate, true);
    await waitFor((x) => x.method === "deleteMessage");
    await s.app.jobs.queue.onIdle();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.filter((x) => x.method === "sendDocument").length, 1);
  });

  test("unsupported conversion -> 422 right away", async () => {
    assert.equal((await s.post(job({ to: "nothere" }))).status, 422);
  });

  test("bot token and file URL are never logged", async () => {
    calls = [];
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      await s.post(job());
      await s.post(job({ to: "jfail" }));
      await s.post(job({ fileUrl: `${fileBase}file/bot${BOT}/missing.txt` }));
      await waitFor((x) => x.method === "deleteMessage");
      await s.app.jobs.queue.onIdle();
    } finally { console.log = orig; }
    const all = logs.join("\n");
    assert.ok(all.includes("job_queued") && all.includes("job_ok") && all.includes("job_fail"), all);
    assert.ok(!all.includes("SECRET_bot_token"), "token leaked in logs");
    assert.ok(!all.includes(fileBase + "file"), "file URL leaked in logs");
    const ok = JSON.parse(logs.find((l) => l.includes('"job_ok"'))!);
    for (const k of ["from", "to", "bytes", "ms", "kind"]) assert.ok(k in ok, `job_ok has ${k}`);
  });
});

describe("POST /jobs validation and auth", () => {
  let s: ReturnType<typeof startApp>;
  before(() => { s = startApp(); });
  after(() => s.app.close());

  test("bad token -> 401", async () => {
    assert.equal((await s.post(job(), "wrong-token")).status, 401);
    assert.equal((await s.post(job(), "")).status, 401);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["chatId not integer", { chatId: "4242" }],
    ["chatId float", { chatId: 1.5 }],
    ["missing statusMessageId", { statusMessageId: undefined }],
    ["bad from", { from: "../etc" }],
    ["bad to", { to: "A B" }],
    ["bad section", { section: "doc;rm" }],
    ["bad jobId", { jobId: "x" }],
    ["SSRF url", { fileUrl: "http://169.254.169.254/latest/meta-data" }],
    ["bad delivery method", { delivery: { method: "sendSticker", ext: "webp" } }],
    ["bad delivery ext", { delivery: { method: "sendDocument", ext: "../x" } }],
    ["bad replyTo", { replyToMessageId: -1 }],
    ["options array", { options: [1] }],
    ["nested option", { options: { a: { b: 1 } } }],
  ];
  for (const [name, over] of invalid) {
    test(`invalid payload: ${name} -> 400`, async () => {
      assert.equal((await s.post(job(over))).status, 400);
    });
  }
  test("non-JSON body -> 400", async () => {
    const r = await fetch(`${s.base}/jobs`, { method: "POST", headers: { authorization: "Bearer jobs-token" }, body: "{nope" });
    assert.equal(r.status, 400);
  });
  test("validateJob forces options.section", () => {
    const v = validateJob(job({ options: { lang: "eng", section: "evil" } }));
    assert.equal(v.options.section, "document");
    assert.equal(v.options.lang, "eng");
  });
  test("health is public and minimal", async () => {
    const r = await fetch(`${s.base}/health`);
    assert.equal(r.status, 200);
    const b = (await r.json()) as Record<string, unknown>;
    assert.equal(b.ok, true);
    assert.equal(typeof b.queued, "number");
    assert.equal(typeof b.running, "number");
  });
});

describe("queue limits", () => {
  test("full queue -> 429", async () => {
    const s = startApp({ concurrency: 1, maxQueue: 1 });
    try {
      calls = [];
      const r1 = await s.post(job({ to: "jslow", options: { ms: 300 } }));
      const r2 = await s.post(job({ to: "jslow", options: { ms: 10 } }));
      const r3 = await s.post(job({ to: "jslow", options: { ms: 10 } }));
      assert.deepEqual([r1.status, r2.status, r3.status], [202, 202, 429]);
      assert.equal(((await r1.json()) as { position: number }).position, 0);
      assert.equal(((await r2.json()) as { position: number }).position, 1);
      const h = (await (await fetch(`${s.base}/health`)).json()) as { queued: number; running: number };
      assert.deepEqual([h.queued, h.running], [1, 1]);
      await s.app.jobs.queue.onIdle();
    } finally { s.app.close(); }
  });

  test("jobs that waited too long are dropped with a polite message", async () => {
    const s = startApp({ concurrency: 1, maxQueue: 5, maxAgeMs: 50 });
    try {
      calls = [];
      await s.post(job({ to: "jslow", options: { ms: 200 } }));
      const late = job();
      await s.post(late);
      const ed = await waitFor((x) => x.method === "editMessageText" && x.fields.message_id === String(late.statusMessageId));
      assert.equal(ed.fields.text, JOB_EXPIRED);
      await s.app.jobs.queue.onIdle();
      // only the slow job (which started right away) was delivered
      assert.equal(calls.filter((x) => x.method === "sendDocument").length, 1);
    } finally { s.app.close(); }
  });
});

test("redact() hides bot tokens", () => {
  assert.equal(redact(`https://api.telegram.org/file/bot${BOT}/x.pdf`), "https://api.telegram.org/file/bot<redacted>/x.pdf");
});
test("outputName", () => {
  assert.equal(outputName("a.b.pdf", "docx"), "a.b.docx");
  assert.equal(outputName("subs.qt.txt", "srt"), "subs.srt");
  assert.ok(!outputName("../../etc/passwd", "txt").includes("/"));
  assert.equal(outputName("a\u0000b\".pdf", "txt"), "a_b_.txt");
  assert.equal(outputName("", "txt"), "file.txt");
});
test("shared job messages are identical in worker and converter", async () => {
  const a = await readFile(new URL("../src/shared/job-messages.ts", import.meta.url), "utf8");
  const b = await readFile(new URL("../../worker/src/shared/job-messages.ts", import.meta.url), "utf8");
  assert.equal(a, b);
});
