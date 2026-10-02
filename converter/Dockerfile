# File-Converter service. Built for a Hugging Face Docker Space:
#   - runs as uid 1000 (HF runs containers as uid 1000; the base image's `node` user has it)
#   - listens on $PORT (default 7860 = HF app_port)
#   - writes only to /tmp (WORK_ROOT=/tmp/work, HOME=/tmp/home); no persistent disk needed
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# contrib/non-free is needed for p7zip-rar (RAR4/RAR5 support in 7z for CBR input; no separate unrar).
# Slimmed in Task H4: no inkscape (SVG/EPS go through rsvg-convert / Ghostscript), no JRE (the
# Writer/Calc/Impress filters we use don't need Java), no python3-pip (the venv has its own pip).
# Docs/man pages/locales are dropped via dpkg path-exclude and pruned in the same layer.
RUN printf 'path-exclude /usr/share/doc/*\npath-include /usr/share/doc/*/copyright\npath-exclude /usr/share/man/*\npath-exclude /usr/share/info/*\npath-exclude /usr/share/locale/*\npath-include /usr/share/locale/locale.alias\npath-exclude /usr/share/help/*\npath-exclude /usr/share/gtk-doc/*\n' > /etc/dpkg/dpkg.cfg.d/01-slim \
 && sed -i 's/Components: main/Components: main contrib non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      imagemagick ghostscript poppler-utils \
      calibre \
      fontforge python3-fontforge woff2 \
      tesseract-ocr tesseract-ocr-eng \
      librsvg2-bin \
      libheif-examples libavif-bin \
      djvulibre-bin p7zip-full p7zip-rar zip unzip \
      python3 python3-venv \
      fonts-dejavu fonts-liberation fonts-noto-core \
      ca-certificates tini \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && rm -rf /usr/share/doc/*/[!c]* /usr/share/man /usr/share/info /usr/share/help /usr/share/gtk-doc \
 && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name locale.alias -exec rm -rf {} + \
 && rm -rf /usr/lib/libreoffice/share/gallery /usr/lib/libreoffice/share/template /usr/lib/libreoffice/help
# Python tools: fontTools(+brotli for woff2), pysubs2 (subtitles), lottie + cairosvg (TGS rendering;
# plain `lottie`, NOT `lottie[gif]`: that extra pulls a 150 MB glaxnimate wheel built for CPython 3.13,
# which bookworm's 3.11 can't import anyway, so lottie always renders via cairosvg), pdf2docx, img2pdf.
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir --no-compile \
      "fonttools[woff]" brotli pysubs2 lottie cairosvg pillow pdf2docx img2pdf \
 && /opt/py/bin/pip uninstall -y pip \
 && find /opt/py -name '__pycache__' -prune -exec rm -rf {} + \
 && find /opt/py -name 'tests' -path '*site-packages/*' -prune -exec rm -rf {} +
ENV PATH="/opt/py/bin:${PATH}"
# Relax ImageMagick policy for PDF/EPS (Ghostscript), keep resource limits.
RUN for f in /etc/ImageMagick-6/policy.xml; do \
      [ -f "$f" ] && sed -i 's/rights="none" pattern="\(PDF\|PS\|EPS\|XPS\)"/rights="read|write" pattern="\1"/' "$f"; done; true

# /work is kept for `docker run -v` users; on HF the default WORK_ROOT is /tmp/work.
RUN mkdir -p /work /tmp/work /tmp/home && chown 1000:1000 /work /tmp/work /tmp/home
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY py ./py
COPY package.json ./
USER 1000
ENV NODE_ENV=production PORT=7860 WORK_ROOT=/tmp/work HOME=/tmp/home \
    XDG_CONFIG_HOME=/tmp/home/.config XDG_CACHE_HOME=/tmp/home/.cache TMPDIR=/tmp \
    JOB_TIMEOUT_MS=120000
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
