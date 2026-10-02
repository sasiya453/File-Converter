// Audio -> audio conversions via ffmpeg. Always re-encodes the first audio
// stream (cover art / video streams are dropped).
import { join } from "node:path";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";
import { MP3_ARGS } from "../tools/audio-args.js";
import { ffmpeg } from "./video.js";

export const AUDIO_SOURCES = ["mp3", "ogg", "opus", "wav", "flac", "wma", "oga", "m4a", "aac", "aiff", "amr"];
export const AUDIO_TARGETS = ["mp3", "ogg", "opus", "wav", "flac", "wma", "oga", "m4a", "aac", "aiff"];

/** Per-target encoder + muxer args. */
export const AUDIO_ARGS: Record<string, string[]> = {
  mp3: MP3_ARGS,
  ogg: ["-c:a", "libvorbis", "-q:a", "5", "-f", "ogg"],
  oga: ["-c:a", "libvorbis", "-q:a", "5", "-f", "ogg"],
  opus: ["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-f", "opus"],
  wav: ["-c:a", "pcm_s16le", "-f", "wav"],
  flac: ["-c:a", "flac", "-f", "flac"],
  wma: ["-c:a", "wmav2", "-b:a", "192k", "-f", "asf"],
  m4a: ["-c:a", "aac", "-b:a", "192k", "-f", "ipod", "-movflags", "+faststart"],
  aac: ["-c:a", "aac", "-b:a", "192k", "-f", "adts"],
  aiff: ["-c:a", "pcm_s16be", "-f", "aiff"],
};

export async function hasAudioStream(ctx: JobContext): Promise<boolean> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", ctx.input],
    { cwd: ctx.workDir, signal: ctx.signal });
  return stdout.trim().length > 0;
}

/** Generic audio encoder: `ext` = output file extension, `args` = encoder/muxer args. */
export function encodeAudio(ext: string, args: string[]) {
  return async (ctx: JobContext): Promise<JobOutput> => {
    if (!(await hasAudioStream(ctx))) throw new HttpError(422, "the file has no audio stream");
    const out = join(ctx.workDir, `converted.${ext}`);
    await ffmpeg(["-i", ctx.input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "0", ...args, out], ctx);
    return { path: out, contentType: mimeFor(ext), filename: `converted.${ext}` };
  };
}

for (const src of AUDIO_SOURCES) {
  for (const to of AUDIO_TARGETS) if (to !== src) register(src, to, encodeAudio(to, AUDIO_ARGS[to]!));
}
