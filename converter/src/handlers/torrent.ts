// Task 24: TORRENT -> readable .txt listing (name, hash, files, sizes, trackers).
// Self-contained bencode parser (no dependencies) with depth/size limits.
import { join } from "node:path";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { register } from "../registry.js";
import { mimeFor } from "../mime.js";
import { HttpError, type JobContext, type JobOutput } from "../types.js";

export type BValue = number | bigint | Buffer | BValue[] | BDict;
export interface BDict { [key: string]: BValue }

export const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 64;
const bad = (msg: string) => new HttpError(422, `invalid torrent: ${msg}`);

/** Decode bencode. Returns the value and, for the top-level dict, the raw byte range of "info". */
export function bdecode(buf: Buffer): { value: BValue; infoRange?: [number, number] } {
  let pos = 0;
  let infoRange: [number, number] | undefined;
  const intUntil = (end: number): bigint => {
    const s = buf.toString("latin1", pos, end);
    if (!/^(0|-?[1-9]\d*)$/.test(s)) throw bad("bad integer");
    return BigInt(s);
  };
  const parse = (depth: number): BValue => {
    if (depth > MAX_DEPTH) throw bad("nesting too deep");
    if (pos >= buf.length) throw bad("unexpected end");
    const c = buf[pos]!;
    if (c === 0x69 /* i */) {
      pos++;
      const end = buf.indexOf(0x65, pos);
      if (end < 0) throw bad("unterminated integer");
      const n = intUntil(end);
      pos = end + 1;
      return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    if (c === 0x6c /* l */) {
      pos++;
      const list: BValue[] = [];
      while (buf[pos] !== 0x65) list.push(parse(depth + 1));
      pos++;
      return list;
    }
    if (c === 0x64 /* d */) {
      pos++;
      const dict: BDict = Object.create(null);
      while (buf[pos] !== 0x65) {
        const k = parse(depth + 1);
        if (!Buffer.isBuffer(k)) throw bad("dictionary key is not a string");
        const key = k.toString("utf8");
        const start = pos;
        dict[key] = parse(depth + 1);
        if (depth === 0 && key === "info") infoRange = [start, pos];
      }
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, pos);
      if (colon < 0 || colon - pos > 10) throw bad("bad string length");
      const len = Number(intUntil(colon));
      pos = colon + 1;
      if (len < 0 || pos + len > buf.length) throw bad("string past end of file");
      const s = buf.subarray(pos, pos + len);
      pos += len;
      return s;
    }
    throw bad(`unexpected byte 0x${c.toString(16)}`);
  };
  const value = parse(0);
  if (pos !== buf.length) throw bad("trailing data");
  return { value, infoRange };
}

const isDict = (v: BValue | undefined): v is BDict =>
  typeof v === "object" && v !== null && !Buffer.isBuffer(v) && !Array.isArray(v);
const str = (v: BValue | undefined) => (Buffer.isBuffer(v) ? v.toString("utf8") : undefined);
const num = (v: BValue | undefined) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);

export function humanSize(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${n} B` : `${v.toFixed(2)} ${units[i]} (${n.toLocaleString("en-US")} bytes)`;
}

interface FileEntry { path: string; length: number }

/** v2 "file tree": { name: { name: { "": { length } } } } */
function walkTree(tree: BDict, prefix: string[], out: FileEntry[]): void {
  for (const [k, v] of Object.entries(tree)) {
    if (!isDict(v)) continue;
    if (k === "" && isDict(v)) { out.push({ path: prefix.join("/"), length: num(v.length) ?? 0 }); continue; }
    walkTree(v, [...prefix, k], out);
  }
}

export function describeTorrent(buf: Buffer): string {
  const { value, infoRange } = bdecode(buf);
  if (!isDict(value) || !isDict(value.info) || !infoRange) throw bad("missing info dictionary");
  const info = value.info;
  const rawInfo = buf.subarray(infoRange[0], infoRange[1]);
  const name = str(info["name.utf-8"]) ?? str(info.name) ?? "(unnamed)";
  const version = num(info["meta version"]) ?? 1;

  const files: FileEntry[] = [];
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      if (!isDict(f)) continue;
      const parts = (Array.isArray(f["path.utf-8"]) ? f["path.utf-8"] : Array.isArray(f.path) ? f.path : []).map((p) => str(p) ?? "");
      if (str(f.attr)?.includes("p")) continue; // BEP 47 padding files
      files.push({ path: [name, ...parts].join("/"), length: num(f.length) ?? 0 });
    }
  } else if (isDict(info["file tree"])) {
    walkTree(info["file tree"], [name], files);
  } else {
    files.push({ path: name, length: num(info.length) ?? 0 });
  }
  const total = files.reduce((a, f) => a + f.length, 0);

  const trackers: string[] = [];
  const add = (t?: string) => { if (t && !trackers.includes(t)) trackers.push(t); };
  if (Array.isArray(value["announce-list"])) {
    for (const tier of value["announce-list"]) if (Array.isArray(tier)) for (const t of tier) add(str(t));
  }
  add(str(value.announce));
  const webSeeds = Array.isArray(value["url-list"]) ? value["url-list"].map(str).filter(Boolean) as string[]
    : str(value["url-list"]) ? [str(value["url-list"])!] : [];

  const v1 = version === 2 && !info.pieces ? undefined : createHash("sha1").update(rawInfo).digest("hex");
  const v2 = version === 2 ? createHash("sha256").update(rawInfo).digest("hex") : undefined;
  const pieces = Buffer.isBuffer(info.pieces) ? Math.floor(info.pieces.length / 20) : undefined;
  const created = num(value["creation date"]);

  const magnetParts = [
    ...(v1 ? [`xt=urn:btih:${v1}`] : []), ...(v2 ? [`xt=urn:btmh:1220${v2}`] : []),
    `dn=${encodeURIComponent(name)}`, ...trackers.map((t) => `tr=${encodeURIComponent(t)}`),
  ];

  const L: string[] = [];
  L.push("TORRENT INFORMATION", "===================", "");
  L.push(`Name:           ${name}`);
  if (v1) L.push(`Info hash (v1): ${v1}`);
  if (v2) L.push(`Info hash (v2): ${v2}`);
  L.push(`Total size:     ${humanSize(total)}`);
  L.push(`Files:          ${files.length}`);
  const pl = num(info["piece length"]);
  if (pl) L.push(`Piece length:   ${humanSize(pl)}`);
  if (pieces !== undefined) L.push(`Pieces:         ${pieces}`);
  L.push(`Private:        ${num(info.private) === 1 ? "yes" : "no"}`);
  if (created) L.push(`Created:        ${new Date(created * 1000).toISOString()}`);
  if (str(value["created by"])) L.push(`Created by:     ${str(value["created by"])}`);
  if (str(value.comment)) L.push(`Comment:        ${str(value.comment)}`);
  L.push("", `FILES (${files.length})`, "-----");
  for (const f of files) L.push(`${f.path}  [${humanSize(f.length)}]`);
  L.push("", `TRACKERS (${trackers.length})`, "--------");
  L.push(...(trackers.length ? trackers : ["(none - trackerless / DHT only)"]));
  if (webSeeds.length) L.push("", `WEB SEEDS (${webSeeds.length})`, "---------", ...webSeeds);
  L.push("", "MAGNET LINK", "-----------", `magnet:?${magnetParts.join("&")}`, "");
  return L.join("\n");
}

export async function torrentToTxt(ctx: JobContext): Promise<JobOutput> {
  if ((await stat(ctx.input)).size > MAX_TORRENT_BYTES) throw bad("file is larger than 10 MB");
  const text = describeTorrent(await readFile(ctx.input));
  const out = join(ctx.workDir, "converted.txt");
  await writeFile(out, text, "utf8");
  return { path: out, contentType: mimeFor("txt"), filename: "converted.txt" };
}

register("torrent", "txt", torrentToTxt);
