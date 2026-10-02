import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { RASTER_SOURCES, RASTER_TARGETS } from "../src/handlers/image.js";
import { imBinary } from "../src/tools/imagemagick.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.image.rows;
const hasIM = hasTool("magick") || hasTool("convert");

test("raster->raster registry matches the matrix exactly", () => {
  for (const src of RASTER_SOURCES) for (const to of RASTER_TARGETS) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

/** Image format (IM coder) + frame count + size of the first frame. */
function inspect(path: string) {
  const args = ["-format", "%m %w %h\n", path];
  const r = imBinary() === "magick" ? spawnSync("magick", ["identify", ...args]) : spawnSync("identify", args);
  const lines = r.stdout.toString().trim().split("\n");
  const [fmt, w, h] = lines[0]!.split(" ");
  return { fmt, w: Number(w), h: Number(h), frames: lines.length };
}

const FMT: Record<string, string> = {
  png: "PNG", jpg: "JPEG", jpeg: "JPEG", jp2: "JP2", webp: "WEBP", bmp: "BMP", tif: "TIFF", tiff: "TIFF", gif: "GIF", ico: "ICO",
};

for (const src of RASTER_SOURCES) for (const to of rows[src]!.filter((t) => RASTER_TARGETS.includes(t))) {
  test(`${src} -> ${to}`, { skip: !hasIM && "ImageMagick not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const info = inspect(out.path);
      if (to === "ico") assert.deepEqual([...readFileSync(out.path).subarray(0, 4)], [0, 0, 1, 0], "ICO header");
      else assert.equal(info.fmt, FMT[to], "format");
      assert.equal(out.filename, `converted.${to}`);
      if (src !== "ico") assert.deepEqual([info.w, info.h], [32, 24], "size kept");
      if (src === "ico" && to !== "ico") assert.equal(info.w, 32, "largest ICO frame used");
      if ((src === "gif" && to === "webp") || (src === "webp" && to === "gif")) assert.equal(info.frames, 3, "animation kept");
      else if (to !== "ico") assert.equal(info.frames, 1, "single frame");
    } finally { await cleanup(); }
  });
}

// ---- Task 13: PDF, SENDPHOTO, OCR ----
const SPECIAL13 = ["pdf", "sendphoto", "ocr"];

test("pdf/sendphoto/ocr registry matches the matrix for raster rows", () => {
  for (const src of RASTER_SOURCES) for (const to of SPECIAL13) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

for (const src of RASTER_SOURCES) for (const to of SPECIAL13.filter((t) => rows[src]!.includes(t))) {
  const tool = to === "ocr" ? hasTool("tesseract") : hasIM;
  test(`${src} -> ${to}`, { skip: !tool && "tool not installed" }, async () => {
    const fixture = to === "ocr" ? `ocr.${src}` : `sample.${src}`;
    const { out, cleanup } = await convertFixture(fixture, to);
    try {
      const head = readFileSync(out.path);
      if (to === "pdf") {
        assert.equal(head.subarray(0, 5).toString(), "%PDF-");
        assert.equal(out.filename, "converted.pdf");
      } else if (to === "sendphoto") {
        assert.deepEqual([...head.subarray(0, 3)], [0xff, 0xd8, 0xff], "JPEG magic");
        assert.equal(out.filename, "converted.jpg");
        assert.equal(inspect(out.path).frames, 1);
      } else {
        assert.match(head.toString(), /Hello\s+Converter/i);
        assert.equal(out.filename, "converted.txt");
      }
    } finally { await cleanup(); }
  });
}

test("sendphoto downscales big images to 2560 px", { skip: !hasIM && "no ImageMagick" }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "sp-"));
  try {
    const input = join(dir, "input.png");
    spawnSync(imBinary(), ["-size", "4000x1000", "xc:red", input]);
    const out = await lookup("png", "sendphoto")!({ input, workDir: dir, from: "png", to: "sendphoto", options: {}, signal: AbortSignal.timeout(30_000) });
    assert.deepEqual([inspect(out.path).w, inspect(out.path).h], [2560, 640]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ocr on a blank image returns 422", { skip: !hasTool("tesseract") && "no tesseract" }, async () => {
  await assert.rejects(convertFixture("sample.bmp", "ocr"), (e: { status?: number }) => e.status === 422);
});

// ---- Task 14: APNG, MP4 (GIFZ only exists for TGS -> Task 15) ----
const SPECIAL14 = ["apng", "mp4", "gifz"];

test("apng/mp4/gifz registry matches the matrix for raster rows", () => {
  for (const src of RASTER_SOURCES) for (const to of SPECIAL14) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

const probeFrames = (p: string) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", p]);
  return JSON.parse(r.stdout.toString()).streams[0] as { codec_name: string; width: number; height: number; nb_read_frames: string };
};

for (const src of RASTER_SOURCES) for (const to of ["apng", "mp4"].filter((t) => rows[src]!.includes(t))) {
  test(`${src} -> ${to}`, { skip: !(hasIM && hasTool("ffmpeg")) && "tools not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const s = probeFrames(out.path);
      assert.equal(out.filename, `converted.${to}`);
      if (to === "apng") {
        assert.ok(readFileSync(out.path).includes("acTL"), "has acTL (animated PNG)");
        assert.equal(s.codec_name, "apng");
        assert.equal(Number(s.nb_read_frames), src === "gif" || src === "webp" ? 3 : 2, "frames");
      } else {
        assert.equal(s.codec_name, "h264");
        assert.deepEqual([s.width, s.height], [32, 24]);
      }
    } finally { await cleanup(); }
  });
}
