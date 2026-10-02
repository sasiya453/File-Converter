// Full-matrix verification: every ✓ cell in matrix.json has a converter handler,
// and the converter offers nothing that is ✗ in every section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lookup, listConversions, key } from "../src/registry.js";
import "../src/handlers/index.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));
const sections: Record<string, { rows: Record<string, string[]> }> = matrix.sections;

test("every ✓ cell of the matrix has a handler", () => {
  const missing: string[] = [];
  for (const [name, sec] of Object.entries(sections)) {
    for (const [src, targets] of Object.entries(sec.rows)) {
      for (const to of targets) if (!lookup(src, to)) missing.push(`${name}:${src}->${to}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("no handler exists for a conversion that is ✗ in every section", () => {
  const allowed = new Set<string>();
  for (const sec of Object.values(sections)) {
    for (const [src, targets] of Object.entries(sec.rows)) for (const to of targets) allowed.add(key(src, to));
  }
  assert.deepEqual(listConversions().filter((k) => !allowed.has(k)), []);
});
