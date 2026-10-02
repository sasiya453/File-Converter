import type { TgMessage } from "../telegram";
import { isKnownSource } from "../matrix";

export interface IncomingFile {
  fileId: string;
  fileSize?: number;
  fileName: string;
  mime?: string;
  /** Extension guessed from Telegram metadata (may be undefined -> sniff). */
  ext?: string;
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt", "application/rtf": "rtf", "text/rtf": "rtf",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/epub+zip": "epub", "application/x-mobipocket-ebook": "mobi",
  "application/x-bittorrent": "torrent",
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/bmp": "bmp",
  "image/tiff": "tiff", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "image/heic": "heic", "image/heif": "heic", "image/avif": "avif", "image/svg+xml": "svg",
  "image/apng": "apng", "image/jp2": "jp2", "image/vnd.adobe.photoshop": "psd",
  "application/postscript": "eps", "application/x-tgsticker": "tgs",
  "video/mp4": "mp4", "video/x-msvideo": "avi", "video/x-ms-wmv": "wmv", "video/x-matroska": "mkv",
  "video/3gpp": "3gp", "video/mpeg": "mpg", "video/webm": "webm", "video/mp2t": "ts",
  "video/quicktime": "mov", "video/x-flv": "flv", "video/x-ms-asf": "asf",
  "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/opus": "opus", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/flac": "flac", "audio/x-flac": "flac", "audio/x-ms-wma": "wma", "audio/mp4": "m4a",
  "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/aiff": "aiff", "audio/x-aiff": "aiff", "audio/amr": "amr",
  "font/ttf": "ttf", "font/otf": "otf", "font/woff": "woff", "font/woff2": "woff2",
  "application/vnd.ms-fontobject": "eot", "application/x-font-type1": "pfb",
  "text/vtt": "vtt", "application/x-subrip": "srt", "application/ttml+xml": "ttml",
};

const EXT_ALIASES: Record<string, string> = { jpe: "jpeg", tif: "tif", "3gpp": "3gpp", aif: "aiff", htm: "html" };

/** Extract the extension from a filename (handles the double extension .qt.txt). */
export function extFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase().trim();
  if (lower.endsWith(".qt.txt")) return "qt.txt";
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return undefined;
  const ext = lower.slice(dot + 1);
  return EXT_ALIASES[ext] ?? ext;
}

export function extFromMime(mime: string | undefined): string | undefined {
  return mime ? MIME_EXT[mime.toLowerCase()] : undefined;
}

/** Pull the convertible file out of a Telegram message. */
export function extractFile(msg: TgMessage): IncomingFile | undefined {
  if (msg.document) {
    const d = msg.document;
    const byName = extFromName(d.file_name);
    const ext = byName && isKnownSource(byName) ? byName : extFromMime(d.mime_type) ?? byName;
    return { fileId: d.file_id, fileSize: d.file_size, fileName: d.file_name ?? "file", mime: d.mime_type, ext };
  }
  if (msg.photo && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1]!; // largest size
    return { fileId: p.file_id, fileSize: p.file_size, fileName: "photo.jpg", ext: "jpg" };
  }
  const media = msg.video ?? msg.audio ?? msg.animation;
  if (media) {
    const ext = extFromName(media.file_name) ?? extFromMime(media.mime_type);
    const fallback = msg.audio ? "mp3" : "mp4";
    return { fileId: media.file_id, fileSize: media.file_size, fileName: media.file_name ?? `file.${ext ?? fallback}`,
      mime: media.mime_type, ext: ext ?? fallback };
  }
  if (msg.voice) {
    return { fileId: msg.voice.file_id, fileSize: msg.voice.file_size, fileName: "voice.oga", ext: "oga" };
  }
  if (msg.video_note) {
    return { fileId: msg.video_note.file_id, fileSize: msg.video_note.file_size, fileName: "video_note.mp4", ext: "mp4" };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    const ext = s.is_animated ? "tgs" : s.is_video ? "webm" : "webp";
    return { fileId: s.file_id, fileSize: s.file_size, fileName: `sticker.${ext}`, ext };
  }
  return undefined;
}

/** Detect format from the first bytes of a file (magic numbers). */
export function sniffMagic(b: Uint8Array): string | undefined {
  const s = (o: number, sig: number[]) => sig.every((v, i) => b[o + i] === v);
  const ascii = (o: number, len: number) => String.fromCharCode(...b.slice(o, o + len));
  if (s(0, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (s(0, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (s(0, [0xff, 0xd8, 0xff])) return "jpg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return "avi";
  if (ascii(0, 2) === "BM") return "bmp";
  if (s(0, [0x49, 0x49, 0x2a, 0x00]) || s(0, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (s(0, [0x00, 0x00, 0x01, 0x00])) return "ico";
  if (ascii(0, 4) === "8BPS") return "psd";
  if (s(0, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20])) return "jp2";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "heic";
    if (brand === "avif") return "avif";
    if (brand.startsWith("3gp")) return "3gp";
    if (brand === "M4A ") return "m4a";
    if (brand === "qt  ") return "mov";
    return "mp4";
  }
  if (s(0, [0x1a, 0x45, 0xdf, 0xa3])) return ascii(0, 64).includes("webm") ? "webm" : "mkv";
  if (ascii(0, 3) === "FLV") return "flv";
  if (s(0, [0x30, 0x26, 0xb2, 0x75])) return "wmv"; // ASF container
  if (s(0, [0x00, 0x00, 0x01, 0xba])) return "mpg";
  if (b[0] === 0x47 && b[188] === 0x47) return "ts";
  if (ascii(0, 3) === "ID3" || s(0, [0xff, 0xfb]) || s(0, [0xff, 0xf3])) return "mp3";
  if (s(0, [0xff, 0xf1]) || s(0, [0xff, 0xf9])) return "aac";
  if (ascii(0, 4) === "OggS") return ascii(28, 8) === "OpusHead" ? "opus" : "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "FORM" && ascii(8, 4) === "AIFF") return "aiff";
  if (ascii(0, 6) === "#!AMR\n") return "amr";
  if (s(0, [0x1f, 0x8b])) return "tgs"; // gzip; on Telegram this is almost always an animated sticker
  if (ascii(0, 4) === "wOFF") return "woff";
  if (ascii(0, 4) === "wOF2") return "woff2";
  if (ascii(0, 4) === "OTTO") return "otf";
  if (s(0, [0x00, 0x01, 0x00, 0x00])) return "ttf";
  if (ascii(0, 5) === "{\\rtf") return "rtf";
  if (ascii(0, 4) === "AT&T" && ascii(4, 4) === "FORM") return "djvu";
  if (ascii(0, 4) === "Rar!") return "cbr";
  if (ascii(0, 11) === "d8:announce") return "torrent";
  if (s(0, [0xd0, 0xcf, 0x11, 0xe0])) return "doc"; // OLE2 (doc/xls/ppt) - ambiguous
  if (ascii(0, 4) === "PK\u0003\u0004") return "zip";   // docx/xlsx/pptx/epub/cbz - ambiguous
  if (ascii(0, 6) === "WEBVTT") return "vtt";
  if (ascii(0, 5) === "<?xml" || ascii(0, 4) === "<svg") return ascii(0, 64).includes("svg") ? "svg" : undefined;
  return undefined;
}
