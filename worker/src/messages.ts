export const WELCOME_HTML = `<b>Send me a file to convert.</b>
<i>89 Supported files:</i>

📷 <b>Images</b> (17)
PNG, JPG, JPEG, JP2, WEBP, BMP, TIF, TIFF, GIF, ICO, HEIC, AVIF, TGS, PSD, SVG, APNG, EPS

🔊 <b>Audio</b> (11)
MP3, OGG, OPUS, WAV, FLAC, WMA, OGA, M4A, AAC, AIFF, AMR

📹 <b>Video</b> (14)
MP4, AVI, WMV, MKV, 3GP, 3GPP, MPG, MPEG, WEBM, TS, MOV, FLV, ASF, VOB

💼 <b>Document</b> (10)
XLSX, XLS, TXT, RTF, DOC, DOCX, ODT, PDF, ODS, TORRENT

🖼 <b>Presentation</b> (10)
PPT, PPTX, PPTM, PPS, PPSX, PPSM, POT, POTX, POTM, ODP

📚 <b>eBook</b> (9)
EPUB, MOBI, AZW3, LRF, PDB, CBR, FB2, CBZ, DJVU

🔤 <b>Font</b> (7)
TTF, OTF, EOT, WOFF, WOFF2, SVG, PFB

💬 <b>Subtitle</b> (11)
SRT, VTT, STL, SBV, SUB, ASS, SSA, LRC, DFXP, TTML, QT.TXT

<i>874 Supported conversions:</i>
https://i.imgur.com/pPMbJKL.png`;

export const TOO_LARGE_HTML =
  `You can't send files above greater than 20MB due to <a href="https://core.telegram.org/bots/api#getfile">Telegram API limit</a>.`;

export const UNSUPPORTED_HTML =
  "❌ This file format is not supported. Send /start to see the list of supported formats.";
export const NO_FILE_HTML = "Please send me a file to convert. Send /start to see the supported formats.";
export const SESSION_EXPIRED = "⌛ This request expired. Please send the file again.";
export const CONVERTING = "⏳ Converting…";
export const CONVERSION_FAILED = "❌ Conversion failed. Please try another format or file.";
export const CONVERSION_TIMEOUT = "⌛ Conversion timed out. Please try a smaller file.";
export const RATE_LIMITED = "🐢 Too many conversions. Please wait a minute and try again.";
export const RESULT_TOO_LARGE = "❌ The converted file is larger than 50 MB and can't be sent via Telegram.";
