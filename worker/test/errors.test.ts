import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { submitErrorMessage } from "../src/flow/callback";
import { ConverterError } from "../src/converter";
import { HttpConverterClient } from "../src/converter/http";
import { CONVERSION_FAILED, CONVERSION_TIMEOUT, INVALID_INPUT, RESULT_TOO_LARGE, UNSUPPORTED_HTML } from "../src/messages";
import { ERROR_TEXT } from "../src/shared/job-messages";

// The sync /convert client is kept for local testing / fallback.
const client = (status: number) => new HttpConverterClient("https://conv.example", "tok", 5_000,
  (async () => new Response("err", { status })) as unknown as typeof fetch);

describe("sync converter errors -> user messages", () => {
  for (const [status, msg] of [[504, CONVERSION_TIMEOUT], [413, RESULT_TOO_LARGE], [400, UNSUPPORTED_HTML],
    [422, INVALID_INPUT], [500, CONVERSION_FAILED], [401, CONVERSION_FAILED]] as const) {
    it(`HTTP ${status}`, async () => {
      const e = await client(status).convert({ fileUrl: "u", from: "pdf", to: "docx" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConverterError);
      expect(submitErrorMessage(e)).toBe(msg);
    });
  }
  it("network failure is a generic failure", async () => {
    const c = new HttpConverterClient("https://conv.example", "tok", 5_000, (async () => { throw new TypeError("boom"); }) as unknown as typeof fetch);
    expect(submitErrorMessage(await c.convert({ fileUrl: "u", from: "pdf", to: "docx" }).catch((x: unknown) => x))).toBe(CONVERSION_FAILED);
  });
});

describe("shared job messages", () => {
  it("the worker and converter copies are byte-identical", () => {
    const a = readFileSync(fileURLToPath(new URL("../src/shared/job-messages.ts", import.meta.url).href), "utf8");
    const b = readFileSync(fileURLToPath(new URL("../../converter/src/shared/job-messages.ts", import.meta.url).href), "utf8");
    expect(a).toBe(b);
  });
  it("covers every error kind the converter reports", () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual(["failed", "invalid_input", "timeout", "too_large", "unsupported"]);
  });
});
