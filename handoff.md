# Handoff
## Project status
- Last completed task: 15 - Special image sources (commit f98d383)
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
- `converter/src/handlers/document.ts` (Task 4): `LO_WRITER_FILTERS` (pdf/doc/docx/rtf/odt/txt) + generic `toLibreOffice(ctx)` handler; `doc->{pdf,docx,txt,rtf,odt}` registered with it. Fixture `tests/fixtures/sample.doc` ("Hello Converter", made with soffice from txt). Tests assert the text in each output (pdftotext / docx XML / odt content.xml).
- Task 5: `docx->{pdf,doc,txt,rtf,odt}` via `toLibreOffice`, `docx->EBOOK_TARGETS` via `toEbook`. Fixture `tests/fixtures/sample.docx`. Tests: the `WRITER_ROWS` map (fixture → LO targets) in `tests/document.test.ts`, plus an ebook loop per source (DOC output text is checked with `soffice --cat`).
- `converter/src/tools/calibre.ts`: `ebookConvert(input, workDir, ext, signal, extraArgs)` and `zipDir(dir, ...)`.
- Task 6: `txt|text->{pdf,doc,docx,rtf,odt}` via `textToLibreOffice` (LO `--infilter=Text (encoded):UTF8`), `txt|text->EBOOK_TARGETS` via `textToEbook`. `.text` input is copied to `input-text.txt` first (`asTxt`) because LO/Calibre pick the import filter by extension. Fixtures `sample.txt`/`sample.text` (UTF-8). There is also a UTF-8 round-trip test.
- Task 7: `rtf->{pdf,doc,docx,txt,odt}` via `toLibreOffice`, `rtf->EBOOK_TARGETS` via `toEbook`. Fixture `sample.rtf` (made from sample.docx with soffice).
- Task 8: `odt->{pdf,doc,docx,txt,rtf}` via `toLibreOffice`, `odt->EBOOK_TARGETS` via `toEbook`. Fixture `sample.odt`. The DOCUMENT section is now complete except TORRENT (Task 24).
- Task 9: `converter/src/handlers/video.ts`: `VIDEO_SOURCES` (14 rows), `VIDEO_CONTAINER_TARGETS` (10), `VIDEO_ARGS` table (muxer + codecs per target; always re-encodes: H.264/AAC for mp4/mov/mkv/flv/ts/3gp, MPEG-4 Part 2 + MP3 for avi, WMV2/WMA2 for wmv, MPEG-2/MP2 for mpg, VP8/Opus for webm), an even-size scale filter, `-map 0:v:0 -map 0:a:0?` (audio optional). Exported `ffmpeg(args, ctx)` helper (reuse it in Tasks 10/11/16). Non-diagonal ✗ in the rows: 3gpp→3gp, mpeg→mpg, vob→mkv (the `SKIP` map). Fixtures `tests/fixtures/sample.<14 video exts>` (0.5 s 64x48 testsrc + sine). `tests/video.test.ts` checks registry == matrix for container targets and ffprobes each output (format, video+audio streams); 128 tests pass in ~50 s.
- Task 10 (also in `video.ts`): `videoToGif` (first 15 s, 10 fps, width ≤ 480, palettegen/paletteuse, loop), `videoToVideoNote` (center crop to square, 640x640, `-t 60`, H.264/AAC faststart → `converted.mp4`), `videoToStream` (width ≤ 1280, H.264/AAC faststart MP4). Registered for all 14 video sources. Tests check gif format, h264, 640x640, ≤ 60 s, and moov before mdat.
- Task 11 (in `video.ts`): `extractAudio(ext, args)` checks for an audio stream with ffprobe (422 "the video has no audio track" otherwise; the Worker maps 422 to its "unsupported" message), then `mp3` (`MP3_ARGS`, libmp3lame V2) or `audionote` (`VOICE_ARGS`: OGG/Opus mono 48 kHz 48k voip → `converted.ogg`). Reusable arg sets are in `converter/src/tools/audio-args.ts`. Fixture `noaudio.mp4`. The VIDEO section is now complete (197 conversions; 200 tests in tests/video.test.ts, ~75 s).
- Task 12: `converter/src/tools/imagemagick.ts`: `magick(args, cwd, signal)` uses IM7 `magick` when present, else IM6 `convert` (the Docker image is bookworm = IM6), with `-limit` resource caps. `identify()` works the same way. `converter/src/handlers/image.ts`: `RASTER_SOURCES`/`RASTER_TARGETS` (png,jpg,jpeg,jp2,webp,bmp,tif,tiff,gif,ico) → `rasterToRaster`. It always writes with an explicit coder prefix (`JPEG:out`), uses frame `[0]` for still targets (the LARGEST frame for ICO sources), flattens JPG on white, uses LZW for TIFF, and downscales ICO to ≤256 px (`256x256>`). GIF↔WEBP keeps the animation (`-coalesce`), falling back to the first frame if that fails. Fixtures `sample.{png,jpg,jpeg,jp2,webp,bmp,tif,tiff,gif,ico}` (32x24; gif/webp have 3 frames, ico is 32+16). `tests/image.test.ts`: registry == matrix for raster targets + format/size/frame checks (91 tests, ~5 s). Reuse `magick()` and `RASTER_SOURCES` in Tasks 13–15.
- Task 13 (in `image.ts`): `imageToPdf` (1 page, frame 0 or the largest ICO frame, flattened on white, JPEG-compressed, `PDF:` coder), `imageToSendPhoto` (JPEG q85, ≤ 2560 px on the long side, `converted.jpg`), `imageToOcr` (grayscale PNG upscaled to ≥ 1000 px → `tesseract … -l eng` → `converted.txt`, 422 when empty; optional `options.lang` validated by regex). Registered for all 10 raster rows (OCR is ✗ for gif/ico). These handlers are generic, so Task 15 can register them for HEIC/AVIF/PSD/EPS/SVG/APNG if IM can read those (otherwise pre-convert to PNG first). OCR fixtures `tests/fixtures/ocr.{png,jpg,jpeg,jp2,webp,bmp,tif,tiff}` ("Hello Converter"). image.test.ts now has 122 tests.
- Task 14 (in `image.ts`): `ffmpegReadable(ctx)` normalises the input for ffmpeg: GIF as is, animated WebP → coalesced GIF (ffmpeg can't decode animated WebP), anything else → PNG32 of frame 0. `imageToApng` (`-f apng -plays 0` → `converted.apng`, MIME image/apng; still images become a 2-frame identical APNG so the acTL chunk exists) is registered for the 9 raster rows except ICO. `imageToMp4` (H.264 yuv420p faststart, transparency on white, even size; still input → 3 s clip) is registered for gif only. **GIFZ: no raster row has ✓; only TGS (Task 15).** image.test.ts: 133 tests.
- Task 15: `converter/src/handlers/image-special.ts`: `SPECIAL_ROWS` (a copy of the matrix rows; a test asserts it equals matrix.json). Each source is normalised and then sent through the generic image.ts handlers (`generic()`): HEIC/AVIF/PSD → IM with an explicit coder (`HEIC:in[0]`; fallbacks `heif-convert`, `avifdec`) → PNG32. EPS → Ghostscript (`-dSAFER -dEPSCrop pngalpha 150 dpi`; EPS→PDF uses gs pdfwrite = vector). SVG → `rsvg-convert` PNG (SVG→PDF uses rsvg-convert -f pdf = vector). APNG → ffmpeg `-f apng` (frame 0 for still targets; →GIF/WEBP/MP4 keep the animation via palettegen GIF). TGS → gunzip (16 MB cap, 422 if invalid) → `lottie_convert.py` GIF → **re-encoded with ffmpeg** (python-lottie GIFs have palette indices that ImageMagick rejects) → gif / webp (animated, IM) / apng / gifz. GIFZ zip = `animation.gif` + `frames/frame-000.png…`. Fixtures `sample.{heic,avif,psd,eps,svg,apng,tgs}` (the heic/avif/psd/eps/svg ones contain the text "Hello Converter" for OCR). `tests/image-special.test.ts`: 81 tests. **The IMAGE section is now complete (207).**
- Tests: `converter/tests/helpers.ts` → `convertFixture(fixture, to)` runs a registered handler on `tests/fixtures/<file>` in a temp dir; `hasTool(cmd)` is used to skip tests when a tool is missing. Fixture: `tests/fixtures/sample.pdf` (text "Hello Converter").
- Handler signature: `(ctx: {input, workDir, from, to, options, signal}) => {path, contentType, filename}`. Use `mimeFor(ext)` from `src/mime.ts`.

## Decisions & assumptions
- matrix.json was extracted from the PNG by pixel colour (green ✓ / pink ✗ cells), and then checked visually against zoomed crops. Keys are lower-case. The matrix columns "AUDIO NOTE" and "AUDIONOTE" are both stored as `audionote`. TORRENT was added as `document.rows.torrent = ["txt"]`.
- PDF → PNG/JPG (decision): no extra "all pages" button. A single-page PDF returns the image and a multi-page PDF returns a ZIP of all pages (150 DPI). This keeps the keyboard = matrix.
- OEB output is a directory: the converter zips it (`converted.oeb.zip`) and `delivery.ts` maps `oeb` → ext `oeb.zip` (so the user gets `<name>.oeb.zip`).
- PDF → RTF goes through pdf2docx then LO (LO's direct PDF import is Draw-based and gives text boxes, not flowing text).
- Video → GIF is limited to the first 15 s (to keep it under 50 MB). Video notes are cut at 60 s (Telegram limit).
- GIFZ = animated GIF frames packaged as a ZIP (assumption, as the brief says). Implementation: the ZIP contains `animation.gif` plus each frame as `frames/frame-NNN.png`. In the matrix only TGS → GIFZ is ✓.
- TGS row (from the image): WEBP, GIF, GIFZ, APNG only (no MP4).
- QT.TXT is detected by the double extension `.qt.txt`.
- TEXT source = a file with the `.text` extension (plain text). Telegram text messages are NOT converted; they get the menu/"send a file" reply.
- Telegram voice messages → `oga`. Video notes → `mp4`. Animated sticker → `tgs`, video sticker → `webm`, static sticker → `webp`.
- Magic sniffing: OLE2 → `doc` and ZIP → `zip` are ambiguous (`zip` is not a source, so it gets rejected unless the filename/MIME resolves it).
- PDF→DOCX uses pdf2docx (pip, added to the Docker venv) because it keeps layout/tables better than LO's Draw-based PDF import. LO is the fallback.
- Converter Docker base: node:22-bookworm-slim + apt tools + a Python venv at /opt/py (fonttools, brotli, pysubs2, lottie, cairosvg, pillow-heif).

## Known issues / BLOCKED items
- **Matrix count mismatch:** the extracted matrix has 886 ✓ cells + TORRENT→TXT = **887**, but the bot advertises 874 (diff +13). Unique source formats = 89, which matches. Per section: document 84, video 197, image 207, audio 111, ebook 79, presentation 54, font 36, sheet 9, subtitle 110. The image is the source of truth, so all 887 are offered. We did not guess which 13 to drop.
- Docker image: bookworm's IM6 may not read HEIC/AVIF; fallbacks `heif-convert` (libheif-examples) and `avifdec` (libavif-bin) are in the Dockerfile but untested there. Also check that `lottie_convert.py` is on PATH from /opt/py/bin.
- Docker is not available in the dev sandbox, so the `converter/Dockerfile` has NOT been built yet. The first agent with Docker should run `docker build` and fix package names if any fail (e.g. `unrar` needs non-free, and the Dockerfile enables contrib/non-free).
- The Worker uses `AbortSignal.any` (needs compatibility_date ≥ 2024; it is set to 2024-11-01).

## Task checklist
- [x] Task 0 - Scaffold: monorepo, wrangler, webhook+secret, /start & Menu, intake/detection, 20MB guard, KV session, matrix.json + check-matrix, ConverterClient, converter skeleton (/health, registry), Dockerfile, README, set-webhook
- [x] Task 1 - PDF → DOCX end-to-end (keyboard → converter → reply)
- [x] Task 2 - PDF → TXT, RTF, EPUB, MOBI, AZW3, LRF, OEB, PDB, FB2, RB
- [x] Task 3 - PDF → PNG, JPG (multi-page zip / first page)
- [x] Task 4 - DOC → PDF, DOCX, TXT, RTF, ODT
- [x] Task 5 - DOCX → all ✓ document targets
- [x] Task 6 - TXT and TEXT → all ✓ document targets
- [x] Task 7 - RTF → all ✓ document targets
- [x] Task 8 - ODT → all ✓ document targets
- [x] Task 9 - Video → video containers
- [x] Task 10 - Video → GIF, VIDEONOTE, STREAM
- [x] Task 11 - Video → MP3, AUDIO NOTE
- [x] Task 12 - Image raster → raster
- [x] Task 13 - Image → PDF, SENDPHOTO, OCR
- [x] Task 14 - Image → MP4, GIFZ, APNG (only ✓)
- [x] Task 15 - Special image sources: TGS, HEIC, AVIF, PSD, EPS, SVG, APNG
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
- Start at: **Task 16 - Audio → audio** (rows mp3, ogg, opus, wav, flac, wma, oga, m4a, aac, aiff, amr; targets mp3…aiff, NOT audionote = Task 17). Check the rows with `node -e 'const r=require("./worker/src/matrix/matrix.json").sections.audio.rows;for(const k in r)console.log(k,r[k].join(","))'`. Plan: new `converter/src/handlers/audio.ts`, reuse `ffmpeg()` from video.ts and `converter/src/tools/audio-args.ts` (MP3_ARGS exists). Per-target args: ogg = libvorbis q5, opus = libopus 128k (`-f ogg`, or `-f opus`), oga = libvorbis in ogg (`-f ogg`), wav = pcm_s16le, flac, wma = wmav2 (`-f asf`), m4a = aac 192k (`-f ipod`), aac = ADTS aac (`-f adts`), aiff = pcm_s16be (`-f aiff`). Use `-vn -map 0:a:0` (drop cover art) and 422 if there's no audio stream. Fixtures: 0.5 s sine per source (AMR via `-c:a libopencore_amrnb -ar 8000 -ac 1` if available, else check `ffmpeg -encoders | grep amr`). Add MIME types (opus, flac, wma, oga, m4a, aac, aiff, amr) to mime.ts.
- Patterns from earlier tasks: `register(src, targets, handler)`; tests use `convertFixture(fixture, to)` + `hasTool()`. The document handlers are in `converter/src/handlers/document.ts`.
- Sandbox: ffmpeg is preinstalled. soffice/calibre/pdf2docx may need reinstalling for the document tests (`pip install pdf2docx`, `sudo apt-get install -y calibre libreoffice`). Docker is unavailable.
- Run `npm ci` in `worker/` and `converter/` first. Tests: `cd converter && npm test` (the full run takes several minutes, so use `timeout 900`), or a single file: `node --import tsx --test tests/video.test.ts`. Worker: `cd worker && npx vitest run`.
- Gotcha: `git push` needs `setup_github_environment` first in a new chat.
- Gotcha: tsx one-off scripts with top-level await must be `.mts`.
