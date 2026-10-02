import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { VIDEO_SOURCES, VIDEO_CONTAINER_TARGETS } from "../src/handlers/video.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.video.rows;

// Expected ffprobe format_name fragment per target.
const FORMAT: Record<string, RegExp> = {
  mp4: /mp4/, mov: /mov/, mkv: /matroska/, flv: /flv/, ts: /mpegts/, "3gp": /3gp|mp4/,
  avi: /avi/, wmv: /asf/, mpg: /mpeg/, webm: /webm|matroska/,
};

test("video container registry matches the matrix exactly", () => {
  for (const src of VIDEO_SOURCES) for (const to of VIDEO_CONTAINER_TARGETS) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

const probe = (p: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", p]).stdout.toString());

for (const src of VIDEO_SOURCES) for (const to of rows[src]!.filter((t) => VIDEO_CONTAINER_TARGETS.includes(t))) {
  test(`${src} -> ${to}`, { skip: !hasTool("ffmpeg") && "ffmpeg not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const info = probe(out.path);
      assert.match(info.format.format_name, FORMAT[to]!);
      assert.ok(info.streams.some((s: { codec_type: string }) => s.codec_type === "video"), "has video");
      assert.ok(info.streams.some((s: { codec_type: string }) => s.codec_type === "audio"), "has audio");
      assert.equal(out.filename, `converted.${to}`);
    } finally { await cleanup(); }
  });
}
