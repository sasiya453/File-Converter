// Reusable ffmpeg audio encoder argument sets (video audio extraction, audio tasks).
export const MP3_ARGS = ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"];
/** Telegram voice message: OGG/Opus mono. */
export const VOICE_ARGS = ["-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-application", "voip", "-f", "ogg"];
