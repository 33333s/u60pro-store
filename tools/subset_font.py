#!/usr/bin/env python3
"""Make the font of the screen UI package (u60pro-devui): Noto Sans CJK SC Regular (SIL OFL 1.1) cut down to what the screen shows.

usage: subset_font.py <NotoSansCJK-Regular.ttc> <out.otf> [--full] [file or directory with the UI's own texts ...]

Kept: Latin, punctuation and symbols; the 3755 level-1 hanzi of GB2312 (the common ones: what operator names, network names and
host names are written with); and every CJK character that occurs in the given files (the pages and sources of the screen UI), so
that nothing the UI itself says can be missing.  A rarer character in a network or host name shows as an empty box.
--full keeps all 6763 hanzi of GB2312 instead (about 1.2 MB more).

Needs fontTools (pip install fonttools)."""
import sys
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTCollection

args = [a for a in sys.argv[1:] if a != '--full']
full = '--full' in sys.argv[1:]
src, out, texts = args[0], args[1], args[2:]
ttc = TTCollection(src)
font = next(f for f in ttc.fonts if 'SC' in f['name'].getDebugName(1))
chars = set(range(0x20, 0x7f)) | set(range(0xa0, 0x180)) | set(range(0x2000, 0x2070)) | set(range(0x2190, 0x2200)) \
    | set(range(0x2460, 0x24ff)) | set(range(0x25a0, 0x2600)) | set(range(0x3000, 0x3040)) | set(range(0xff00, 0xfff0)) \
    | {0x20ac, 0x2103, 0x2109, 0x2122, 0x2212, 0x221e, 0x2248, 0x2260, 0x2264, 0x2265, 0x00b0, 0x00b1, 0x00d7, 0x2026, 0x2030}
# GB2312: rows 0xB0..0xD7 are level 1 (by pinyin, the common characters), 0xD8..0xF7 level 2
for hi in range(0xb0, 0xf8 if full else 0xd8):
    for lo in range(0xa1, 0xff):
        try:
            chars.add(ord(bytes([hi, lo]).decode('gb2312')))
        except UnicodeDecodeError:
            pass
own = set()
for t in texts:
    p = Path(t)
    for f in ([p] if p.is_file() else sorted(q for q in p.rglob('*') if q.is_file())):
        if f.suffix.lower() not in ('.html', '.css', '.js', '.c', '.h', '.cpp', '.txt', '.md', '.json', '.sh', '.conf'):
            continue
        for ch in f.read_text(encoding='utf-8', errors='ignore'):
            if ord(ch) >= 0x2e80:
                own.add(ord(ch))
extra = own - chars
chars |= own
opts = subset.Options()
opts.layout_features = ['kern', 'palt', 'locl']
opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
opts.notdef_outline = True
opts.hinting = False
opts.desubroutinize = True
sub = subset.Subsetter(opts)
sub.populate(unicodes=chars)
sub.subset(font)
font.save(out)
cmap = font.getBestCmap()
print('%s: %d characters (%d from the UI texts beyond the base set), %d bytes' % (out, len(cmap), len(extra), Path(out).stat().st_size))
missing = sorted(own - set(cmap))
if missing:
    print('not in the font: ' + ''.join(chr(c) for c in missing[:60]))
