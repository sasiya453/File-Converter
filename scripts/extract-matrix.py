# Re-extracts the conversion matrix from docs/conversion-matrix.png by pixel colour.
# Usage: python3 scripts/extract-matrix.py  (writes worker/src/matrix/matrix.json)
from PIL import Image
import numpy as np
from scipy import ndimage
a=np.array(Image.open('docs/conversion-matrix.png').convert('RGB')).astype(int)
def near(c,t=25): return (np.abs(a-np.array(c)).sum(2)<t)
g=near((197,239,205))|near((199,239,205))
p=near((255,199,205))|near((254,196,203))
cells=[]
for m,v in ((g,1),(p,0)):
    lab,n=ndimage.label(m)
    for i,sl in enumerate(ndimage.find_objects(lab)):
        h=sl[0].stop-sl[0].start; w=sl[1].stop-sl[1].start
        if h>=8 and w>=20: cells.append((sl[0].start,sl[1].start,h,w,v))
cells.sort()
# group rows
rows=[]
for c in cells:
    if rows and abs(rows[-1][0][0]-c[0])<5: rows[-1].append(c)
    else: rows.append([c])
import json
S=[
("DOCUMENT","PDF DOC DOCX TXT RTF ODT TEXT","PDF DOC DOCX TXT RTF ODT EPUB MOBI AZW3 LRF OEB PDB FB2 RB PNG JPG"),
("VIDEO","MP4 AVI WMV MKV 3GP 3GPP MPG MPEG WEBM TS MOV FLV ASF VOB","MP4 AVI WMV MKV 3GP MPG WEBM TS MOV FLV GIF VIDEONOTE MP3 STREAM AUDIONOTE"),
("IMAGE","PNG JPG JPEG JP2 WEBP BMP TIF TIFF GIF ICO TGS HEIC AVIF PSD EPS SVG APNG","PNG JPG JPEG JP2 WEBP BMP TIF TIFF GIF ICO PDF SENDPHOTO OCR MP4 GIFZ APNG"),
("AUDIO","MP3 OGG OPUS WAV FLAC WMA OGA M4A AAC AIFF AMR","MP3 OGG OPUS WAV FLAC WMA OGA M4A AAC AIFF AUDIONOTE"),
("EBOOK","EPUB MOBI AZW3 LRF PDB FB2 CBR CBZ DJVU","PDF DOCX TXT RTF EPUB MOBI AZW3 LRF OEB PDB FB2 RB"),
("PRESENTATION","PPT PPTX PPTM PPS PPSX PPSM POT POTX POTM ODP","PDF PPT PPTX PPS POT ODP"),
("FONT","TTF OTF EOT WOFF WOFF2 SVG PFB","TTF OTF EOT WOFF WOFF2 SVG"),
("SHEET","XLS XLSX ODS","XLS XLSX ODS PDF"),
("SUBTITLE","SRT VTT STL SBV SUB ASS SSA LRC DFXP TTML QT.TXT","SRT VTT STL SBV SUB ASS SSA LRC DFXP TTML QT.TXT"),
]
data=rows[1:]
out={"_source":"docs/conversion-matrix.png (pixel-extracted)","sections":{}}
i=0
for name,srcs,tgts in S:
    srcs=srcs.split(); tgts=tgts.split()
    sec={}
    for s in srcs:
        r=data[i]; i+=1
        assert len(r)==len(tgts),(name,s,len(r))
        sec[s.lower()]=[t.lower() for t,c in zip(tgts,r) if c[4]]
    out["sections"][name.lower()]={"targets":[t.lower() for t in tgts],"rows":sec}
assert i==len(data)
out["sections"]["document"]["rows"]["torrent"]=["txt"]
json.dump(out,open('worker/src/matrix/matrix.json','w'),indent=1)
