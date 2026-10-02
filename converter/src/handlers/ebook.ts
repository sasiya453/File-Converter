// eBook family (Task 18): EPUB, MOBI, AZW3, LRF, PDB, FB2 rows, all through
// Calibre's ebook-convert (it reads every one of these and writes PDF, DOCX,
// TXT, RTF and all e-book targets). The targets come from the matrix rows below.
// CBR/CBZ/DJVU rows are in Task 19.
import { register } from "../registry.js";
import { toEbook } from "./document.js";

/** Copy of the matrix rows (a test asserts it equals matrix.json). */
export const EBOOK_ROWS: Record<string, string[]> = {
  epub: ["pdf", "docx", "txt", "rtf", "mobi", "azw3", "lrf", "oeb", "pdb", "fb2", "rb"],
  mobi: ["pdf", "docx", "txt", "rtf", "epub", "azw3", "oeb", "pdb", "fb2", "rb"],
  azw3: ["pdf", "docx", "txt", "rtf", "epub", "mobi", "lrf", "oeb", "pdb", "fb2", "rb"],
  lrf: ["pdf", "docx", "txt", "rtf", "epub", "mobi", "azw3", "oeb", "pdb", "fb2", "rb"],
  pdb: ["pdf", "docx", "txt", "rtf", "epub", "mobi", "azw3", "lrf", "oeb", "fb2", "rb"],
  fb2: ["pdf", "docx", "txt", "rtf", "epub", "mobi", "azw3", "lrf", "oeb", "pdb", "rb"],
};

for (const [src, targets] of Object.entries(EBOOK_ROWS)) register(src, targets, toEbook);
