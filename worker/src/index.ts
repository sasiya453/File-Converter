import type { Env } from "./env";
import { Telegram, type TgUpdate } from "./telegram";
import { handleMessage } from "./flow/intake";
import { handleCallback } from "./flow/callback";

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function processUpdate(env: Env, update: TgUpdate): Promise<void> {
  const tg = new Telegram(env.BOT_TOKEN);
  try {
    if (update.message) await handleMessage(env, tg, update.message);
    else if (update.callback_query) await handleCallback(env, tg, update.callback_query);
  } catch (e) {
    console.error("update failed", update.update_id, e instanceof Error ? e.stack : String(e));
  }
}

/**
 * Cron keep-alive: GET {CONVERTER_URL}/health so the free HF Space does not go to sleep
 * (it sleeps after ~48 h without traffic). Never throws.
 */
export async function keepAlive(env: Env, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status?: number }> {
  if (!env.CONVERTER_URL) return { ok: false };
  const started = Date.now();
  try {
    const res = await fetchImpl(`${env.CONVERTER_URL.replace(/\/$/, "")}/health`, {
      headers: { "user-agent": "file-converter-bot-keepalive" },
      signal: AbortSignal.timeout(25_000),
    });
    const body = await res.text().catch(() => "");
    console.log(JSON.stringify({ evt: "keepalive", status: res.status, ms: Date.now() - started, body: body.slice(0, 120) }));
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.warn(JSON.stringify({ evt: "keepalive_fail", ms: Date.now() - started, err: e instanceof Error ? e.name : "error" }));
    return { ok: false };
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (!url.pathname.startsWith("/webhook/")) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const pathSecret = url.pathname.slice("/webhook/".length);
    const headerSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!env.WEBHOOK_SECRET || !safeEqual(pathSecret, env.WEBHOOK_SECRET) || !safeEqual(headerSecret, env.WEBHOOK_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }
    let update: TgUpdate;
    try {
      update = (await req.json()) as TgUpdate;
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    // Ack immediately. waitUntil only does short Telegram/KV calls and one POST /jobs
    // (the converter delivers the result itself), so it fits the ~30 s budget.
    ctx.waitUntil(processUpdate(env, update));
    return new Response("ok");
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(keepAlive(env));
  },
} satisfies ExportedHandler<Env>;
