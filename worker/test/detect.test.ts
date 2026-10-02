import { describe, it, expect } from "vitest";
import { extFromName, extractFile, sniffMagic } from "../src/flow/detect";

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("detect", () => {
  it("extension from name", () => {
    expect(extFromName("a.PDF")).toBe("pdf");
    expect(extFromName("movie.qt.txt")).toBe("qt.txt");
    expect(extFromName("noext")).toBeUndefined();
  });
  it("magic bytes", () => {
    expect(sniffMagic(bytes("%PDF-1.7"))).toBe("pdf");
    expect(sniffMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe("png");
    expect(sniffMagic(bytes("\0\0\0\x18ftypheic"))).toBe("heic");
    expect(sniffMagic(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffMagic(bytes("d8:announce"))).toBe("torrent");
    expect(sniffMagic(bytes("hello"))).toBeUndefined();
  });
  it("telegram message types", () => {
    const base = { message_id: 1, chat: { id: 1, type: "private" } };
    expect(extractFile({ ...base, photo: [{ file_id: "s", file_unique_id: "s" }, { file_id: "L", file_unique_id: "L" }] })?.fileId).toBe("L");
    expect(extractFile({ ...base, voice: { file_id: "v", file_unique_id: "v" } })?.ext).toBe("oga");
    expect(extractFile({ ...base, sticker: { file_id: "t", file_unique_id: "t", is_animated: true } })?.ext).toBe("tgs");
    expect(extractFile({ ...base, document: { file_id: "d", file_unique_id: "d", file_name: "x.bin", mime_type: "application/pdf" } })?.ext).toBe("pdf");
  });
});
