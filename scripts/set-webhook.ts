// Registers the Telegram webhook + bot commands/menu button.
// Usage: BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://file-converter-bot.<acct>.workers.dev npx tsx scripts/set-webhook.ts
const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) {
  console.error("Set BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL");
  process.exit(1);
}
async function call(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(method, JSON.stringify(json));
  if (!(json as { ok: boolean }).ok) process.exitCode = 1;
}
await call("setWebhook", {
  url: `${WORKER_URL.replace(/\/$/, "")}/webhook/${WEBHOOK_SECRET}`,
  secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
  max_connections: 40,
});
await call("setMyCommands", { commands: [
  { command: "start", description: "Start / supported formats" },
  { command: "menu", description: "Menu" },
] });
await call("setChatMenuButton", { menu_button: { type: "commands" } });
await call("getWebhookInfo", {});
