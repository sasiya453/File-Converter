import { createApp } from "./index.js";

if (!process.env.CONVERTER_TOKEN) {
  console.error("CONVERTER_TOKEN is required");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
createApp().listen(port, () => console.log(`converter listening on :${port}`));
