#!/usr/bin/env python3
"""Font container helper for the converter (fontTools). Invoked with argv only, no shell.

  fontconv.py unwrap <in> <out>         WOFF/WOFF2/EOT -> plain sfnt (TTF or OTF bytes)
  fontconv.py wrap <woff|woff2> <in> <out>   sfnt -> WOFF / WOFF2
  fontconv.py eot <in.ttf> <out.eot>    TrueType sfnt -> uncompressed EOT (version 0x00020001)

Exit code 3 = invalid / unsupported input (the server maps it to 422).
"""
import struct
import sys

from fontTools.ttLib import TTFont

EOT_MAGIC = 0x504C
EOT_FLAG_MTX = 0x4
EOT_FLAG_XOR = 0x10000000


def fail(msg):
    sys.stderr.write(msg + "\n")
    sys.exit(3)


def eot_font_data(raw):
    if len(raw) < 82:
        fail("EOT file too short")
    eot_size, data_size, version, flags = struct.unpack_from("<IIII", raw, 0)
    magic = struct.unpack_from("<H", raw, 34)[0]
    if magic != EOT_MAGIC or version not in (0x00010000, 0x00020001, 0x00020002):
        fail("not an EOT file")
    if flags & EOT_FLAG_MTX:
        fail("MTX-compressed EOT files are not supported")
    if eot_size > len(raw) or data_size > eot_size:
        fail("corrupt EOT header")
    data = raw[eot_size - data_size:eot_size]  # FontData is always the last field
    if flags & EOT_FLAG_XOR:
        data = bytes(b ^ 0x50 for b in data)
    return data


def unwrap(src, dst):
    raw = open(src, "rb").read()
    if raw[:4] in (b"wOFF", b"wOF2"):
        font = TTFont(src)
        font.flavor = None
        font.save(dst)
        return
    data = eot_font_data(raw)
    if data[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        fail("EOT does not contain an sfnt font")
    open(dst, "wb").write(data)


def wrap(flavor, src, dst):
    font = TTFont(src)
    font.flavor = flavor
    font.save(dst)


def utf16(s):
    return s.encode("utf-16-le")


def make_eot(src, dst):
    data = open(src, "rb").read()
    font = TTFont(src)
    if "glyf" not in font:
        fail("EOT needs TrueType outlines")
    os2, head, name = font["OS/2"], font["head"], font["name"]

    def nm(i):
        rec = name.getName(i, 3, 1) or name.getName(i, 1, 0)
        return rec.toUnicode() if rec else ""

    panose = os2.panose
    panose_bytes = bytes([panose.bFamilyType, panose.bSerifStyle, panose.bWeight, panose.bProportion, panose.bContrast,
                          panose.bStrokeVariation, panose.bArmStyle, panose.bLetterForm, panose.bMidline, panose.bXHeight])
    italic = 1 if os2.fsSelection & 1 else 0
    fixed = struct.pack("<10sBBIHH", panose_bytes, 1, italic, os2.usWeightClass, os2.fsType, EOT_MAGIC)
    fixed += struct.pack("<IIII", os2.ulUnicodeRange1, os2.ulUnicodeRange2, os2.ulUnicodeRange3, os2.ulUnicodeRange4)
    fixed += struct.pack("<II", getattr(os2, "ulCodePageRange1", 0), getattr(os2, "ulCodePageRange2", 0))
    fixed += struct.pack("<I", head.checkSumAdjustment) + b"\0" * 16  # Reserved1-4
    names = b""
    for i in (1, 2, 5, 4):  # family, style, version, full name
        s = utf16(nm(i))
        names += struct.pack("<HH", 0, len(s)) + s  # PaddingN + size + string
    tail = struct.pack("<HH", 0, 0)  # Padding5 + RootStringSize (no root string)
    header_len = 16 + len(fixed) + len(names) + len(tail)
    total = header_len + len(data)
    header = struct.pack("<IIII", total, len(data), 0x00020001, 0) + fixed + names + tail
    open(dst, "wb").write(header + data)


def main(argv):
    try:
        if argv[:1] == ["unwrap"] and len(argv) == 3:
            unwrap(argv[1], argv[2])
        elif argv[:1] == ["wrap"] and len(argv) == 4 and argv[1] in ("woff", "woff2"):
            wrap(argv[1], argv[2], argv[3])
        elif argv[:1] == ["eot"] and len(argv) == 3:
            make_eot(argv[1], argv[2])
        else:
            fail("usage: fontconv.py unwrap|wrap|eot ...")
    except SystemExit:
        raise
    except Exception as e:  # invalid font data
        fail(f"font error: {e}")


if __name__ == "__main__":
    main(sys.argv[1:])
