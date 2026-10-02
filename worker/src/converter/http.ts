import { ConverterError, type ConverterClient, type ConvertRequest, type ConvertResult } from "./client";

const MAX_OUTPUT = 50 * 1024 * 1024;

function filenameFromDisposition(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain?.[1];
}

/** Talks to our self-hosted /converter service (see /converter). */
export class HttpConverterClient implements ConverterClient {
  constructor(private baseUrl: string, private token: string, private timeoutMs = 130_000,
    private fetchImpl: typeof fetch = fetch) {}

  async convert(req: ConvertRequest, signal?: AbortSignal): Promise<ConvertResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/convert`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(req),
        signal: sig,
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ConverterError("converter timeout", "timeout");
      }
      throw new ConverterError(`converter unreachable: ${String(e)}`, "failed");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const kind = res.status === 504 ? "timeout" : res.status === 413 ? "too_large"
        : res.status === 400 || res.status === 422 ? "unsupported" : "failed";
      throw new ConverterError(`converter ${res.status}: ${text.slice(0, 300)}`, kind);
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_OUTPUT) throw new ConverterError("output too large", "too_large");
    const body = await res.blob();
    if (body.size > MAX_OUTPUT) throw new ConverterError("output too large", "too_large");
    return {
      body,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      filename: filenameFromDisposition(res.headers.get("content-disposition")),
    };
  }
}
