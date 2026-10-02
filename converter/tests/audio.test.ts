import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { convertFixture, hasTool } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { AUDIO_SOURCES, AUDIO_TARGETS } from "../src/handlers/audio.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const rows: Record<string, string[]> = matrix.sections.audio.rows;

// Expected [format_name, codec_name] per target.
const EXPECT: Record<string, [RegExp, string]> = {
  mp3: [/mp3/, "mp3"], ogg: [/ogg/, "vorbis"], oga: [/ogg/, "vorbis"], opus: [/ogg/, "opus"],
  wav: [/wav/, "pcm_s16le"], flac: [/flac/, "flac"], wma: [/asf/, "wmav2"], m4a: [/mp4|m4a/, "aac"],
  aac: [/aac/, "aac"], aiff: [/aiff/, "pcm_s16be"],
};

test("audio source list matches the matrix rows", () => {
  assert.deepEqual([...AUDIO_SOURCES].sort(), Object.keys(rows).sort());
});

test("audio -> audio registry matches the matrix exactly", () => {
  for (const src of AUDIO_SOURCES) for (const to of AUDIO_TARGETS) {
    assert.equal(!!lookup(src, to), rows[src]!.includes(to), `${src}->${to}`);
  }
});

const probe = (p: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", p]).stdout.toString());

for (const src of AUDIO_SOURCES) for (const to of rows[src]!.filter((t) => AUDIO_TARGETS.includes(t))) {
  test(`${src} -> ${to}`, { skip: !hasTool("ffmpeg") && "ffmpeg not installed" }, async () => {
    const { out, cleanup } = await convertFixture(`sample.${src}`, to);
    try {
      const info = probe(out.path);
      const [fmt, codec] = EXPECT[to]!;
      assert.match(info.format.format_name, fmt);
      assert.equal(info.streams.length, 1, "exactly one stream");
      assert.equal(info.streams[0].codec_name, codec);
      assert.ok(Number(info.format.duration) > 0.3, "duration kept");
      assert.equal(out.filename, `converted.${to}`);
    } finally { await cleanup(); }
  });
}

test("video-only input is rejected with 422", { skip: !hasTool("ffmpeg") && "ffmpeg not installed" }, async () => {
  // noaudio.mp4 renamed as m4a: an audio container without an audio stream.
  const { copyFile, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    const input = join(dir, "input.m4a");
    await copyFile(new URL("./fixtures/noaudio.mp4", import.meta.url).pathname, input);
    await assert.rejects(lookup("m4a", "mp3")!({ input, workDir: dir, from: "m4a", to: "mp3", options: {}, signal: AbortSignal.timeout(30_000) }),
      (e: { status?: number }) => e.status === 422);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
