import { describe, it, expect } from "vitest";
import { errorMessage } from "../src/flow/callback";
import { ConverterError } from "../src/converter";
import { HttpConverterClient } from "../src/converter/http";
import { CONVERSION_FAILED, CONVERSION_TIMEOUT, INVALID_INPUT, RESULT_TOO_LARGE, UNSUPPORTED_HTML } from "../src/messages";

const client = (status: number) => new HttpConverterClient("https://conv.example", "tok", 5_000,
  (async () => new Response("err", { status })) as unknown as typeof fetch);

describe("converter errors -> user messages", () => {
  for (const [status, msg] of [[504, CONVERSION_TIMEOUT], [413, RESULT_TOO_LARGE], [400, UNSUPPORTED_HTML],
    [422, INVALID_INPUT], [500, CONVERSION_FAILED], [401, CONVERSION_FAILED]] as const) {
    it(`HTTP ${status}`, async () => {
      const e = await client(status).convert({ fileUrl: "u", from: "pdf", to: "docx" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConverterError);
      expect(errorMessage(e)).toBe(msg);
    });
  }
  it("network failure is a generic failure", async () => {
    const c = new HttpConverterClient("https://conv.example", "tok", 5_000, (async () => { throw new TypeError("boom"); }) as unknown as typeof fetch);
    expect(errorMessage(await c.convert({ fileUrl: "u", from: "pdf", to: "docx" }).catch((x: unknown) => x))).toBe(CONVERSION_FAILED);
  });
  it("unknown errors are a generic failure", () => expect(errorMessage(new Error("x"))).toBe(CONVERSION_FAILED));
});
