import type { InlineKeyboard } from "../telegram";
import { SECTION_LABEL, type TargetGroup, type Section, isSection } from "../matrix";
import { BUTTON_LABEL } from "../matrix/delivery";

const PER_ROW = 4;
// callback_data format: "c|<section>|<target>"  (always well under 64 bytes)
export function encodeCallback(section: Section, target: string): string {
  const data = `c|${section}|${target}`;
  if (new TextEncoder().encode(data).length > 64) throw new Error("callback_data too long");
  return data;
}

export function decodeCallback(data: string | undefined): { section: Section; target: string } | null {
  if (!data) return null;
  const [tag, section, target] = data.split("|");
  if (tag !== "c" || !section || !target || !isSection(section)) return null;
  return { section, target };
}

export function noopButton(text: string) { return { text, callback_data: "noop" }; }

/** Group targets by section: a header row per section (when >1 section), then 4 buttons/row. */
export function buildKeyboard(groups: TargetGroup[]): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const showHeaders = groups.length > 1;
  for (const g of groups) {
    if (showHeaders) rows.push([noopButton(`— ${SECTION_LABEL[g.section]} —`)]);
    for (let i = 0; i < g.targets.length; i += PER_ROW) {
      rows.push(g.targets.slice(i, i + PER_ROW).map((t) => ({
        text: BUTTON_LABEL[t] ?? t.toUpperCase(),
        callback_data: encodeCallback(g.section, t),
      })));
    }
  }
  return rows;
}
