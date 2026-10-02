import { mkdirSync } from "node:fs";
import { createApp } from "./index.js";

if (!process.env.CONVERTER_TOKEN) {
  console.error("CONVERTER_TOKEN is required");
  process.exit(1);
}
// WORK_ROOT (default /tmp/work in the image) must exist and be writable by uid 1000.
if (process.env.WORK_ROOT) mkdirSync(process.env.WORK_ROOT, { recursive: true });
const port = Number(process.env.PORT ?? 7860);
createApp().listen(port, "0.0.0.0", () => console.log(`converter listening on :${port}`));
