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

// ---- Task 10: GIF, VIDEONOTE, STREAM ----
const SPECIAL = ["gif", "videonote", "stream"];

test("gif/videonote/stream registry matches the matrix", () => {
  for (const src of VIDEO_SOURCES) for (const to of SPECIAL) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

/** True when the MP4 'moov' box comes before 'mdat' (faststart). */
function moovFirst(path: string): boolean {
  const b = readFileSync(path);
  return b.indexOf("moov") !== -1 && b.indexOf("moov") < b.indexOf("mdat");
}

for (const src of VIDEO_SOURCES) for (const to of SPECIAL) {
  test(`${src} -> ${to}`, { skip: !hasTool("ffmpeg") && "ffmpeg not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const info = probe(out.path);
      const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      if (to === "gif") {
        assert.equal(info.format.format_name, "gif");
        assert.equal(out.filename, "converted.gif");
      } else {
        assert.match(info.format.format_name, /mp4/);
        assert.equal(v.codec_name, "h264");
        assert.equal(out.filename, "converted.mp4");
        assert.ok(moovFirst(out.path), "faststart");
        if (to === "videonote") {
          assert.equal(v.width, 640); assert.equal(v.height, 640);
          assert.ok(Number(info.format.duration) <= 60.5);
        }
      }
    } finally { await cleanup(); }
  });
}

// ---- Task 11: MP3, AUDIO NOTE ----
for (const src of VIDEO_SOURCES) for (const to of ["mp3", "audionote"]) {
  test(`${src} -> ${to}`, { skip: !hasTool("ffmpeg") && "ffmpeg not installed" }, async () => {
    assert.ok(rows[src]!.includes(to) && lookup(src, to), "matrix + registry");
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const info = probe(out.path);
      assert.equal(info.streams.length, 1);
      const a = info.streams[0];
      if (to === "mp3") {
        assert.equal(a.codec_name, "mp3"); assert.equal(out.filename, "converted.mp3");
      } else {
        assert.equal(info.format.format_name, "ogg"); assert.equal(a.codec_name, "opus");
        assert.equal(a.channels, 1); assert.equal(out.filename, "converted.ogg");
      }
    } finally { await cleanup(); }
  });
}

test("video without audio -> mp3 gives 422", { skip: !hasTool("ffmpeg") && "ffmpeg not installed" }, async () => {
  await assert.rejects(convertFixture("noaudio.mp4", "mp3"), (e: { status?: number }) => e.status === 422);
});
