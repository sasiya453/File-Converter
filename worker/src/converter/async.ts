import {
  ConverterError, type ConverterClient, type ConvertRequest, type ConvertResult, type JobAccepted, type JobRequest,
  type SubmitHooks,
} from "./client";
import { HttpConverterClient } from "./http";

export interface AsyncJobClientOptions {
  /** Timeout of a single POST /jobs attempt (a sleeping Space needs time to wake up). */
  attemptTimeoutMs?: number;
  /** Retries after the first attempt. */
  retries?: number;
  /** Backoff before retry n (ms). The last value is reused if there are more retries. */
  backoffMs?: number[];
  /**
   * Hard wall-clock budget for the whole submit (all attempts + backoff). Cloudflare
   * keeps `ctx.waitUntil` work alive for ~30 s after the response, so stay below that.
   */
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Status codes that mean "the Space is asleep / starting / restarting": worth a retry. */
const WAKING_STATUS = new Set([502, 503, 504]);

/**
 * Default converter client. It only does one short request: POST /jobs, which answers
 * 202 at once. The converter then converts and delivers the result to Telegram itself,
 * so the Worker never waits for a conversion.
 */
export class AsyncJobClient implements ConverterClient {
  private readonly attemptTimeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number[];
  private readonly deadlineMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private baseUrl: string, private token: string, o: AsyncJobClientOptions = {}) {
    this.attemptTimeoutMs = o.attemptTimeoutMs ?? 25_000;
    this.retries = o.retries ?? 2;
    this.backoffMs = o.backoffMs ?? [3_000, 6_000];
    this.deadlineMs = o.deadlineMs ?? 28_000;
    this.fetchImpl = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? Date.now;
  }

  private get base() { return this.baseUrl.replace(/\/$/, ""); }

  async submitJob(job: JobRequest, hooks: SubmitHooks = {}): Promise<JobAccepted> {
    if (!this.baseUrl) throw new ConverterError("CONVERTER_URL is not set", "failed");
    const start = this.now();
    let woke = false;
    let lastErr = "no attempt";
    const waking = async () => {
      if (woke) return;
      woke = true;
      try { await hooks.onWaking?.(); } catch { /* cosmetic only */ }
    };
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const wait = this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0;
        if (this.now() - start + wait >= this.deadlineMs) break;
        await this.sleep(wait);
      }
      const remaining = this.deadlineMs - (this.now() - start);
      if (remaining <= 0) break;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
          body: JSON.stringify(job),
          signal: AbortSignal.timeout(Math.min(this.attemptTimeoutMs, remaining)),
        });
      } catch (e) {
        // Timeout or connection error: the Space is probably asleep or restarting.
        lastErr = e instanceof Error ? e.name : "fetch error";
        await waking();
        continue;
      }
      if (res.status === 202 || res.status === 200) {
        const data = (await res.json().catch(() => null)) as JobAccepted | null;
        if (!data || typeof data.jobId !== "string") {
          // HF shows an HTML "starting" page with 200 while the container boots.
          lastErr = "non-JSON 2xx (Space starting?)";
          await waking();
          continue;
        }
        return { jobId: data.jobId, position: Number(data.position) || 0, ...(data.duplicate ? { duplicate: true } : {}) };
      }
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429) throw new ConverterError("converter queue full", "busy");
      if (WAKING_STATUS.has(res.status)) {
        lastErr = `HTTP ${res.status}`;
        await waking();
        continue;
      }
      // 400 / 401 / 422 etc. are not retryable.
      const kind = res.status === 422 ? "unsupported" : "failed";
      throw new ConverterError(`converter /jobs ${res.status}`, kind);
    }
    throw new ConverterError(`converter unreachable (${lastErr})`, "unavailable");
  }

  /** Synchronous fallback (POST /convert). Not used by the bot flow. */
  convert(req: ConvertRequest, signal?: AbortSignal): Promise<ConvertResult> {
    return new HttpConverterClient(this.baseUrl, this.token, 130_000, this.fetchImpl).convert(req, signal);
  }
}
