# Writes a minimal RAR 4.x archive with "stored" (uncompressed) entries.
# Used only to build the test fixture tests/fixtures/sample.cbr (no `rar` binary needed).
import struct, sys, zlib, os
def hdr(typ, flags, body, add=b""):
    size = 7 + len(body)
    h = struct.pack("<BHH", typ, flags, size) + body
    return struct.pack("<H", zlib.crc32(h) & 0xFFFF) + h + add
out = sys.argv[1]; files = sys.argv[2:]
data = b"Rar!\x1a\x07\x00" + hdr(0x73, 0, b"\0" * 6)
for f in files:
    d = open(f, "rb").read(); name = os.path.basename(f).encode()
    body = struct.pack("<IIBIIBBHI", len(d), len(d), 3, zlib.crc32(d), 0x5A000000, 20, 0x30, len(name), 0x20) + name
    data += hdr(0x74, 0x8000, body, d)
data += hdr(0x7B, 0x4000, b"")
open(out, "wb").write(data)
