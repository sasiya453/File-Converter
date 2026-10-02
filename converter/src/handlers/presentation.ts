// Task 20: presentations via headless LibreOffice Impress.
import { register } from "../registry.js";
import { mimeFor } from "../mime.js";
import { soffice } from "../tools/libreoffice.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

/** LibreOffice Impress export filters per target (argv, no quotes). */
export const LO_IMPRESS_FILTERS: Record<string, string> = {
  pdf: "pdf:impress_pdf_Export",
  ppt: "ppt:MS PowerPoint 97",
  pptx: "pptx:Impress MS PowerPoint 2007 XML",
  pps: "pps:MS PowerPoint 97 AutoPlay",
  pot: "pot:MS PowerPoint 97 Vorlage",
  odp: "odp:impress8",
};

/** Copy of the matrix rows (a test asserts it equals matrix.json). Note ppt->pptx is ✗. */
export const PRESENTATION_ROWS: Record<string, string[]> = {
  ppt: ["pdf", "pps", "pot", "odp"],
  pptx: ["pdf", "ppt", "pps", "pot", "odp"],
  pptm: ["pdf", "ppt", "pptx", "pps", "pot", "odp"],
  pps: ["pdf", "ppt", "pptx", "pot", "odp"],
  ppsx: ["pdf", "ppt", "pptx", "pps", "pot", "odp"],
  ppsm: ["pdf", "ppt", "pptx", "pps", "pot", "odp"],
  pot: ["pdf", "ppt", "pptx", "pps", "odp"],
  potx: ["pdf", "ppt", "pptx", "pps", "pot", "odp"],
  potm: ["pdf", "ppt", "pptx", "pps", "pot", "odp"],
  odp: ["pdf", "ppt", "pptx", "pps", "pot"],
};

/** The input is saved as `input.<from>`, so LO picks the right import filter from the extension. */
export async function presentationToLibreOffice(ctx: JobContext): Promise<JobOutput> {
  const filter = LO_IMPRESS_FILTERS[ctx.to];
  if (!filter) throw new HttpError(400, `no Impress filter for ${ctx.to}`);
  const path = await soffice(ctx.input, ctx.workDir, filter, ctx.signal);
  return { path, contentType: mimeFor(ctx.to), filename: `converted.${ctx.to}` };
}

for (const [src, targets] of Object.entries(PRESENTATION_ROWS)) register(src, targets, presentationToLibreOffice);
