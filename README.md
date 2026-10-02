# File-Converter — Telegram File Converter Bot

Telegram bot (Cloudflare Worker, webhook mode) that converts files between 89 formats.
Heavy lifting is done by a separate stateless Docker service (`/converter`) with ffmpeg,
LibreOffice, ImageMagick, Calibre, etc. The Worker only orchestrates.

```
/worker     Cloudflare Worker (TypeScript, wrangler). Webhook, keyboards, KV sessions.
/converter  HTTP conversion service (Node.js + native tools, Docker).
/docs       conversion-matrix.png (source of truth), welcome-message.jpg
/scripts    check-matrix.ts, set-webhook.ts, extract-matrix.py
handoff.md  Status + task checklist for the next agent
```

## 1. Deploy the converter service
```bash
cd converter
docker build -t file-converter .
docker run -d --name file-converter -p 8080:8080 \
  -e CONVERTER_TOKEN=<long-random> \
  -e ALLOWED_URL_PREFIXES=https://api.telegram.org/file/ \
  --memory=2g --pids-limit=256 --read-only --tmpfs /work:size=1g --tmpfs /tmp:size=256m \
  file-converter
curl http://localhost:8080/health
```
Run it on any VPS / Fly.io / Railway / Cloud Run and put it behind HTTPS. Its public URL is `CONVERTER_URL`.

Local dev without Docker: `cd converter && npm i && CONVERTER_TOKEN=dev npm run dev` (needs the tools on PATH).

## 2. Deploy the Worker
```bash
cd worker
npm i
npx wrangler login
npx wrangler kv namespace create SESSIONS     # paste the id into wrangler.toml
npx wrangler secret put BOT_TOKEN             # from @BotFather
npx wrangler secret put WEBHOOK_SECRET        # random, chars A-Z a-z 0-9 _ -
npx wrangler secret put CONVERTER_URL         # e.g. https://converter.example.com
npx wrangler secret put CONVERTER_TOKEN       # same value as the converter service
npx wrangler deploy
```
Local dev: copy `.dev.vars.example` to `.dev.vars`, `npx wrangler dev`.

## 3. Register the webhook and Menu command
```bash
cd worker
BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://file-converter-bot.<account>.workers.dev \
  npx tsx ../scripts/set-webhook.ts
```

## Tests
```bash
cd worker && npm test && npm run typecheck
cd converter && npm test && npm run typecheck
cd worker && npx tsx ../scripts/check-matrix.ts      # matrix counts per section
```

## Conversion matrix
`worker/src/matrix/matrix.json` is extracted from `docs/conversion-matrix.png` by
`python3 scripts/extract-matrix.py` (pixel colour classification, verified visually).
Only ✓ cells are offered on the keyboard.
