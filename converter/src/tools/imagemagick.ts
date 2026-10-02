// ImageMagick wrapper that works with IM7 (`magick`) and IM6 (`convert`, Debian bookworm).
import { spawnSync } from "node:child_process";
import { run } from "../run.js";

let cached: string | undefined;
/** Resolve the ImageMagick binary once: prefer IM7 `magick`, fall back to IM6 `convert`. */
export function imBinary(): string {
  if (!cached) cached = spawnSync("magick", ["-version"]).status === 0 ? "magick" : "convert";
  return cached;
}

/** Resource limits applied to every ImageMagick call (guards against decompression bombs). */
export const IM_LIMITS = ["-limit", "memory", "512MiB", "-limit", "map", "1GiB", "-limit", "disk", "2GiB",
  "-limit", "area", "128MP", "-limit", "time", "110"];

/** Run ImageMagick with argv (no shell). `args` excludes the binary name. */
export function magick(args: string[], cwd: string, signal: AbortSignal) {
  return run(imBinary(), [...IM_LIMITS, ...args], { cwd, signal });
}

/** `identify`-style query using `magick identify` (IM7) or `identify` (IM6). */
export function identify(args: string[], cwd: string, signal: AbortSignal) {
  return imBinary() === "magick" ? run("magick", ["identify", ...args], { cwd, signal }) : run("identify", args, { cwd, signal });
}
