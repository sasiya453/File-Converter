// Smoke test for the converter's async job API (POST /jobs) and GET /health.
//
// Real mode (against a deployed Space and a real Telegram chat):
//   CONVERTER_URL=https://<user>-<space>.hf.space CONVERTER_TOKEN=... BOT_TOKEN=... CHAT_ID=<your chat id> \
//     npx tsx ../scripts/smoke-test.ts                      (run from converter/ or worker/)
//   1. GET /health
//   2. uploads the fixture to CHAT_ID with sendDocument (so it gets a real api.telegram.org file URL),
//   3. sends a "⏳ Converting…" status message, 4. POST /jobs (expects 202),
//   5. polls /health until the queue is idle. Then check the chat: the converted file must arrive
//      and the status message must be gone.
//   Get CHAT_ID by messaging the bot and opening https://api.telegram.org/bot<TOKEN>/getUpdates
//   (only while the webhook is not set), or use @userinfobot.
//
// Fake mode (no network, no secrets; CI-friendly):
//   npx tsx ../scripts/smoke-test.ts --fake                 (run from converter/ or worker/)
//   Starts a fake Telegram Bot API + file server, spawns the converter from converter/src with
//   TELEGRAM_API_BASE / ALLOWED_URL_PREFIXES pointing at them, and asserts the whole flow.
//   Against an already running converter (e.g. the Docker image), add --external=<url>; the fake servers
//   then listen on FAKE_TG_PORT (18081) / FAKE_FILE_PORT (18082) and the converter must be started with
//   CONVERTER_TOKEN=smoke-token BOT_TOKEN=123456:SMOKE_fake_token TELEGRAM_API_BASE=http://127.0.0.1:18081
//   ALLOWED_URL_PREFIXES=http://127.0.0.1:18082/file/  (e.g. `docker run --network host -e ...`).
//
// Options (env): FIXTURE (default converter/tests/fixtures/sample.torrent), FROM (torrent), TO (txt),
//   SECTION (document), METHOD (sendDocument), EXT (= TO). The default torrent -> txt needs no tools.
// Secrets are never printed (file URLs contain the bot token and are redacted).
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const FAKE = process.argv.includes("--fake");
const EXTERNAL = process.argv.find((a) => a.startsWith("--external="))?.slice("--external=".length).replace(/\/$/, "");
const FIXTURE = resolve(env.FIXTURE ?? join(ROOT, "converter/tests/fixtures/sample.torrent"));
const FROM = env.FROM ?? "torrent";
const TO = env.TO ?? "txt";
const SECTION = env.SECTION ?? "document";
const METHOD = env.METHOD ?? "sendDocument";
const EXT = env.EXT ?? TO;

const redact = (s: string) => s.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
const log = (...a: unknown[]) => console.log(...a.map((x) => redact(typeof x === "string" ? x : JSON.stringify(x))));
function fail(msg: string): never { console.error("FAIL:", redact(msg)); process.exit(1); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function health(base: string): Promise<{ ok: boolean; queued: number; running: number; uptimeSec?: number }> {
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { fail(`/health returned non-JSON (HTTP ${res.status}); is the Space still starting? ${text.slice(0, 120)}`); }
}

async function waitHealthy(base: string, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { const h = await health(base); if (h.ok) return h; } catch { /* starting / waking up */ }
    await sleep(i < 5 ? 500 : 3000);
  }
  fail(`${base}/health never became ok`);
}

async function waitIdle(base: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await health(base);
    if (h.queued === 0 && h.running === 0) return h;
    await sleep(1000);
  }
  fail("the job did not finish in time");
}

async function postJob(base: string, token: string, job: Record<string, unknown>) {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(job),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  return { status: res.status, body };
}

function jobPayload(fileUrl: string, chatId: number, statusMessageId: number, replyTo?: number) {
  return {
    jobId: `smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    fileUrl, from: FROM, to: TO, section: SECTION, options: {},
    chatId, statusMessageId, replyToMessageId: replyTo, originalName: basename(FIXTURE),
    delivery: { method: METHOD, ext: EXT },
  };
}

// ---------------------------------------------------------------- real mode
async function realMode() {
  const { CONVERTER_URL, CONVERTER_TOKEN, BOT_TOKEN, CHAT_ID } = env;
  if (!CONVERTER_URL || !CONVERTER_TOKEN || !BOT_TOKEN || !CHAT_ID) {
    fail("set CONVERTER_URL, CONVERTER_TOKEN, BOT_TOKEN and CHAT_ID (or use --fake)");
  }
  const base = CONVERTER_URL.replace(/\/$/, "");
  const chatId = Number(CHAT_ID);
  if (!Number.isSafeInteger(chatId)) fail("CHAT_ID must be an integer");
  const tg = async <T>(method: string, body: FormData | Record<string, unknown>): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json() as { ok: boolean; result: T; description?: string };
    if (!data.ok) fail(`Telegram ${method}: ${data.description}`);
    return data.result;
  };

  log("1) GET /health (wakes a sleeping Space; may take a minute)…");
  log("   ", await waitHealthy(base, 40));

  log("2) uploading the fixture to the chat…");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", "smoke-test input");
  form.set("document", new Blob([await readFile(FIXTURE)]), basename(FIXTURE));
  const sent = await tg<{ message_id: number; document: { file_id: string } }>("sendDocument", form);
  const file = await tg<{ file_path: string }>("getFile", { file_id: sent.document.file_id });
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  log("3) sending the status message…");
  const status = await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: "⏳ Converting… (smoke test)" });

  log("4) POST /jobs…");
  const r = await postJob(base, CONVERTER_TOKEN, jobPayload(fileUrl, chatId, status.message_id, sent.message_id));
  log(`   HTTP ${r.status} ${r.body}`);
  if (r.status !== 202) fail(`expected 202 from /jobs, got ${r.status}`);

  log("5) waiting for the queue to drain…");
  log("   ", await waitIdle(base, 6 * 60_000));
  log(`OK. Check chat ${chatId}: the ${EXT} file must be a reply to the input, and the status message must be deleted.`);
}

// ---------------------------------------------------------------- fake mode
async function fakeMode() {
  const BOT = "123456:SMOKE_fake_token";
  const TOKEN = "smoke-token";
  const calls: { method: string; fields: Record<string, string>; file?: { name: string; size: number } }[] = [];
  const fixture = await readFile(FIXTURE);

  const tg: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    if (!m || m[1] !== BOT) { res.writeHead(404); res.end('{"ok":false}'); return; }
    const call: (typeof calls)[number] = { method: m[2]!, fields: {} };
    const ct = req.headers["content-type"] ?? "";
    if (ct.startsWith("multipart/form-data")) {
      const fd = await new Request("http://x/", { method: "POST", headers: { "content-type": ct }, body }).formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") call.fields[k] = v; else call.file = { name: v.name, size: v.size };
      }
    } else {
      for (const [k, v] of Object.entries(JSON.parse(body.toString() || "{}"))) call.fields[k] = String(v);
    }
    calls.push(call);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 777 } }));
  }).listen(EXTERNAL ? Number(env.FAKE_TG_PORT ?? 18081) : 0, "127.0.0.1");
  const files: Server = createServer((_req, res) => { res.end(fixture); })
    .listen(EXTERNAL ? Number(env.FAKE_FILE_PORT ?? 18082) : 0, "127.0.0.1");
  await Promise.all([tg, files].map((s) => new Promise((r) => s.listening ? r(null) : s.once("listening", r))));
  const tgBase = `http://127.0.0.1:${(tg.address() as AddressInfo).port}`;
  const fileBase = `http://127.0.0.1:${(files.address() as AddressInfo).port}/file/`;

  const port = 17000 + Math.floor(Math.random() * 2000);
  const base = EXTERNAL ?? `http://127.0.0.1:${port}`;
  const child: ChildProcess | undefined = EXTERNAL ? undefined : spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    cwd: join(ROOT, "converter"),
    env: {
      ...env, PORT: String(port), CONVERTER_TOKEN: TOKEN, BOT_TOKEN: BOT, TELEGRAM_API_BASE: tgBase,
      ALLOWED_URL_PREFIXES: fileBase, MIN_FREE_DISK_MB: "0", WORK_ROOT: join(env.TMPDIR ?? "/tmp", "smoke-work"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childLog: string[] = [];
  child?.stdout!.on("data", (d) => childLog.push(String(d)));
  child?.stderr!.on("data", (d) => childLog.push(String(d)));
  const cleanup = () => { child?.kill("SIGTERM"); tg.close(); files.close(); };
  try {
    log("1) GET /health…");
    const h = await waitHealthy(base);
    log("   ", h);
    if (JSON.stringify(Object.keys(h).sort()) !== JSON.stringify(["ok", "queued", "running", "uptimeSec"])) fail("unexpected /health keys");

    log("2) POST /jobs without a token → 401…");
    const unauth = await fetch(`${base}/jobs`, { method: "POST", body: "{}" });
    if (unauth.status !== 401) fail(`expected 401, got ${unauth.status}`);

    log("3) POST /jobs…");
    const job = jobPayload(`${fileBase}bot${BOT}/documents/file_1.${FROM}`, 4242, 55, 54);
    const r = await postJob(base, TOKEN, job);
    log(`   HTTP ${r.status} ${r.body}`);
    if (r.status !== 202) fail(`expected 202, got ${r.status}`);

    log("4) same jobId again → ignored (idempotent)…");
    const dup = await postJob(base, TOKEN, job);
    if (dup.status !== 202 || !/duplicate/.test(dup.body)) fail(`expected a 202 duplicate, got ${dup.status} ${dup.body}`);

    log("5) waiting for delivery…");
    await waitIdle(base, 120_000);
    const upload = calls.find((c) => c.method === METHOD);
    if (!upload?.file) fail(`no ${METHOD} upload; calls: ${JSON.stringify(calls.map((c) => c.method))}; log: ${childLog.join("")}`);
    log(`   ${METHOD}: ${upload.file.name} (${upload.file.size} bytes), reply_parameters ${upload.fields.reply_parameters ?? "-"}`);
    if (!/"message_id":54/.test(upload.fields.reply_parameters ?? "")) fail("the result is not a reply to the user's file message");
    if (!upload.file.name.endsWith(`.${EXT}`) && !upload.file.name.endsWith(".zip")) fail(`unexpected file name ${upload.file.name}`);
    if (!calls.some((c) => c.method === "deleteMessage" && c.fields.message_id === "55")) fail("the status message was not deleted");
    if (calls.filter((c) => c.method === METHOD).length !== 1) fail("the duplicate job was delivered twice");
    if (childLog.join("").includes(BOT)) fail("the bot token appeared in the converter logs");
    if (EXTERNAL) log("(external converter: check its logs for the token yourself, e.g. docker logs <name> | grep SMOKE_fake_token)");
    log("OK: health, auth, 202, idempotency, delivery, status message deleted, token not logged.");
  } finally {
    cleanup();
  }
}

await (FAKE || EXTERNAL ? fakeMode() : realMode());
