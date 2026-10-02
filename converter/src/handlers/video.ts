// Video -> video container conversions via ffmpeg.
// Always re-encodes into a codec pair that the target container is known to
// support (reliable for any input). Audio is optional (`-map 0:a:0?`).
import { join } from "node:path";
import { register } from "../registry.js";
import { run } from "../run.js";
import { mimeFor } from "../mime.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";
import { MP3_ARGS, VOICE_ARGS } from "../tools/audio-args.js";

export const VIDEO_SOURCES = ["mp4", "avi", "wmv", "mkv", "3gp", "3gpp", "mpg", "mpeg", "webm", "ts", "mov", "flv", "asf", "vob"];
export const VIDEO_CONTAINER_TARGETS = ["mp4", "avi", "wmv", "mkv", "3gp", "mpg", "webm", "ts", "mov", "flv"];

const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "128k"];
const MPEG2 = ["-c:v", "mpeg2video", "-q:v", "3", "-r", "25", "-pix_fmt", "yuv420p"];

/** Per-target muxer + codec args. */
export const VIDEO_ARGS: Record<string, string[]> = {
  mp4: ["-f", "mp4", ...H264, ...AAC, "-movflags", "+faststart"],
  mov: ["-f", "mov", ...H264, ...AAC, "-movflags", "+faststart"],
  mkv: ["-f", "matroska", ...H264, ...AAC],
  flv: ["-f", "flv", ...H264, ...AAC, "-ar", "44100"],
  ts: ["-f", "mpegts", ...H264, ...AAC],
  "3gp": ["-f", "3gp", ...H264, "-profile:v", "baseline", ...AAC, "-ac", "1", "-ar", "22050", "-b:a", "64k"],
  avi: ["-f", "avi", "-c:v", "mpeg4", "-q:v", "4", "-tag:v", "XVID", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame", "-q:a", "4"],
  wmv: ["-f", "asf", "-c:v", "wmv2", "-q:v", "4", "-c:a", "wmav2", "-b:a", "128k"],
  mpg: ["-f", "mpeg", ...MPEG2, "-c:a", "mp2", "-b:a", "192k", "-ar", "48000"],
  webm: ["-f", "webm", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-crf", "10", "-b:v", "1M",
    "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "96k", "-ar", "48000"],
};

// Even dimensions are required by yuv420p encoders (x264, mpeg2).
const EVEN = ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"];

export async function ffmpeg(args: string[], ctx: JobContext): Promise<void> {
  await run("ffmpeg", ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", ...args], { cwd: ctx.workDir, signal: ctx.signal });
}

export async function videoToContainer(ctx: JobContext): Promise<JobOutput> {
  const spec = VIDEO_ARGS[ctx.to];
  if (!spec) throw new HttpError(400, `unsupported video target ${ctx.to}`);
  const out = join(ctx.workDir, `converted.${ctx.to}`);
  await ffmpeg(["-i", ctx.input, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", ...EVEN, ...spec, out], ctx);
  return { path: out, contentType: mimeFor(ctx.to), filename: `converted.${ctx.to}` };
}

// ✗ cells in the matrix besides the diagonal (3gpp≈3gp, mpeg≈mpg, vob->mkv).
const SKIP: Record<string, string> = { "3gpp": "3gp", mpeg: "mpg", vob: "mkv" };

for (const src of VIDEO_SOURCES) {
  register(src, VIDEO_CONTAINER_TARGETS.filter((t) => t !== src && SKIP[src] !== t), videoToContainer);
}

// ---- Task 10: GIF, VIDEONOTE, STREAM ----
export const GIF_MAX_SECONDS = "15";
export const VIDEONOTE_MAX_SECONDS = "60";

/** Animated GIF: 10 fps, max 480 px wide, optimal palette, first 15 s. */
export async function videoToGif(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.gif");
  const vf = "fps=10,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4";
  await ffmpeg(["-t", GIF_MAX_SECONDS, "-i", ctx.input, "-map", "0:v:0", "-an", "-vf", vf, "-loop", "0", "-f", "gif", out], ctx);
  return { path: out, contentType: mimeFor("gif"), filename: "converted.gif" };
}

/** Telegram video note: square 640x640 H.264/AAC MP4, max 60 s. */
export async function videoToVideoNote(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.mp4");
  const vf = "crop='min(iw,ih)':'min(iw,ih)',scale=640:640,setsar=1";
  await ffmpeg(["-i", ctx.input, "-t", VIDEONOTE_MAX_SECONDS, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", vf,
    ...VIDEO_ARGS.mp4!, out], ctx);
  return { path: out, contentType: mimeFor("mp4"), filename: "converted.mp4" };
}

/** Streamable MP4 (moov atom first), max 1280 px wide. */
export async function videoToStream(ctx: JobContext): Promise<JobOutput> {
  const out = join(ctx.workDir, "converted.mp4");
  const vf = "scale='min(1280,iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2";
  await ffmpeg(["-i", ctx.input, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", vf, ...VIDEO_ARGS.mp4!, out], ctx);
  return { path: out, contentType: mimeFor("mp4"), filename: "converted.mp4" };
}

register(VIDEO_SOURCES, "gif", videoToGif);
register(VIDEO_SOURCES, "videonote", videoToVideoNote);
register(VIDEO_SOURCES, "stream", videoToStream);

// ---- Task 11: MP3, AUDIO NOTE (audio extraction) ----
async function hasAudio(ctx: JobContext): Promise<boolean> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", ctx.input],
    { cwd: ctx.workDir, signal: ctx.signal });
  return stdout.trim().length > 0;
}

function extractAudio(ext: string, args: string[]) {
  return async (ctx: JobContext): Promise<JobOutput> => {
    if (!(await hasAudio(ctx))) throw new HttpError(422, "the video has no audio track");
    const out = join(ctx.workDir, `converted.${ext}`);
    await ffmpeg(["-i", ctx.input, "-map", "0:a:0", "-vn", "-sn", "-dn", ...args, out], ctx);
    return { path: out, contentType: mimeFor(ext), filename: `converted.${ext}` };
  };
}

register(VIDEO_SOURCES, "mp3", extractAudio("mp3", MP3_ARGS));
register(VIDEO_SOURCES, "audionote", extractAudio("ogg", VOICE_ARGS));
