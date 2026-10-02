# Stateless conversion service with all native tools.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# Enable contrib/non-free for unrar.
RUN sed -i 's/Components: main/Components: main contrib non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw default-jre-headless \
      imagemagick ghostscript poppler-utils \
      calibre \
      fontforge python3-fontforge woff2 \
      tesseract-ocr tesseract-ocr-eng \
      inkscape librsvg2-bin \
      libheif-examples libavif-bin \
      djvulibre-bin unrar p7zip-full p7zip-rar zip unzip \
      python3 python3-pip python3-venv \
      fonts-dejavu fonts-liberation fonts-noto-core \
      ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# Python tools: fontTools(+brotli for woff2), pysubs2 (subtitles), lottie (TGS rendering)
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir \
      "fonttools[woff]" brotli pysubs2 "lottie[gif]" cairosvg pillow pillow-heif pdf2docx img2pdf
ENV PATH="/opt/py/bin:${PATH}"
# Relax ImageMagick policy for PDF/EPS (Ghostscript), keep resource limits.
RUN for f in /etc/ImageMagick-6/policy.xml; do \
      [ -f "$f" ] && sed -i 's/rights="none" pattern="\(PDF\|PS\|EPS\|XPS\)"/rights="read|write" pattern="\1"/' "$f"; done; true

RUN useradd --create-home --uid 10001 converter && mkdir -p /work && chown converter /work
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
USER converter
ENV NODE_ENV=production PORT=8080 WORK_ROOT=/work JOB_TIMEOUT_MS=120000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
