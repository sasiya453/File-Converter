import { describe, it, expect } from "vitest";
import { targetsFor, isAllowed, matrixCounts } from "../src/matrix";
import { buildKeyboard, decodeCallback } from "../src/flow/keyboard";
import { deliveryFor } from "../src/matrix/delivery";

describe("matrix", () => {
  it("diagonal is never allowed", () => {
    for (const g of targetsFor("pdf")) expect(g.targets).not.toContain("pdf");
    expect(isAllowed("video", "mp4", "mp4")).toBe(false);
  });
  it("PDF document row matches the image", () => {
    expect(targetsFor("pdf")).toEqual([{ section: "document",
      targets: ["docx", "txt", "rtf", "epub", "mobi", "azw3", "lrf", "oeb", "pdb", "fb2", "rb", "png", "jpg"] }]);
  });
  it("DOC honours ✗ cells", () => {
    expect(targetsFor("doc")[0]!.targets).toEqual(["pdf", "docx", "txt", "rtf", "odt"]);
  });
  it("SVG appears in image and font sections", () => {
    expect(targetsFor("svg").map((g) => g.section)).toEqual(["image", "font"]);
  });
  it("TGS row", () => {
    expect(targetsFor("tgs")[0]!.targets).toEqual(["webp", "gif", "gifz", "apng"]);
  });
  it("torrent -> txt only", () => {
    expect(targetsFor("torrent")).toEqual([{ section: "document", targets: ["txt"] }]);
  });
  it("counts", () => {
    expect(matrixCounts().total).toBe(887);
  });
});

describe("keyboard", () => {
  it("4 buttons per row, callback < 64 bytes, roundtrip", () => {
    for (const src of ["pdf", "mp4", "png", "svg", "qt.txt", "ppsm"]) {
      const kb = buildKeyboard(targetsFor(src));
      for (const row of kb) {
        expect(row.length).toBeLessThanOrEqual(4);
        for (const b of row) {
          expect(new TextEncoder().encode(b.callback_data).length).toBeLessThan(64);
          if (b.callback_data !== "noop") expect(decodeCallback(b.callback_data)).not.toBeNull();
        }
      }
    }
  });
  it("section headers only when multiple sections", () => {
    expect(buildKeyboard(targetsFor("svg"))[0]![0]!.callback_data).toBe("noop");
    expect(buildKeyboard(targetsFor("pdf"))[0]![0]!.callback_data).not.toBe("noop");
  });
});

describe("delivery", () => {
  it("special modes", () => {
    expect(deliveryFor("video", "videonote").method).toBe("sendVideoNote");
    expect(deliveryFor("video", "stream").extra).toEqual({ supports_streaming: true });
    expect(deliveryFor("audio", "audionote").method).toBe("sendVoice");
    expect(deliveryFor("image", "sendphoto").method).toBe("sendPhoto");
    expect(deliveryFor("image", "ocr").ext).toBe("txt");
    expect(deliveryFor("image", "gifz").ext).toBe("zip");
  });
});
