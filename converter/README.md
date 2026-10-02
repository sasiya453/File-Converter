---
title: File Converter
emoji: 🔄
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# File Converter service

This is the conversion backend for the File-Converter Telegram bot. It is a stateless
Node 22 service with ffmpeg, LibreOffice, Calibre, ImageMagick, Ghostscript, Tesseract,
FontForge and some Python tools. It supports 887 conversions in 9 families (documents,
video, images, audio, e-books, presentations, fonts, sheets, subtitles).

- `GET /health` is public and returns `{ ok, queued, running }`.
- `POST /jobs` takes an async job (Bearer `CONVERTER_TOKEN`). The service converts the
  file and uploads the result straight to Telegram.
- `POST /convert` is a synchronous fallback for local testing.

The Space needs these secrets: `CONVERTER_TOKEN` and `BOT_TOKEN`.
See the repository README for the full deployment guide.
