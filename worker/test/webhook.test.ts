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
