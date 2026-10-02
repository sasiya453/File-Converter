# Handoff
## Project status
- Last completed task: 3 - PDF → PNG, JPG (commit b5e9503)
- Current branch: main (push directly to main, as the project brief says)

## Environment / how to run
- Node 22. Each package has its own `npm i`.
- Worker (`/worker`): `npm test` (vitest), `npm run typecheck`, `npx wrangler dev` (needs `.dev.vars`, copy from `.dev.vars.example`), `npx wrangler deploy`. Dry-run bundle check: `npx wrangler deploy --dry-run --outdir /tmp/wout`.
- Converter (`/converter`): `npm test` (node:test via tsx), `npm run typecheck`, `CONVERTER_TOKEN=dev npm run dev` (listens on :8080).
  Docker: `docker build -t file-converter converter && docker run -p 8080:8080 -e CONVERTER_TOKEN=... file-converter`.
- Matrix: `cd worker && npx tsx ../scripts/check-matrix.ts`. Re-extract from PNG: `python3 scripts/extract-matrix.py` (needs Pillow, numpy, scipy).
- Webhook: `BOT_TOKEN=.. WEBHOOK_SECRET=.. WORKER_URL=.. npx tsx scripts/set-webhook.ts` (run from `worker/` so tsx resolves). This also sets the /start and /menu commands and the commands menu button.
- Worker secrets: BOT_TOKEN, WEBHOOK_SECRET, CONVERTER_URL, CONVERTER_TOKEN (`wrangler secret put`). KV binding: SESSIONS. Var: RATE_LIMIT_PER_MIN.
- Converter env: CONVERTER_TOKEN (required), ALLOWED_URL_PREFIXES (default `https://api.telegram.org/file/`, SSRF guard), JOB_TIMEOUT_MS (120000), WORK_ROOT, PORT.

## Architecture notes (what exists)
- `worker/src/index.ts`: `/webhook/<secret>` + header `X-Telegram-Bot-Api-Secret-Token` check (constant-time), returns 200 at once, does the work in `ctx.waitUntil(processUpdate)`. `/health` returns ok.
- `worker/src/flow/intake.ts`: /start, /menu, /help and the text "menu" send WELCOME_HTML. For files: extract (document/photo/video/audio/voice/video_note/animation/sticker), apply the 20 MB guard (exact message in `messages.ts`), detect the format (name → MIME → magic-byte sniff of the first 512 bytes via a Range request), save the KV session (TTL 1h), show the keyboard.
- `worker/src/flow/callback.ts`: full pipeline (done in Task 1): decode → session → matrix check (✗ is rejected) → rate limit (`RATE_LIMIT_PER_MIN`, default 5) → answerCallback → "⏳ Converting…" → getFile URL → `converter.convert({fileUrl, from, to: target, options:{section}})` → `tg.upload(deliveryFor(section,target))` with filename `outputName(original, ext)` → delete the status message. ConverterError kinds map to messages via `errorMessage()`. The converter is injectable (4th param) for tests. **New conversions need NO Worker changes**; just add converter handlers (and, for special targets, check `matrix/delivery.ts`).
- `worker/src/flow/keyboard.ts`: callback_data is `c|<section>|<target>` (<64 bytes). Section header rows (callback `noop`) appear only when the source is in more than one section (e.g. SVG = image + font).
- `worker/src/matrix/index.ts`: `targetsFor`, `isAllowed`, `matrixCounts`. `matrix/delivery.ts`: target → send method/ext (VIDEONOTE, STREAM, AUDIONOTE, SENDPHOTO, OCR→txt, GIFZ→zip).
- `worker/src/flow/ratelimit.ts`: KV fixed-window limiter, called from callback.ts (Task 1).
- `worker/src/converter/`: `ConverterClient` interface + `HttpConverterClient` (maps 504→timeout, 413→too_large, 400/422→unsupported) + `makeConverter(env)` factory (the place to add a CloudConvert adapter).
- `converter/src/server/index.ts`: `POST /convert` (Bearer auth, from/to regex validation, URL prefix allowlist, 20 MB input cap streamed, 50 MB output cap, 120 s AbortSignal timeout, per-job `mkdtemp` dir always `rm -rf`'d, input saved as fixed name `input.<from>`), `GET /health` (reports registered conversion count). `main.ts` starts the listener.
- `converter/src/run.ts`: `run(cmd, argv[], {cwd, signal})` uses spawn with shell:false, a minimal env, its own process group, and kills the process group on abort. ALL tools must be invoked through this.
- `converter/src/registry.ts`: `register(from|from[], to|to[], handler)`. Handler modules go in `converter/src/handlers/*.ts` and must be imported in `converter/src/handlers/index.ts`.
- `converter/src/tools/libreoffice.ts`: `soffice(input, workDir, filter, signal, extraArgs)` runs headless LO with a per-job profile (`-env:UserInstallation` inside workDir) and returns the output path. The filter spec has NO quotes (no shell), e.g. `"docx:MS Word 2007 XML"`.
- `converter/src/handlers/document.ts`: `pdf->docx` (pdf2docx first, falling back to LO `--infilter=writer_pdf_import`). Also (Task 2): `pdf->txt` (pdftotext -layout; 422 if no text, i.e. a scanned PDF), `pdf->rtf` (pdf2docx → LO rtf), `pdf->{epub,mobi,azw3,lrf,oeb,pdb,fb2,rb}` via the generic `toEbook` handler + `EBOOK_TARGETS` (reuse these for DOCX/TXT/RTF/ODT rows).
- `converter/src/handlers/pdf-image.ts` (Task 3): `pdf->png|jpg` via `pdftoppm -r 150` (max 200 pages). 1 page → a single image. More than 1 page → `converted.zip` (page-1.png, page-2.png …).
- `worker/src/flow/callback.ts` `resultExt()`: if a sendDocument result comes back as `application/zip` (or `*.zip`), the user's filename gets `.zip` instead of `delivery.ext`.
- `converter/src/tools/calibre.ts`: `ebookConvert(input, workDir, ext, signal, extraArgs)` and `zipDir(dir, ...)`.
- Tests: `converter/tests/helpers.ts` → `convertFixture(fixture, to)` runs a registered handler on `tests/fixtures/<file>` in a temp dir; `hasTool(cmd)` is used to skip tests when a tool is missing. Fixture: `tests/fixtures/sample.pdf` (text "Hello Converter").
- Handler signature: `(ctx: {input, workDir, from, to, options, signal}) => {path, contentType, filename}`. Use `mimeFor(ext)` from `src/mime.ts`.

## Decisions & assumptions
- matrix.json was extracted from the PNG by pixel colour (green ✓ / pink ✗ cells), and then checked visually against zoomed crops. Keys are lower-case. The matrix columns "AUDIO NOTE" and "AUDIONOTE" are both stored as `audionote`. TORRENT was added as `document.rows.torrent = ["txt"]`.
- PDF → PNG/JPG (decision): no extra "all pages" button. A single-page PDF returns the image and a multi-page PDF returns a ZIP of all pages (150 DPI). This keeps the keyboard = matrix.
- OEB output is a directory: the converter zips it (`converted.oeb.zip`) and `delivery.ts` maps `oeb` → ext `oeb.zip` (so the user gets `<name>.oeb.zip`).
- PDF → RTF goes through pdf2docx then LO (LO's direct PDF import is Draw-based and gives text boxes, not flowing text).
- GIFZ = animated GIF frames packaged as a ZIP (assumption, as the brief says). In the matrix only TGS → GIFZ is ✓.
- TGS row (from the image): WEBP, GIF, GIFZ, APNG only (no MP4).
- QT.TXT is detected by the double extension `.qt.txt`.
- Telegram voice messages → `oga`. Video notes → `mp4`. Animated sticker → `tgs`, video sticker → `webm`, static sticker → `webp`.
- Magic sniffing: OLE2 → `doc` and ZIP → `zip` are ambiguous (`zip` is not a source, so it gets rejected unless the filename/MIME resolves it).
- PDF→DOCX uses pdf2docx (pip, added to the Docker venv) because it keeps layout/tables better than LO's Draw-based PDF import. LO is the fallback.
- Converter Docker base: node:22-bookworm-slim + apt tools + a Python venv at /opt/py (fonttools, brotli, pysubs2, lottie, cairosvg, pillow-heif).

## Known issues / BLOCKED items
- **Matrix count mismatch:** the extracted matrix has 886 ✓ cells + TORRENT→TXT = **887**, but the bot advertises 874 (diff +13). Unique source formats = 89, which matches. Per section: document 84, video 197, image 207, audio 111, ebook 79, presentation 54, font 36, sheet 9, subtitle 110. The image is the source of truth, so all 887 are offered. We did not guess which 13 to drop.
- Docker is not available in the dev sandbox, so the `converter/Dockerfile` has NOT been built yet. The first agent with Docker should run `docker build` and fix package names if any fail (e.g. `unrar` needs non-free, and the Dockerfile enables contrib/non-free).
- The Worker uses `AbortSignal.any` (needs compatibility_date ≥ 2024; it is set to 2024-11-01).

## Task checklist
- [x] Task 0 - Scaffold: monorepo, wrangler, webhook+secret, /start & Menu, intake/detection, 20MB guard, KV session, matrix.json + check-matrix, ConverterClient, converter skeleton (/health, registry), Dockerfile, README, set-webhook
- [x] Task 1 - PDF → DOCX end-to-end (keyboard → converter → reply)
- [x] Task 2 - PDF → TXT, RTF, EPUB, MOBI, AZW3, LRF, OEB, PDB, FB2, RB
- [x] Task 3 - PDF → PNG, JPG (multi-page zip / first page)
- [ ] Task 4 - DOC → PDF, DOCX, TXT, RTF, ODT
- [ ] Task 5 - DOCX → all ✓ document targets
- [ ] Task 6 - TXT and TEXT → all ✓ document targets
- [ ] Task 7 - RTF → all ✓ document targets
- [ ] Task 8 - ODT → all ✓ document targets
- [ ] Task 9 - Video → video containers
- [ ] Task 10 - Video → GIF, VIDEONOTE, STREAM
- [ ] Task 11 - Video → MP3, AUDIO NOTE
- [ ] Task 12 - Image raster → raster
- [ ] Task 13 - Image → PDF, SENDPHOTO, OCR
- [ ] Task 14 - Image → MP4, GIFZ, APNG (only ✓)
- [ ] Task 15 - Special image sources: TGS, HEIC, AVIF, PSD, EPS, SVG, APNG
- [ ] Task 16 - Audio → audio
- [ ] Task 17 - Audio → AUDIONOTE
- [ ] Task 18 - eBook → eBook/PDF/DOCX/TXT/RTF
- [ ] Task 19 - CBR, CBZ, DJVU rows
- [ ] Task 20 - Presentations
- [ ] Task 21 - Fonts
- [ ] Task 22 - Sheets
- [ ] Task 23 - Subtitles
- [ ] Task 24 - TORRENT → TXT + final hardening, full-matrix verification, final docs

## Next agent instructions
- Start at: **Task 4 - DOC → PDF, DOCX, TXT, RTF, ODT** (matrix `document.rows.doc` = exactly these 5; DOC → DOC/EPUB…/PNG/JPG are ✗ and already hidden by the Worker).
- Suggested: one generic LibreOffice handler in `converter/src/handlers/document.ts`, e.g. `LO_FILTERS = { pdf: "pdf:writer_pdf_Export", docx: "docx:MS Word 2007 XML", doc: "doc:MS Word 97", rtf: "rtf:Rich Text Format", odt: "odt:writer8", txt: "txt:Text (encoded):UTF8" }` and `toLibreOffice(ctx)`. Make it reusable for Tasks 5–8 (DOCX/TXT/RTF/ODT rows, plus `toEbook` for the ebook targets. Calibre reads docx/txt/rtf/odt directly; for DOC go via LO→docx first if ever needed).
- Fixture: create `converter/tests/fixtures/sample.doc` with `soffice --headless --convert-to doc` from a tiny text/odt containing "Hello Converter". Assert the text is present in the outputs (pdftotext for pdf, `textOf` for docx).
- Sandbox state (this chat): soffice 25.2, poppler (pdftotext/pdftoppm), gs, ffmpeg, calibre 8.5 (`sudo apt-get install -y calibre` took about 10 min. dpkg errors on python3-matplotlib are harmless), and pdf2docx (`pip install pdf2docx`). A new sandbox may need these re-installed. Docker is unavailable.
- Run `npm ci` in `worker/` and `converter/` first (node_modules are not committed). Tests: `cd converter && npm test`, `cd worker && npx vitest run`.
- Gotcha: `git push` needs `setup_github_environment` first in a new chat.
