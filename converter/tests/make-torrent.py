# Builds the TORRENT test fixtures (tests/fixtures/sample.torrent, multi.torrent).
import hashlib, os
def be(v):
    if isinstance(v, int): return b"i%de" % v
    if isinstance(v, str): v = v.encode()
    if isinstance(v, bytes): return b"%d:%s" % (len(v), v)
    if isinstance(v, list): return b"l" + b"".join(be(x) for x in v) + b"e"
    if isinstance(v, dict): return b"d" + b"".join(be(k) + be(v[k]) for k in sorted(v)) + b"e"
d = os.path.join(os.path.dirname(__file__), "fixtures")
single = {"announce": "udp://tracker.example.org:1337/announce", "comment": "Hello Converter", "created by": "make-torrent.py",
          "creation date": 1700000000,
          "info": {"name": "hello.txt", "length": 16, "piece length": 16384, "pieces": hashlib.sha1(b"Hello Converter\n").digest()}}
multi = {"announce": "http://a.example.com/announce",
         "announce-list": [["http://a.example.com/announce"], ["udp://b.example.com:80"]],
         "url-list": ["https://seed.example.com/files/"],
         "info": {"name": "Album ü", "piece length": 262144, "pieces": b"\0" * 40, "private": 1,
                  "files": [{"length": 3000000, "path": ["CD1", "01 - Intro.mp3"]},
                            {"length": 5, "path": [".pad", "5"], "attr": "p"},
                            {"length": 1024, "path": ["cover.jpg"]}]}}
open(os.path.join(d, "sample.torrent"), "wb").write(be(single))
open(os.path.join(d, "multi.torrent"), "wb").write(be(multi))
print(hashlib.sha1(be(single["info"])).hexdigest())
