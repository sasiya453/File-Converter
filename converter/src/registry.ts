import type { Handler } from "./types.js";

/**
 * Single registry of conversions keyed by "from->to" (lower-case).
 * Adding a conversion = adding one entry via register().
 * Handler modules under src/handlers/ call register() at import time and are
 * loaded from src/handlers/index.ts.
 */
const REGISTRY = new Map<string, Handler>();

export const key = (from: string, to: string) => `${from.toLowerCase()}->${to.toLowerCase()}`;

export function register(from: string | string[], to: string | string[], handler: Handler): void {
  for (const f of Array.isArray(from) ? from : [from]) {
    for (const t of Array.isArray(to) ? to : [to]) REGISTRY.set(key(f, t), handler);
  }
}

export function lookup(from: string, to: string): Handler | undefined {
  return REGISTRY.get(key(from, to));
}

export function listConversions(): string[] {
  return [...REGISTRY.keys()].sort();
}
