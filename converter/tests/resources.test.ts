// Task H3: resource safety (timeouts per family, prlimit caps, disk checks, sweeps, /health fields).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { run, withLimits, AS_LIMITED_TOOLS } from "../src/run.js";
import {
  FAMILY_TIMEOUT_MS, MAX_JOB_TIMEOUT_MS, timeoutFor, sweepWorkRoot, hasEnoughDisk, freeDiskBytes,
} from "../src/server/resources.js";
import { createApp } from "../src/server/index.js";
import { ffmpegThreads } from "../src/handlers/video.js";
import { hasTool } from "./helpers.js";

process.env.CONVERTER_TOKEN = "res-token";

async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe("per-family timeouts", () => {
  test("table values (video 110 s, documents 90 s) and every job < 5 min", () => {
    assert.equal(timeoutFor("mp4", "avi", "video"), 110_000);
    assert.equal(timeoutFor("pdf", "docx", "document"), 90_000);
    for (const [fam, ms] of Object.entries(FAMILY_TIMEOUT_MS)) {
      assert.ok(ms > 0 && ms < MAX_JOB_TIMEOUT_MS, fam);
      assert.equal(timeoutFor("a", "b", fam), ms);
    }
  });
  test("JOB_TIMEOUT_MS is the fallback for an unknown/missing family", () => {
    withEnv({ JOB_TIMEOUT_MS: "45000" }, () => {
      assert.equal(timeoutFor("a", "b"), 45_000);
      assert.equal(timeoutFor("a", "b", "unknownfam"), 45_000);
      assert.equal(timeoutFor("a", "b", "video"), 110_000);
    });
    withEnv({ JOB_TIMEOUT_MS: undefined }, () => assert.equal(timeoutFor("a", "b"), 120_000));
  });
  test("JOB_TIMEOUT_<FAMILY>_MS overrides, capped at 5 min", () => {
    withEnv({ JOB_TIMEOUT_VIDEO_MS: "200000", JOB_TIMEOUT_FONT_MS: "99999999" }, () => {
      assert.equal(timeoutFor("a", "b", "video"), 200_000);
      assert.equal(timeoutFor("a", "b", "font"), MAX_JOB_TIMEOUT_MS);
    });
    withEnv({ JOB_TIMEOUT_MS: "99999999" }, () => assert.equal(timeoutFor("a", "b"), MAX_JOB_TIMEOUT_MS));
  });
});

describe("tool limits", () => {
  const prlimit = hasTool("prlimit");
  test("withLimits wraps with prlimit + nice; AS cap only for safe tools", { skip: !prlimit }, () => {
    const ff = withLimits("ffmpeg", ["-i", "x"]);
    assert.equal(ff.cmd, "prlimit");
    assert.ok(ff.args.some((a) => a.startsWith("--as=")));
    assert.ok(ff.args.some((a) => a.startsWith("--fsize=")));
    assert.deepEqual(ff.args.slice(ff.args.indexOf("--")), ["--", "nice", "-n", "10", "ffmpeg", "-i", "x"]);
    const lo = withLimits("soffice", ["--headless"]);
    assert.ok(!lo.args.some((a) => a.startsWith("--as=")), "LibreOffice must not get RLIMIT_AS");
    assert.ok(lo.args.includes("--core=0"));
    assert.ok(AS_LIMITED_TOOLS.has("gs") && !AS_LIMITED_TOOLS.has("ebook-convert") && !AS_LIMITED_TOOLS.has("fontforge"));
  });
  test("USE_PRLIMIT=0 disables wrapping", () => {
    withEnv({ USE_PRLIMIT: "0" }, () => assert.deepEqual(withLimits("ffmpeg", ["a"]), { cmd: "ffmpeg", args: ["a"] }));
  });
  test("the file-size cap stops a runaway writer", { skip: !prlimit }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "lim-"));
    try {
      await withEnvAsync({ TOOL_MAX_FILE_MB: "1" }, () =>
        assert.rejects(run("dd", ["if=/dev/zero", `of=${join(dir, "big")}`, "bs=1M", "count=5"], { cwd: dir, signal: AbortSignal.timeout(10_000) }), /exited/));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("tools run niced (the HTTP server keeps priority)", { skip: !prlimit }, async () => {
    const { stdout } = await run("nice", [], { cwd: tmpdir(), signal: AbortSignal.timeout(5_000) });
    assert.equal(stdout.trim(), "10");
  });
  test("a missing tool is still a 500 (not a 422) behind prlimit", async () => {
    await assert.rejects(run("definitely-not-a-tool-xyz", [], { cwd: tmpdir(), signal: AbortSignal.timeout(5_000) }),
      (e: { status?: number }) => e.status === 500);
  });
  test("timeout kills the whole process group (children too)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pg-"));
    const marker = join(dir, "child-alive");
    try {
      const started = Date.now();
      // sh spawns a background child that would write the marker after 1.5 s.
      await assert.rejects(run("sh", ["-c", `(sleep 1.5; touch ${marker}) & sleep 30`], { cwd: dir, signal: AbortSignal.timeout(300) }), /timeout/);
      assert.ok(Date.now() - started < 3_000);
      await new Promise((r) => setTimeout(r, 2_000));
      assert.deepEqual(await readdir(dir), [], "the background child must have been killed with the group");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("ffmpeg gets 2 threads by default", () => {
    assert.equal(ffmpegThreads(), "2");
    withEnv({ FFMPEG_THREADS: "1" }, () => assert.equal(ffmpegThreads(), "1"));
  });
});

describe("disk safety", () => {
  test("sweepWorkRoot removes only stale job-* dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "root-"));
    try {
      await mkdir(join(root, "job-old"));
      await writeFile(join(root, "job-old", "f"), "x");
      await mkdir(join(root, "job-new"));
      await mkdir(join(root, "keep-me"));
      const old = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(join(root, "job-old"), old, old);
      assert.equal(await sweepWorkRoot(30 * 60 * 1000, root), 1);
      assert.deepEqual((await readdir(root)).sort(), ["job-new", "keep-me"]);
      assert.equal(await sweepWorkRoot(0, root), 1); // startup sweep: every job dir
      assert.deepEqual(await readdir(root), ["keep-me"]);
      assert.equal(await sweepWorkRoot(0, join(root, "missing")), 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("free-disk check honours MIN_FREE_DISK_MB", async () => {
    assert.ok((await freeDiskBytes()) > 0);
    assert.equal(await withEnvAsync({ MIN_FREE_DISK_MB: "0" }, () => hasEnoughDisk()), true);
    assert.equal(await withEnvAsync({ MIN_FREE_DISK_MB: String(1024 * 1024 * 1024) }, () => hasEnoughDisk()), false);
  });

  const apps: { close(): void }[] = [];
  after(() => apps.forEach((a) => a.close()));
  test("POST /jobs answers 429 when free disk < MIN_FREE_DISK_MB; /health has queued, running, uptimeSec", async () => {
    const app = createApp().listen(0);
    apps.push(app);
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    process.env.ALLOWED_URL_PREFIXES = "https://api.telegram.org/file/";
    const body = {
      jobId: "disk_job_1", fileUrl: "https://api.telegram.org/file/bot1:x/a.txt", from: "txt", to: "pdf",
      section: "document", options: {}, chatId: 1, statusMessageId: 2, originalName: "a.txt",
      delivery: { method: "sendDocument", ext: "pdf" },
    };
    const old = process.env.MIN_FREE_DISK_MB;
    process.env.MIN_FREE_DISK_MB = String(1024 * 1024 * 1024); // 1 PB
    try {
      const r = await fetch(`${base}/jobs`, { method: "POST", headers: { authorization: "Bearer res-token" }, body: JSON.stringify(body) });
      assert.equal(r.status, 429);
    } finally { if (old === undefined) delete process.env.MIN_FREE_DISK_MB; else process.env.MIN_FREE_DISK_MB = old; }
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(h).sort(), ["ok", "queued", "running", "uptimeSec"]);
    assert.equal(typeof h.uptimeSec, "number");
  });
});
