# File-Converter — Telegram File Converter Bot

A Telegram bot (Cloudflare Worker, webhook mode) that converts files between 89 formats.
The user sends a file, the bot shows only the target formats that the conversion matrix
allows for that source, and it replies with the converted file.

The heavy lifting is done by a separate Docker service (`/converter`, deployed as a Hugging Face
Docker Space) with ffmpeg, LibreOffice, ImageMagick, Calibre, etc. It runs jobs asynchronously and
sends the result to Telegram itself. The Worker (Cloudflare Workers free plan) only orchestrates.

```
/worker     Cloudflare Worker (TypeScript, wrangler). Webhook, keyboards, KV sessions, rate limit.
/converter  HTTP conversion service (Node.js + native tools, Docker). One handler module per family.
/docs       conversion-matrix.png (source of truth), welcome-message.jpg
/scripts    check-matrix.ts, set-webhook.ts, smoke-test.ts, extract-matrix.py
ci/         GitHub Actions workflows (move to .github/workflows, see CI/CD)
handoff.md  Status, decisions, known issues and the task checklist
```

## How it works
```
Telegram ──webhook──▶ Cloudflare Worker (/webhook/<WEBHOOK_SECRET>, header check, 200 at once)
                       │ ctx.waitUntil (short work only, < 30 s):
                       │  file → detect format (name → MIME → magic bytes) → KV session (1 h)
                       │  → inline keyboard (✓ targets only) → callback → matrix check → rate limit (KV)
                       │  → "⏳ Converting…" → getFile URL
                       │  → POST {CONVERTER_URL}/jobs  (Bearer, 25 s timeout, 2 retries; "waking up" text)
                       ▼
        Converter on a Hugging Face Docker Space ── answers 202 {jobId, position} at once
                       │  in-memory queue (MAX_CONCURRENT_JOBS=2, MAX_QUEUE=20, idempotent jobId)
                       │  downloads from api.telegram.org only → runs the tool(s) → ≤ 50 MB check
                       ▼
        Converter → Telegram: sendDocument / sendPhoto / sendVideo (streaming) / sendVideoNote / sendVoice
                       (multipart upload from disk), then deletes "⏳ Converting…".
                       On error it edits the status message with the user-facing error text.
Cron (every 20 min) ─▶ Worker scheduled() ─▶ GET {CONVERTER_URL}/health  (keeps the free Space awake)
```
The Worker never waits for a conversion, so long video/e-book/LibreOffice jobs are not limited by the
Workers free plan or by HF's proxy timeout. Limits: 20 MB input (Telegram `getFile`; larger files get the
exact Telegram-limit message), 50 MB output (Telegram upload limit), per-family job timeouts (video/e-book
110 s, documents 90 s, …, all < 5 min), N conversions per user per minute (`RATE_LIMIT_PER_MIN`, default 5).
A full queue (or < 1 GB free disk) returns 429 and the user gets "busy, try again in a minute".

## Deployment (Hugging Face Space + Cloudflare Workers)

### 0. Prerequisites
- A bot token from [@BotFather](https://t.me/BotFather).
- Two random secrets: `openssl rand -hex 32` for **CONVERTER_TOKEN**, and `openssl rand -hex 16` for
  **WEBHOOK_SECRET** (chars `A-Z a-z 0-9 _ -` only).
- A Hugging Face account and a Cloudflare account (both free). Node 22 locally.

### 1. Create the converter Space (Hugging Face)
1. <https://huggingface.co/new-space> → name e.g. `file-converter`, **SDK: Docker** (blank template),
   hardware **CPU basic (free)**, visibility **Public** (a private Space needs an HF token on every request,
   which the Worker doesn't send).
2. Space → **Settings → Variables and secrets → New secret**:
   - `CONVERTER_TOKEN` = the random string from step 0
   - `BOT_TOKEN` = the bot token (the converter uploads results to Telegram itself)
   Optional variables (defaults are fine): `MAX_CONCURRENT_JOBS` (2), `MAX_QUEUE` (20), `JOB_TIMEOUT_MS`,
   `JOB_TIMEOUT_<FAMILY>_MS`, `MIN_FREE_DISK_MB` (1024). See `converter/.env.example` for the full list.
3. Push the code. The Space root must be the **contents of `converter/`** (Dockerfile + `README.md` with the
   `sdk: docker` / `app_port: 7860` front matter):
   - automatically: set the GitHub secrets `HF_TOKEN` (write token) and `HF_SPACE` (`username/file-converter`)
     and enable the workflows (see [CI/CD](#cicd-github-actions)); every push to main that touches
     `converter/**` deploys, or
   - manually:
     ```bash
     git clone https://huggingface.co/spaces/<user>/file-converter /tmp/space
     rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude tests converter/ /tmp/space/
     cd /tmp/space && git add -A && git commit -m deploy && git push   # password = an HF write token
     ```
4. Wait for the build (the first one takes ~10 min; the image is ~2.1 GB). Then
   `curl https://<user>-file-converter.hf.space/health` → `{"ok":true,"queued":0,"running":0,"uptimeSec":…}`.
   That URL (no trailing slash) is **CONVERTER_URL**.

The image runs as uid 1000, listens on `PORT` 7860, writes only to `/tmp` (`WORK_ROOT=/tmp/work`) and needs no
persistent storage. It contains ffmpeg, LibreOffice (Writer/Calc/Impress/Draw), ImageMagick, Ghostscript,
poppler-utils, Calibre, FontForge + woff2, fontTools + brotli, Tesseract (eng), librsvg, libheif/libavif,
python-lottie + cairosvg (TGS), djvulibre, 7-Zip (+ RAR), pdf2docx, img2pdf and pysubs2.

Run the same image elsewhere (VPS, Fly.io, Render, Cloud Run):
```bash
docker build -t file-converter converter
docker run -d -p 7860:7860 -e CONVERTER_TOKEN=... -e BOT_TOKEN=... \
  --read-only --tmpfs /tmp:rw,exec,size=3g,uid=1000,gid=1000 --memory=4g --cpus=2 file-converter
```
Local dev without Docker: `cd converter && npm i && CONVERTER_TOKEN=dev BOT_TOKEN=... npm run dev` (tools on PATH).

### 2. Deploy the Worker (Cloudflare)
```bash
cd worker
npm ci
npx wrangler login
npx wrangler kv namespace create SESSIONS     # paste the id into wrangler.toml ([[kv_namespaces]] id)
npx wrangler secret put BOT_TOKEN             # from @BotFather
npx wrangler secret put WEBHOOK_SECRET        # from step 0
npx wrangler secret put CONVERTER_URL         # https://<user>-file-converter.hf.space
npx wrangler secret put CONVERTER_TOKEN       # same value as the Space secret
npx wrangler deploy
```
`wrangler.toml` already has the keep-alive Cron Trigger (`*/20 * * * *`) and `RATE_LIMIT_PER_MIN`.
For automatic deploys set the GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (commit the
KV id in `wrangler.toml`; it is not a secret). Local dev: copy `.dev.vars.example` to `.dev.vars`, then
`npx wrangler dev`. Never commit `.dev.vars` or secrets.

### 3. Register the webhook and the Menu command
```bash
cd worker
BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://file-converter-bot.<account>.workers.dev \
  npx tsx ../scripts/set-webhook.ts
```
This sets the webhook (with `secret_token`), the `/start` and `/menu` commands, and the commands menu button.

### 4. Smoke test
```bash
cd converter
npx tsx ../scripts/smoke-test.ts --fake        # local: fake Telegram + local converter, no secrets
CONVERTER_URL=https://<user>-file-converter.hf.space CONVERTER_TOKEN=... BOT_TOKEN=... CHAT_ID=<your id> \
  npx tsx ../scripts/smoke-test.ts             # real: uploads a tiny torrent to your chat, POSTs /jobs,
                                               # you should receive sample.txt and no leftover status message
```
Then check by hand in Telegram:
- [ ] `/start` shows the welcome message; "Menu" works.
- [ ] One file of each family converts and arrives with the right method: PDF → DOCX, DOCX → PDF,
      MP4 → MP3 and → VIDEO NOTE / STREAM, PNG → JPG / SEND PHOTO / OCR, MP3 → AUDIO NOTE, EPUB → MOBI,
      CBZ → PDF, PPTX → PDF, TTF → WOFF2, XLSX → PDF, SRT → VTT, TGS → GIF, TORRENT → TXT.
- [ ] A **20 MB+** file gets the Telegram-limit message right away (no keyboard).
- [ ] An output over 50 MB edits the status message with the "too large" text.
- [ ] **Busy queue:** set the Space variable `MAX_QUEUE=1`, start 3 video conversions quickly → the third shows
      "busy, try again in a minute"; reset the variable afterwards.
- [ ] **Sleeping Space:** pause it in the Space settings (or wait for it to sleep), restart it, send a file →
      the status shows "⏳ Waking up the converter…" and the result still arrives (or, if the Space needs longer
      than ~28 s, the "converter unavailable, try again" text; press the button again).
- [ ] Space logs show `job_queued` / `job_ok` JSON lines and never contain the bot token or a file URL.

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
cd converter && npm run test:fast                       # API/queue/security tests only, no tools needed
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
