// Task 22: spreadsheets via headless LibreOffice Calc.
import { register } from "../registry.js";
import { mimeFor } from "../mime.js";
import { soffice } from "../tools/libreoffice.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

/** LibreOffice Calc export filters per target (argv, no quotes). */
export const LO_CALC_FILTERS: Record<string, string> = {
  xlsx: "xlsx:Calc MS Excel 2007 XML",
  xls: "xls:MS Excel 97",
  ods: "ods:calc8",
  pdf: "pdf:calc_pdf_Export",
};

/** Copy of the matrix rows (a test asserts it equals matrix.json). */
export const SHEET_ROWS: Record<string, string[]> = {
  xls: ["xlsx", "ods", "pdf"],
  xlsx: ["xls", "ods", "pdf"],
  ods: ["xls", "xlsx", "pdf"],
};

export async function sheetToLibreOffice(ctx: JobContext): Promise<JobOutput> {
  const filter = LO_CALC_FILTERS[ctx.to];
  if (!filter) throw new HttpError(400, `no Calc filter for ${ctx.to}`);
  const path = await soffice(ctx.input, ctx.workDir, filter, ctx.signal);
  return { path, contentType: mimeFor(ctx.to), filename: `converted.${ctx.to}` };
}

for (const [src, targets] of Object.entries(SHEET_ROWS)) register(src, targets, sheetToLibreOffice);
