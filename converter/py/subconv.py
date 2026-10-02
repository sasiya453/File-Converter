#!/usr/bin/env python3
"""Subtitle converter helper (pysubs2 + custom readers/writers). argv only, no shell.

  subconv.py <from> <to> <in> <out> [fps]

Formats: srt vtt ass ssa sub (MicroDVD; SubViewer 2 is also read) sbv lrc dfxp ttml qt.txt
stl (Spruce STL *text* format; EBU binary STL is not supported).
Internal model: pysubs2.SSAFile (times in ms). Exit 3 = invalid input (-> HTTP 422).
"""
import re
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

import pysubs2

NATIVE = {"srt": "srt", "vtt": "vtt", "ass": "ass", "ssa": "ssa"}


class BadInput(Exception):
    pass


def read_text(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-16"):
        try:
            text = raw.decode(enc)
            if enc == "utf-16" and not raw.startswith((b"\xff\xfe", b"\xfe\xff")):
                continue
            return text.replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeDecodeError:
            continue
    return raw.decode("cp1252", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def new_file():
    subs = pysubs2.SSAFile()
    return subs


def add(subs, start, end, text):
    if end <= start:
        end = start + 2000
    ev = pysubs2.SSAEvent(start=int(start), end=int(end))
    ev.plaintext = text.strip("\n")
    subs.append(ev)


# ---------- time helpers ----------
def clock_ms(h, m, s, frac="0", frac_is_frames=False, fps=25.0):
    ms = (int(h) * 3600 + int(m) * 60 + int(s)) * 1000
    if frac_is_frames:
        ms += int(frac) * 1000.0 / fps
    else:
        ms += int((frac + "000")[:3])
    return int(round(ms))


def fmt_hmsf(ms, fps, sep=":"):
    total_frames = int(round(ms * fps / 1000.0))
    f = total_frames % int(round(fps))
    secs = total_frames // int(round(fps))
    return "%02d:%02d:%02d%s%02d" % (secs // 3600, secs // 60 % 60, secs % 60, sep, f)


def fmt_hms_ms(ms, sep="."):
    return "%02d:%02d:%02d%s%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, sep, ms % 1000)


# ---------- readers ----------
def read_native(path, fmt, fps):
    text = read_text(path)
    return pysubs2.SSAFile.from_string(text, format_=fmt, fps=fps)


def read_sub(path, fps):
    text = read_text(path)
    if text.lstrip().startswith("{"):
        # MicroDVD: an optional first cue "{1}{1}<fps>" declares the frame rate.
        m = re.match(r"\s*\{\d+\}\{\d+\}\s*(\d+(?:\.\d+)?)\s*\n", text)
        if m and 1 <= float(m.group(1)) <= 120:
            fps = float(m.group(1))
            text = text[m.end():]
        return pysubs2.SSAFile.from_string(text, format_="microdvd", fps=fps)
    # SubViewer 2: "00:00:01.00,00:00:02.50" then text with [br]
    subs = new_file()
    lines = text.split("\n")
    rx = re.compile(r"^(\d+):(\d\d):(\d\d)[.,](\d+),(\d+):(\d\d):(\d\d)[.,](\d+)\s*$")
    i = 0
    while i < len(lines):
        m = rx.match(lines[i].strip())
        if m:
            g = m.groups()
            buf = []
            i += 1
            while i < len(lines) and lines[i].strip():
                buf.append(lines[i]); i += 1
            add(subs, clock_ms(*g[:4]), clock_ms(*g[4:]), "\n".join(buf).replace("[br]", "\n"))
        i += 1
    return subs


def read_sbv(path):
    subs = new_file()
    rx = re.compile(r"^(\d+):(\d\d):(\d\d)\.(\d+),(\d+):(\d\d):(\d\d)\.(\d+)\s*$")
    blocks = re.split(r"\n\s*\n", read_text(path).strip())
    for b in blocks:
        ls = b.split("\n")
        m = rx.match(ls[0].strip())
        if m:
            g = m.groups()
            add(subs, clock_ms(*g[:4]), clock_ms(*g[4:]), "\n".join(ls[1:]))
    return subs


def read_lrc(path):
    tag = re.compile(r"\[(\d+):(\d\d)(?:[.:](\d+))?\]")
    entries = []
    for line in read_text(path).split("\n"):
        stamps = []
        pos = 0
        while True:
            m = tag.match(line, pos)
            if not m:
                break
            mm, ss, frac = m.group(1), m.group(2), m.group(3) or "0"
            stamps.append((int(mm) * 60 + int(ss)) * 1000 + int((frac + "000")[:3]) if len(frac) != 2 else
                          (int(mm) * 60 + int(ss)) * 1000 + int(frac) * 10)
            pos = m.end()
        text = re.sub(r"<\d+:\d\d(?:[.:]\d+)?>", "", line[pos:]).strip()  # drop word-level tags
        for st in stamps:
            entries.append((st, text))
    entries.sort(key=lambda e: e[0])
    subs = new_file()
    for i, (st, text) in enumerate(entries):
        if not text:
            continue
        end = entries[i + 1][0] if i + 1 < len(entries) else st + 4000
        add(subs, st, min(end, st + 10000), text)
    return subs


def ttml_time(value, fps, tick_rate):
    v = value.strip()
    m = re.match(r"^(\d+):(\d\d):(\d\d)(?:\.(\d+))?$", v)
    if m:
        return clock_ms(m.group(1), m.group(2), m.group(3), m.group(4) or "0")
    m = re.match(r"^(\d+):(\d\d):(\d\d):(\d+)$", v)
    if m:
        return clock_ms(*m.groups(), frac_is_frames=True, fps=fps)
    m = re.match(r"^([\d.]+)(h|m|s|ms|f|t)$", v)
    if m:
        n, unit = float(m.group(1)), m.group(2)
        return int(round({"h": n * 3600000, "m": n * 60000, "s": n * 1000, "ms": n,
                          "f": n * 1000 / fps, "t": n * 1000 / tick_rate}[unit]))
    raise BadInput("bad TTML time %r" % value)


def local(tag):
    return tag.rsplit("}", 1)[-1]


def read_ttml(path, fps):
    text = read_text(path)
    if "<!ENTITY" in text:
        raise BadInput("XML entities are not allowed")
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError as e:
        raise BadInput("invalid TTML/DFXP XML: %s" % e)
    attrs = {local(k): v for k, v in root.attrib.items()}
    fr = float(attrs.get("frameRate", fps))
    tick = float(attrs.get("tickRate", 10000000))
    subs = new_file()

    def text_of(el):
        out = [el.text or ""]
        for ch in el:
            out.append("\n" if local(ch.tag) == "br" else text_of(ch))
            out.append(ch.tail or "")
        return "".join(out)

    for p in root.iter():
        if local(p.tag) != "p":
            continue
        a = {local(k): v for k, v in p.attrib.items()}
        if "begin" not in a:
            continue
        start = ttml_time(a["begin"], fr, tick)
        if "end" in a:
            end = ttml_time(a["end"], fr, tick)
        elif "dur" in a:
            end = start + ttml_time(a["dur"], fr, tick)
        else:
            end = start + 2000
        body = re.sub(r"[ \t]+", " ", text_of(p))
        add(subs, start, end, "\n".join(l.strip() for l in body.split("\n")))
    return subs


def read_qt(path):
    rx = re.compile(r"^\[(\d+):(\d\d):(\d\d)[.:](\d+)\]\s*$")
    stamps, cur = [], None
    for line in read_text(path).split("\n"):
        m = rx.match(line.strip())
        if m:
            h, mi, s, f = m.groups()
            ms = clock_ms(h, mi, s, f) if len(f) == 3 else clock_ms(h, mi, s, f, frac_is_frames=True, fps=30.0)
            cur = [ms, []]
            stamps.append(cur)
        elif cur is not None and not line.strip().startswith("{"):
            cur[1].append(line)
    subs = new_file()
    for i, (ms, buf) in enumerate(stamps):
        text = "\n".join(buf).strip()
        if text and i + 1 < len(stamps):
            add(subs, ms, stamps[i + 1][0], text)
        elif text:
            add(subs, ms, ms + 2000, text)
    return subs


def read_stl(path, fps):
    rx = re.compile(r"^(\d\d):(\d\d):(\d\d)[:.](\d\d)\s*,\s*(\d\d):(\d\d):(\d\d)[:.](\d\d)\s*,(.*)$")
    subs = new_file()
    for line in read_text(path).split("\n"):
        m = rx.match(line.strip())
        if m:
            g = m.groups()
            add(subs, clock_ms(*g[:4], frac_is_frames=True, fps=fps), clock_ms(*g[4:8], frac_is_frames=True, fps=fps),
                g[8].strip().replace("|", "\n"))
    return subs


# ---------- writers ----------
def lines(ev):
    return ev.plaintext.strip("\n")


def write_microdvd(subs, fps):
    """MicroDVD with a leading "{1}{1}<fps>" frame-rate cue (what most players expect)."""
    body = subs.to_string("microdvd", fps=fps, write_fps_declaration=False)
    return "{1}{1}%s\n%s" % (("%g" % fps), body)


def write_sbv(subs):
    def t(ms):
        return "%d:%02d:%02d.%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)
    return "\n".join("%s,%s\n%s\n" % (t(e.start), t(e.end), lines(e)) for e in subs)


def write_lrc(subs):
    out = []
    for e in subs:
        cs = int(round(e.start / 10.0))
        out.append("[%02d:%02d.%02d]%s" % (cs // 6000, cs // 100 % 60, cs % 100, lines(e).replace("\n", " ")))
    return "\n".join(out) + "\n"


def write_ttml(subs, dfxp):
    ns = "http://www.w3.org/2006/10/ttaf1" if dfxp else "http://www.w3.org/ns/ttml"
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<tt xmlns="%s" xml:lang="en">' % ns, "  <body>", "    <div>"]
    for e in subs:
        body = "<br/>".join(escape(l) for l in lines(e).split("\n"))
        out.append('      <p begin="%s" end="%s">%s</p>' % (fmt_hms_ms(e.start), fmt_hms_ms(e.end), body))
    out += ["    </div>", "  </body>", "</tt>"]
    return "\n".join(out) + "\n"


def write_qt(subs):
    out = ["{QTtext} {font:Tahoma} {plain} {size:20} {textColor: 65535, 65535, 65535}",
           "{backColor: 0, 0, 0} {justify:center} {timeScale:1000} {width:320} {height:60}",
           "{timeStamps:absolute} {language:0} {textEncoding:0}"]
    for e in subs:
        out.append("[%s]" % fmt_hms_ms(e.start))
        out.append(lines(e))
        out.append("[%s]" % fmt_hms_ms(e.end))
        out.append("")
    return "\n".join(out) + "\n"


def write_stl(subs, fps):
    out = ["$FontName = Arial", "$FontSize = 30", ""]
    for e in subs:
        out.append("%s , %s , %s" % (fmt_hmsf(e.start, fps), fmt_hmsf(e.end, fps), lines(e).replace("\n", " | ")))
    return "\n".join(out) + "\n"


def load(fmt, path, fps):
    if fmt in NATIVE:
        return read_native(path, NATIVE[fmt], fps)
    return {
        "sub": lambda: read_sub(path, fps), "sbv": lambda: read_sbv(path), "lrc": lambda: read_lrc(path),
        "dfxp": lambda: read_ttml(path, fps), "ttml": lambda: read_ttml(path, fps), "qt.txt": lambda: read_qt(path),
        "stl": lambda: read_stl(path, fps),
    }[fmt]()


def dump(fmt, subs, fps):
    if fmt in NATIVE:
        return subs.to_string(NATIVE[fmt], fps=fps)
    return {
        "sub": lambda: write_microdvd(subs, fps), "sbv": lambda: write_sbv(subs), "lrc": lambda: write_lrc(subs),
        "dfxp": lambda: write_ttml(subs, True), "ttml": lambda: write_ttml(subs, False), "qt.txt": lambda: write_qt(subs),
        "stl": lambda: write_stl(subs, fps),
    }[fmt]()


FORMATS = {"srt", "vtt", "ass", "ssa", "sub", "sbv", "lrc", "dfxp", "ttml", "qt.txt", "stl"}


def main(argv):
    if len(argv) not in (4, 5) or argv[0] not in FORMATS or argv[1] not in FORMATS:
        sys.stderr.write("usage: subconv.py <from> <to> <in> <out> [fps]\n")
        return 2
    src, dst, inp, out = argv[:4]
    fps = float(argv[4]) if len(argv) == 5 else 25.0
    try:
        subs = load(src, inp, fps)
        subs.events = [e for e in subs.events if not e.is_comment and lines(e)]
        if not subs.events:
            raise BadInput("no subtitles found in the file")
        subs.sort()
        data = dump(dst, subs, fps)
    except BadInput as e:
        sys.stderr.write("%s\n" % e)
        return 3
    except Exception as e:  # parser errors on malformed input
        sys.stderr.write("invalid subtitle file: %s\n" % e)
        return 3
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(data)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
