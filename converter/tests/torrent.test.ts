import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertFixture, FIXTURES } from "./helpers.js";
import { lookup } from "../src/registry.js";
import { bdecode, describeTorrent, humanSize } from "../src/handlers/torrent.js";

const matrix = JSON.parse(readFileSync(new URL("../../worker/src/matrix/matrix.json", import.meta.url), "utf8"));

test("torrent row is [txt] and registered", () => {
  assert.deepEqual(matrix.sections.document.rows.torrent, ["txt"]);
  assert.ok(lookup("torrent", "txt"));
});

test("single-file torrent listing", async () => {
  const { out, cleanup } = await convertFixture("sample.torrent", "txt");
  try {
    const t = await readFile(out.path, "utf8");
    // info hash = sha1 of the raw bencoded info dict
    const raw = readFileSync(join(FIXTURES, "sample.torrent"));
    const { infoRange } = bdecode(raw);
    const hash = createHash("sha1").update(raw.subarray(infoRange![0], infoRange![1])).digest("hex");
    assert.match(t, new RegExp(`Info hash \\(v1\\): ${hash}`));
    assert.match(t, /Name: +hello\.txt/);
    assert.match(t, /hello\.txt {2}\[16 B\]/);
    assert.match(t, /udp:\/\/tracker\.example\.org:1337\/announce/);
    assert.match(t, /Comment: +Hello Converter/);
    assert.match(t, /Created: +2023-11-14T22:13:20\.000Z/);
    assert.match(t, new RegExp(`magnet:\\?xt=urn:btih:${hash}&dn=hello.txt&tr=udp%3A%2F%2F`));
    assert.equal(out.filename, "converted.txt");
  } finally { await cleanup(); }
});

test("multi-file torrent: paths, padding skipped, tiers, web seeds, private", () => {
  const t = describeTorrent(readFileSync(join(FIXTURES, "multi.torrent")));
  assert.match(t, /Album ü\/CD1\/01 - Intro\.mp3 {2}\[2\.86 MB \(3,000,000 bytes\)\]/);
  assert.match(t, /Album ü\/cover\.jpg {2}\[1\.00 KB/);
  assert.doesNotMatch(t, /\.pad/);
  assert.match(t, /Files: +2/);
  assert.match(t, /TRACKERS \(2\)\n-+\nhttp:\/\/a\.example\.com\/announce\nudp:\/\/b\.example\.com:80/);
  assert.match(t, /WEB SEEDS \(1\)/);
  assert.match(t, /Private: +yes/);
  assert.match(t, /Pieces: +2/);
});

test("bdecode rejects malformed / hostile input", () => {
  for (const bad of ["", "i12", "i-0e", "i01e", "5:abc", "d3:keyi1e", "x", "le junk", "di1ei2ee", "999999999999:a"]) {
    assert.throws(() => bdecode(Buffer.from(bad)), /invalid torrent/, JSON.stringify(bad));
  }
  assert.throws(() => bdecode(Buffer.from("l".repeat(100) + "e".repeat(100))), /too deep/);
});

test("humanSize", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(1536), "1.50 KB (1,536 bytes)");
});

test("non-torrent input is a 422", async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-job-"));
  try {
    const input = join(dir, "input.torrent");
    await writeFile(input, "d4:spam4:eggse"); // valid bencode, no info dict
    await assert.rejects(lookup("torrent", "txt")!({ input, workDir: dir, from: "torrent", to: "txt", options: {}, signal: AbortSignal.timeout(5_000) }),
      (e: { status?: number }) => e.status === 422);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
