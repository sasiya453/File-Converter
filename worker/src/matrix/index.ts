import matrixJson from "./matrix.json";

export type Section =
  | "document" | "video" | "image" | "audio" | "ebook"
  | "presentation" | "font" | "sheet" | "subtitle";

interface SectionData { targets: string[]; rows: Record<string, string[]> }
interface MatrixData { sections: Record<Section, SectionData> }

const MATRIX = matrixJson as unknown as MatrixData;

export const SECTION_ORDER: Section[] = [
  "document", "video", "image", "audio", "ebook", "presentation", "font", "sheet", "subtitle",
];

export const SECTION_LABEL: Record<Section, string> = {
  document: "💼 Document", video: "📹 Video", image: "📷 Image", audio: "🔊 Audio",
  ebook: "📚 eBook", presentation: "🖼 Presentation", font: "🔤 Font", sheet: "📊 Sheet",
  subtitle: "💬 Subtitle",
};

export interface TargetGroup { section: Section; targets: string[] }

/** All allowed targets for a source format, grouped by section (only ✓ cells). */
export function targetsFor(source: string): TargetGroup[] {
  const src = source.toLowerCase();
  const out: TargetGroup[] = [];
  for (const section of SECTION_ORDER) {
    const row = MATRIX.sections[section]?.rows[src];
    if (row && row.length) out.push({ section, targets: [...row] });
  }
  return out;
}

export function isAllowed(section: Section, source: string, target: string): boolean {
  const row = MATRIX.sections[section]?.rows[source.toLowerCase()];
  return !!row && row.includes(target.toLowerCase());
}

export function isKnownSource(source: string): boolean {
  return targetsFor(source).length > 0;
}

export function isSection(s: string): s is Section {
  return (SECTION_ORDER as string[]).includes(s);
}

export function matrixCounts(): { perSection: Record<string, number>; total: number } {
  const perSection: Record<string, number> = {};
  let total = 0;
  for (const s of SECTION_ORDER) {
    const n = Object.values(MATRIX.sections[s].rows).reduce((a, r) => a + r.length, 0);
    perSection[s] = n;
    total += n;
  }
  return { perSection, total };
}
