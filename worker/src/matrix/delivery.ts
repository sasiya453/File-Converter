// Maps a matrix target column to (a) the converter "to" value, (b) the output
// file extension and (c) the Telegram send method. Special columns are
// delivery modes, not real extensions.
import type { Section } from "./index";

export type SendMethod = "sendDocument" | "sendPhoto" | "sendVideo" | "sendVideoNote" | "sendVoice" | "sendAudio";

export interface Delivery {
  method: SendMethod;
  field: string;      // multipart field name for the method
  ext: string;        // extension of the produced file
  extra?: Record<string, string | number | boolean>;
}

const DOC = (ext: string): Delivery => ({ method: "sendDocument", field: "document", ext });

export function deliveryFor(section: Section, target: string): Delivery {
  const t = target.toLowerCase();
  switch (t) {
    case "videonote": return { method: "sendVideoNote", field: "video_note", ext: "mp4" };
    case "stream": return { method: "sendVideo", field: "video", ext: "mp4", extra: { supports_streaming: true } };
    case "audionote": return { method: "sendVoice", field: "voice", ext: "ogg" };
    case "sendphoto": return { method: "sendPhoto", field: "photo", ext: "jpg" };
    case "ocr": return DOC("txt");
    case "gifz": return DOC("zip");
    case "oeb": return DOC("oeb.zip"); // OEB is a directory; the converter zips it
    case "qt.txt": return DOC("qt.txt");
    default: return DOC(section === "video" && t === "mp3" ? "mp3" : t);
  }
}

export const BUTTON_LABEL: Record<string, string> = {
  videonote: "VIDEO NOTE", stream: "STREAM", audionote: "AUDIO NOTE", sendphoto: "SEND PHOTO",
};
