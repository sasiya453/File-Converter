// Prints conversion counts per section and in total from worker/src/matrix/matrix.json.
// Usage: npx tsx scripts/check-matrix.ts   (run from repo root or worker/)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "..", "worker", "src", "matrix", "matrix.json");
const m = JSON.parse(readFileSync(path, "utf8")) as {
  sections: Record<string, { targets: string[]; rows: Record<string, string[]> }>;
};
const EXPECTED = 874;
let total = 0;
const sources = new Set<string>();
for (const [name, sec] of Object.entries(m.sections)) {
  let n = 0;
  for (const [src, tgts] of Object.entries(sec.rows)) {
    sources.add(src);
    if (tgts.includes(src)) console.error(`  ! diagonal set: ${name} ${src}->${src}`);
    for (const t of tgts) if (!sec.targets.includes(t)) console.error(`  ! unknown target ${name} ${src}->${t}`);
    n += tgts.length;
  }
  total += n;
  console.log(`${name.padEnd(14)} ${String(Object.keys(sec.rows).length).padStart(3)} sources  ${String(n).padStart(4)} conversions`);
}
console.log(`${"TOTAL".padEnd(14)} ${String(sources.size).padStart(3)} sources  ${String(total).padStart(4)} conversions`);
if (total !== EXPECTED) console.log(`MISMATCH: expected ${EXPECTED} (as advertised by the bot), got ${total} (diff ${total - EXPECTED}). See handoff.md.`);
