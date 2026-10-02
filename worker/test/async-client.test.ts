import { describe, it, expect } from "vitest";
import { AsyncJobClient, ConverterError, type JobRequest } from "../src/converter";

const job: JobRequest = {
  jobId: "cq_12345678", fileUrl: "https://api.telegram.org/file/bot1:X/a.pdf", from: "pdf", to: "docx",
  section: "document", options: { section: "document" }, chatId: 1, statusMessageId: 2, originalName: "a.pdf",
  delivery: { method: "sendDocument", ext: "docx" },
};

type Step = number | "throw" | "html" | ((init: RequestInit) => Response);
function scripted(steps: Step[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const s = steps[Math.min(seen.length - 1, steps.length - 1)]!;
    if (s === "throw") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    if (s === "html") return new Response("<html>Starting…</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (typeof s === "function") return s(init);
    return new Response(JSON.stringify(s === 202 ? { jobId: job.jobId, position: 3 } : { error: "x" }), { status: s });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const client = new AsyncJobClient("https://space.hf.space/", "tok", {
    fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
  });
  return { client, seen, sleeps };
}

describe("AsyncJobClient", () => {
  it("POSTs the job to /jobs with the bearer token and returns the position", async () => {
    const { client, seen } = scripted([202]);
    expect(await client.submitJob(job)).toEqual({ jobId: job.jobId, position: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://space.hf.space/jobs");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(job);
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a sleeping Space with backoff and reports waking once", async () => {
    const { client, seen, sleeps } = scripted([503, "throw", 202]);
    let waking = 0;
    expect((await client.submitJob(job, { onWaking: () => { waking++; } })).position).toBe(3);
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([3_000, 6_000]);
    expect(waking).toBe(1);
  });

  it("treats HF's HTML starting page as waking", async () => {
    const { client, seen } = scripted(["html", 202]);
    await client.submitJob(job);
    expect(seen).toHaveLength(2);
  });

  it("gives up after 2 retries with kind=unavailable", async () => {
    const { client, seen } = scripted(["throw"]);
    const e = await client.submitJob(job).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConverterError);
    expect((e as ConverterError).kind).toBe("unavailable");
    expect(seen).toHaveLength(3);
  });

  it("429 → busy, no retry", async () => {
    const { client, seen } = scripted([429]);
    expect(((await client.submitJob(job).catch((x) => x)) as ConverterError).kind).toBe("busy");
    expect(seen).toHaveLength(1);
  });

  it("400/401 → failed, 422 → unsupported, no retry", async () => {
    for (const [status, kind] of [[400, "failed"], [401, "failed"], [422, "unsupported"]] as const) {
      const { client, seen } = scripted([status]);
      expect(((await client.submitJob(job).catch((x) => x)) as ConverterError).kind).toBe(kind);
      expect(seen).toHaveLength(1);
    }
  });

  it("respects the overall deadline (stays inside the waitUntil budget)", async () => {
    let t = 0;
    const fetchImpl = (async () => { t += 25_000; throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    const client = new AsyncJobClient("https://s", "tok", { fetchImpl, now: () => t, sleep: async (ms) => { t += ms; } });
    const e = (await client.submitJob(job).catch((x) => x)) as ConverterError;
    expect(e.kind).toBe("unavailable");
    expect(t).toBeLessThanOrEqual(28_000);
  });

  it("missing CONVERTER_URL fails fast", async () => {
    const c = new AsyncJobClient("", "tok");
    expect(((await c.submitJob(job).catch((x) => x)) as ConverterError).kind).toBe("failed");
  });
});
