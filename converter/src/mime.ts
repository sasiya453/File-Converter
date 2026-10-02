const MIME: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text",
  epub: "application/epub+zip", mobi: "application/x-mobipocket-ebook", azw3: "application/vnd.amazon.ebook",
  lrf: "application/x-sony-bbeb", pdb: "application/vnd.palm", fb2: "application/x-fictionbook+xml",
  rb: "application/x-rocketbook", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  svg: "image/svg+xml", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};
export const mimeFor = (ext: string) => MIME[ext.toLowerCase()] ?? "application/octet-stream";
