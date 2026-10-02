import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { SPECIAL_ROWS } from "../src/handlers/image-special.js";
import { imBinary } from "../src/tools/imagemagick.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.image.rows;
const allTargets: string[] = matrix.sections.image.targets ?? [...new Set(Object.values(rows).flat())];

test("SPECIAL_ROWS equals the matrix and the registry matches it", () => {
  for (const src of Object.keys(SPECIAL_ROWS)) {
    assert.deepEqual([...SPECIAL_ROWS[src]!].sort(), [...rows[src]!].sort(), src);
    for (const to of allTargets) assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

const TOOLS: Record<string, string[]> = {
  heic: [], avif: [], psd: [], eps: ["gs"], svg: ["rsvg-convert"], apng: ["ffmpeg"], tgs: ["lottie_convert.py", "ffmpeg"],
};
const hasIM = hasTool("magick") || hasTool("convert");
const identify = (p: string) => {
  const args = ["-format", "%m %w %h\n", p];
  const r = imBinary() === "magick" ? spawnSync("magick", ["identify", ...args]) : spawnSync("identify", args);
  return r.stdout.toString().trim().split("\n");
};
const FMT: Record<string, string> = {
  png: "PNG", jpg: "JPEG", jpeg: "JPEG", jp2: "JP2", webp: "WEBP", bmp: "BMP", tif: "TIFF", tiff: "TIFF", gif: "GIF",
};

for (const src of Object.keys(SPECIAL_ROWS)) for (const to of rows[src]!) {
  const tools = [...TOOLS[src]!, ...(to === "ocr" ? ["tesseract"] : []), ...(["apng", "mp4"].includes(to) ? ["ffmpeg"] : [])];
  const missing = !hasIM || tools.some((t) => !hasTool(t));
  test(`${src} -> ${to}`, { skip: missing && "tool not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const buf = readFileSync(out.path);
      if (FMT[to]) {
        const frames = identify(out.path);
        assert.equal(frames[0]!.split(" ")[0], FMT[to], "format");
        const animated = (src === "apng" || src === "tgs") && (to === "gif" || to === "webp");
        if (animated) assert.ok(frames.length > 1, "animation kept");
      } else if (to === "ico") assert.deepEqual([...buf.subarray(0, 4)], [0, 0, 1, 0]);
      else if (to === "pdf") assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
      else if (to === "sendphoto") assert.deepEqual([...buf.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      else if (to === "ocr") assert.match(buf.toString(), /Hello\s+Converter/i);
      else if (to === "apng") assert.ok(buf.includes("acTL"), "APNG acTL chunk");
      else if (to === "mp4") assert.ok(buf.includes("ftyp") && buf.includes("avc1"), "H.264 MP4");
      else if (to === "gifz") {
        const list = spawnSync("unzip", ["-l", out.path]).stdout.toString();
        assert.match(list, /animation\.gif/);
        assert.match(list, /frames\/frame-000\.png/);
        assert.equal(out.filename, "converted.zip");
      }
    } finally { await cleanup(); }
  });
}

test("invalid TGS gives 422", { skip: !hasTool("lottie_convert.py") && "no lottie" }, async () => {
  const { tgsHandler } = await import("../src/handlers/image-special.js");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/tgs-bad-");
  try {
    await writeFile(`${dir}/input.tgs`, "not gzip");
    await assert.rejects(tgsHandler({ input: `${dir}/input.tgs`, workDir: dir, from: "tgs", to: "gif", options: {}, signal: AbortSignal.timeout(10_000) }),
      (e: { status?: number }) => e.status === 422);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
