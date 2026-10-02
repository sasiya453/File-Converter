# File-Converter — Telegram File Converter Bot

A Telegram bot (Cloudflare Worker, webhook mode) that converts files between 89 formats.
The user sends a file, the bot shows only the target formats that the conversion matrix
allows for that source, and it replies with the converted file.

The heavy lifting is done by a separate, stateless Docker service (`/converter`) with ffmpeg,
LibreOffice, ImageMagick, Calibre, etc. The Worker only orchestrates.

```
/worker     Cloudflare Worker (TypeScript, wrangler). Webhook, keyboards, KV sessions, rate limit.
/converter  HTTP conversion service (Node.js + native tools, Docker). One handler module per family.
/docs       conversion-matrix.png (source of truth), welcome-message.jpg
/scripts    check-matrix.ts, set-webhook.ts, extract-matrix.py
handoff.md  Status, decisions, known issues and the task checklist
```

## How it works
```
Telegram ──webhook──▶ Worker (/webhook/<WEBHOOK_SECRET>, header check, 200 at once)
                       │ ctx.waitUntil:
                       │  file → detect format (name → MIME → magic bytes) → KV session (1 h)
                       │  → inline keyboard (✓ targets only) → callback → rate limit (KV)
                       │  → "⏳ Converting…" → getFile URL
                       ▼
                  Converter  POST /convert {fileUrl, from, to, options}  (Bearer token)
                       │  downloads from api.telegram.org only, runs the tool(s), streams the result
                       ▼
                 Worker → sendDocument / sendPhoto / sendVideo / sendVideoNote / sendVoice
```
Limits: 20 MB input (Telegram `getFile`; larger files get the exact Telegram-limit message),
50 MB output, 120 s per job, N conversions per user per minute (`RATE_LIMIT_PER_MIN`, default 5).

## 1. Deploy the converter service
The image contains all the tools: ffmpeg, LibreOffice (Writer/Calc/Impress/Draw), ImageMagick,
Ghostscript, poppler-utils, Calibre, FontForge + woff2, fontTools + brotli, Tesseract (eng),
librsvg/Inkscape, libheif/libavif, python-lottie (TGS), djvulibre, 7-Zip (+ RAR), unrar,
pdf2docx, img2pdf, pysubs2.

```bash
cd converter
docker build -t file-converter .
docker run -d --name file-converter -p 8080:8080 \
  -e CONVERTER_TOKEN=<long-random-string> \
  -e ALLOWED_URL_PREFIXES=https://api.telegram.org/file/ \
  --memory=2g --cpus=2 --pids-limit=256 --read-only \
  --tmpfs /work:size=2g --tmpfs /tmp:size=512m \
  --restart unless-stopped file-converter
curl http://localhost:8080/health      # {"ok":true,"conversions":<n>}
```
Converter environment:

| var | default | meaning |
|---|---|---|
| `CONVERTER_TOKEN` | (required) | Bearer token that the Worker must send |
| `ALLOWED_URL_PREFIXES` | `https://api.telegram.org/file/` | SSRF guard: comma-separated URL prefixes the service may download from |
| `JOB_TIMEOUT_MS` | `120000` | per-job timeout (the whole tool process group is killed) |
| `WORK_ROOT` | `/work` | per-job temp dirs, deleted after every job |
| `PORT` | `8080` | |

Hosting: any VPS (Docker + Caddy/nginx for HTTPS), Fly.io (`fly launch` using the Dockerfile,
≥ 2 GB RAM), Render / Railway (Docker service), or Google Cloud Run (`--memory 2Gi --timeout 150`).
Its public HTTPS URL is `CONVERTER_URL`. Give it ≥ 2 GB RAM; LibreOffice and Calibre are memory-hungry.

Local dev without Docker: `cd converter && npm i && CONVERTER_TOKEN=dev npm run dev` (the tools must be on PATH).

## 2. Deploy the Worker
```bash
cd worker
npm i
npx wrangler login
npx wrangler kv namespace create SESSIONS     # paste the id into wrangler.toml
npx wrangler secret put BOT_TOKEN             # from @BotFather
npx wrangler secret put WEBHOOK_SECRET        # random; chars A-Z a-z 0-9 _ -
npx wrangler secret put CONVERTER_URL         # e.g. https://converter.example.com
npx wrangler secret put CONVERTER_TOKEN       # same value as the converter service
npx wrangler deploy
```
`RATE_LIMIT_PER_MIN` is a plain var in `wrangler.toml`. Local dev: copy `.dev.vars.example` to
`.dev.vars`, then `npx wrangler dev`. Never commit `.dev.vars` or secrets.

## 3. Register the webhook and the Menu command
```bash
cd worker
BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://file-converter-bot.<account>.workers.dev \
  npx tsx ../scripts/set-webhook.ts
```
This sets the webhook (with `secret_token`), the `/start` and `/menu` commands, and the commands menu button.

## CI/CD (GitHub Actions)

> **One-time step:** the workflow files are stored in `ci/github-workflows/` because the automation that
> wrote them can't push to `.github/workflows/` (GitHub requires the `workflows` permission for that).
> Activate them from a clone with your own credentials:
> `git mv ci/github-workflows .github/workflows && git commit -m "ci: enable workflows" && git push`
> (or create the three files in the GitHub web UI under `.github/workflows/`).

| Workflow | Trigger | What it does |
|---|---|---|
| `test.yml` | every PR and push to main | Worker: typecheck, vitest, check-matrix. Converter: typecheck, build, fast tests (`npm run test:fast`; the heavy tool tests run inside the Docker image instead). |
| `deploy-hf.yml` | push to main touching `converter/**` (or manual) | Converter typecheck + fast tests, then clones the Space repo and `rsync --delete`s `converter/` into it (without `tests/`, `node_modules/`, `dist/`), commits and pushes. HF rebuilds the Docker image. |
| `deploy-worker.yml` | push to main touching `worker/**` (or manual) | `npm ci`, `npm test`, `npm run typecheck`, then `npx wrangler deploy`. |

Required **GitHub repository secrets** (Settings → Secrets and variables → Actions). Never commit them:

| Secret | Used by | Value |
|---|---|---|
| `HF_TOKEN` | deploy-hf | Hugging Face access token with **write** permission |
| `HF_SPACE` | deploy-hf | Space id, e.g. `username/file-converter` |
| `CLOUDFLARE_API_TOKEN` | deploy-worker | Cloudflare API token (template "Edit Cloudflare Workers") |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-worker | Cloudflare account id |

The runtime secrets are not stored in GitHub. They live on the platforms: **Space secrets** `CONVERTER_TOKEN`, `BOT_TOKEN`; **Worker secrets** `BOT_TOKEN`, `WEBHOOK_SECRET`, `CONVERTER_URL`, `CONVERTER_TOKEN` (`npx wrangler secret put`, kept across deploys).

## Tests
```bash
cd worker && npm test && npm run typecheck              # vitest
cd converter && npm test && npm run typecheck           # node:test; needs the tools (skips when missing)
cd worker && npx tsx ../scripts/check-matrix.ts         # matrix counts per section
```
`converter/tests/matrix-coverage.test.ts` checks that every ✓ cell has a converter handler and
that no handler exists for a ✗ cell. Each family has fixtures in `converter/tests/fixtures/`.

## Conversion matrix
`worker/src/matrix/matrix.json` is extracted from `docs/conversion-matrix.png` by
`python3 scripts/extract-matrix.py` (pixel colour classification, verified visually), plus
TORRENT → TXT. Only ✓ cells are offered on the keyboard. The image has 886 ✓ cells (887 with
TORRENT), while the bot advertises 874; see handoff.md.

Special targets are delivery modes: VIDEONOTE (640×640 MP4, ≤ 60 s, sendVideoNote), STREAM
(faststart MP4, sendVideo), AUDIO NOTE (OGG/Opus mono, sendVoice), SENDPHOTO (JPEG, sendPhoto),
OCR (Tesseract → .txt), GIFZ (ZIP with the animated GIF plus its PNG frames).

## Adding a conversion
Add one `register(from, to, handler)` call in the matching `converter/src/handlers/<family>.ts`
(handlers get `{input, workDir, from, to, options, signal}` and return `{path, contentType, filename}`;
always run tools via `run()`, with an argv array and no shell), add a fixture and a test, and mark the
cell ✓ in matrix.json. The Worker needs no changes.

## Known limitations
EBU binary STL, MTX-compressed EOT, password-protected archives/PDFs, and scanned PDFs → TXT
are not supported (the user gets a clear error message). See `handoff.md` for the full list.
