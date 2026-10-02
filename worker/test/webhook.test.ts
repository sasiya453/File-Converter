import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const env = { WEBHOOK_SECRET: "s3cret", BOT_TOKEN: "x", CONVERTER_URL: "", CONVERTER_TOKEN: "" } as unknown as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const post = (path: string, header?: string) => new Request(`https://w.dev${path}`, {
  method: "POST", body: JSON.stringify({ update_id: 1 }),
  headers: header ? { "x-telegram-bot-api-secret-token": header } : {},
});

describe("webhook auth", () => {
  it("rejects wrong path secret", async () => {
    expect((await worker.fetch(post("/webhook/nope", "s3cret"), env, ctx)).status).toBe(403);
  });
  it("rejects missing header", async () => {
    expect((await worker.fetch(post("/webhook/s3cret"), env, ctx)).status).toBe(403);
  });
  it("accepts valid request immediately", async () => {
    expect((await worker.fetch(post("/webhook/s3cret", "s3cret"), env, ctx)).status).toBe(200);
  });
});

import { keepAlive } from "../src/index";

describe("cron keep-alive", () => {
  it("GETs {CONVERTER_URL}/health", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response('{"ok":true}'); }) as unknown as typeof fetch;
    const r = await keepAlive({ ...env, CONVERTER_URL: "https://u-s.hf.space/" } as Env, f);
    expect(r).toEqual({ ok: true, status: 200 });
    expect(urls).toEqual(["https://u-s.hf.space/health"]);
  });
  it("never throws", async () => {
    const f = (async () => { throw new TypeError("down"); }) as unknown as typeof fetch;
    expect((await keepAlive({ ...env, CONVERTER_URL: "https://x" } as Env, f)).ok).toBe(false);
    expect((await keepAlive(env)).ok).toBe(false);
  });
  it("scheduled() schedules the ping with waitUntil", async () => {
    const waits: Promise<unknown>[] = [];
    const c = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    await worker.scheduled!({} as ScheduledController, env, c);
    expect(waits).toHaveLength(1);
    await waits[0];
  });
});
