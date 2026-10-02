import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { register } from "../src/registry.js";
import { run } from "../src/run.js";

process.env.CONVERTER_TOKEN = "test-token";
process.env.MIN_FREE_DISK_MB = "0";
let app: Server, files: Server, base = "", fileBase = "";

before(async () => {
  const { createApp } = await import("../src/server/index.js");
  // test-only conversion: uppercase a text file
  register("testa", "testb", async (ctx) => {
    const out = join(ctx.workDir, "out.testb");
    await writeFile(out, (await readFile(ctx.input, "utf8")).toUpperCase());
    return { path: out, contentType: "text/plain", filename: "result.testb" };
  });
  files = createServer((_q, r) => { r.end("hello world"); }).listen(0);
  app = createApp().listen(0);
  fileBase = `http://127.0.0.1:${(files.address() as AddressInfo).port}/`;
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  process.env.ALLOWED_URL_PREFIXES = fileBase;
});
after(() => { app.close(); files.close(); });

const convert = (body: unknown, token = "test-token") => fetch(`${base}/convert`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});

test("health", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { ok: boolean }).ok, true);
});
test("rejects bad token", async () => {
  assert.equal((await convert({ fileUrl: fileBase, from: "testa", to: "testb" }, "nope")).status, 401);
});
test("rejects disallowed URL (SSRF guard)", async () => {
  assert.equal((await convert({ fileUrl: "http://169.254.169.254/", from: "testa", to: "testb" })).status, 400);
});
test("rejects invalid format strings", async () => {
  assert.equal((await convert({ fileUrl: fileBase, from: "../etc", to: "testb" })).status, 400);
});
test("unsupported conversion -> 422", async () => {
  assert.equal((await convert({ fileUrl: fileBase, from: "pdf", to: "xyz" })).status, 422);
});
test("end-to-end job + temp cleanup", async () => {
  const before = (await readdir(tmpdir())).filter((f) => f.startsWith("job-")).length;
  const r = await convert({ fileUrl: fileBase, from: "testa", to: "testb" });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "HELLO WORLD");
  assert.match(r.headers.get("content-disposition") ?? "", /result\.testb/);
  let afterCount = -1;
  for (let i = 0; i < 20 && afterCount !== before; i++) {
    await new Promise((r) => setTimeout(r, 25));
    afterCount = (await readdir(tmpdir())).filter((f) => f.startsWith("job-")).length;
  }
  assert.equal(afterCount, before);
});
test("run() never uses a shell", async () => {
  const ac = new AbortController();
  const { stdout } = await run("echo", ["$(id); rm -rf /"], { cwd: tmpdir(), signal: ac.signal });
  assert.equal(stdout.trim(), "$(id); rm -rf /");
});
test("run() kills on timeout", async () => {
  await assert.rejects(run("sleep", ["5"], { cwd: tmpdir(), signal: AbortSignal.timeout(200) }), /timeout/);
});
