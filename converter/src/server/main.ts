import { mkdirSync } from "node:fs";
import { createApp } from "./index.js";
import { MAX_JOB_TIMEOUT_MS, sweepWorkRoot, workRoot } from "./resources.js";

if (!process.env.CONVERTER_TOKEN) {
  console.error("CONVERTER_TOKEN is required");
  process.exit(1);
}
if (!process.env.BOT_TOKEN) console.warn("BOT_TOKEN is not set: POST /jobs cannot deliver results (POST /convert still works)");
// WORK_ROOT (default /tmp/work in the image) must exist and be writable by uid 1000.
if (process.env.WORK_ROOT) mkdirSync(process.env.WORK_ROOT, { recursive: true });
// Startup sweep: the queue is in memory, so any job dir left in WORK_ROOT is from a crash/restart.
const swept = await sweepWorkRoot(0);
if (swept) console.log(JSON.stringify({ evt: "sweep", removed: swept, root: workRoot(), at: "startup" }));
// Safety net while running: remove job dirs older than the longest possible job (+ upload time).
setInterval(() => {
  sweepWorkRoot(MAX_JOB_TIMEOUT_MS + 10 * 60 * 1000)
    .then((n) => { if (n) console.log(JSON.stringify({ evt: "sweep", removed: n, at: "periodic" })); })
    .catch(() => undefined);
}, 10 * 60 * 1000).unref();
const port = Number(process.env.PORT ?? 7860);
createApp().listen(port, "0.0.0.0", () => console.log(`converter listening on :${port}`));
