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
