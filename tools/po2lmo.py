#!/usr/bin/env python3
"""Compile gettext .po files into LuCI .lmo catalogs (the format luci-base's po2lmo writes and luci.core reads).

usage: po2lmo.py <in.po> <out.lmo>

A catalog is the translated strings back to back (each padded to 4 bytes), followed by an index of 16-byte big-endian records
(key hash, value hash, offset, length) sorted by key hash, followed by a 4-byte big-endian offset of the index.  Keys are the
SuperFastHash of the msgid, exactly what the browser side computes for _('...').  Plural forms are not used by our pages and
are rejected so that nothing is silently dropped."""
import re
import struct
import sys
from pathlib import Path


def s8(b):
    """a byte as C's signed char: LuCI's lmo.c and the browser side (cbi.js) read the 1 or 3 trailing bytes signed, so a msgid whose
    UTF-8 length is 1 or 3 mod 4 and that ends in a non-ASCII character (Chinese, an ellipsis) hashes differently when read unsigned"""
    return b - 256 if b > 0x7f else b


def sfh(data: bytes, init=None):
    n = len(data)
    h = n if init is None else init
    rem = n & 3
    i = 0
    for _ in range(n >> 2):
        h = (h + (data[i] | data[i + 1] << 8)) & 0xffffffff
        tmp = (((data[i + 2] | data[i + 3] << 8) << 11) & 0xffffffff) ^ h
        h = ((h << 16) & 0xffffffff) ^ tmp
        i += 4
        h = (h + (h >> 11)) & 0xffffffff
    if rem == 3:
        h = (h + (data[i] | data[i + 1] << 8)) & 0xffffffff
        h ^= (h << 16) & 0xffffffff
        h ^= (s8(data[i + 2]) << 18) & 0xffffffff
        h = (h + (h >> 11)) & 0xffffffff
    elif rem == 2:
        h = (h + (data[i] | data[i + 1] << 8)) & 0xffffffff
        h ^= (h << 11) & 0xffffffff
        h = (h + (h >> 17)) & 0xffffffff
    elif rem == 1:
        h = (h + s8(data[i])) & 0xffffffff
        h ^= (h << 10) & 0xffffffff
        h = (h + (h >> 1)) & 0xffffffff
    h ^= (h << 3) & 0xffffffff
    h = (h + (h >> 5)) & 0xffffffff
    h ^= (h << 4) & 0xffffffff
    h = (h + (h >> 17)) & 0xffffffff
    h ^= (h << 25) & 0xffffffff
    h = (h + (h >> 6)) & 0xffffffff
    return h


def unquote(s):
    s = s.strip()
    assert s[0] == '"' and s[-1] == '"', s
    out, i, s = [], 1, s[:-1]
    while i < len(s):
        c = s[i]
        if c == '\\':
            i += 1
            c = s[i]
            out.append({'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\'}.get(c, '\\' + c))
        else:
            out.append(c)
        i += 1
    return ''.join(out)


def parse_po(text):
    """returns [(msgid, msgstr)] without the header entry and untranslated entries"""
    entries, cur, field = [], {}, None
    for raw in text.splitlines() + ['']:
        line = raw.strip()
        if line.startswith('#') :
            continue
        if not line:
            if 'msgid' in cur:
                entries.append(cur)
            cur, field = {}, None
            continue
        m = re.match(r'(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")$', line)
        if m:
            field = m.group(1)
            if field.startswith('msgid_plural') or field.startswith('msgstr['):
                raise SystemExit('plural forms are not supported: ' + line)
            cur[field] = unquote(m.group(2))
        elif line.startswith('"') and field:
            cur[field] += unquote(line)
        else:
            raise SystemExit('cannot parse: ' + raw)
    out = []
    for e in entries:
        if e.get('msgid') and e.get('msgstr'):
            out.append((e['msgid'], e['msgstr']))
    return out


def build(entries):
    data = bytearray()
    index = []
    seen = {}
    for key, val in entries:
        kb, vb = key.encode('utf-8'), val.encode('utf-8')
        kid = sfh(kb)
        if kid in seen and seen[kid] != key:
            raise SystemExit('hash collision between %r and %r' % (seen[kid], key))
        seen[kid] = key
        offset = len(data)
        data += vb
        data += b'\0' * ((4 - len(data) % 4) % 4)
        index.append((kid, sfh(vb), offset, len(vb)))
    index.sort(key=lambda r: r[0])
    idx_off = len(data)
    for r in index:
        data += struct.pack('>IIII', *r)
    data += struct.pack('>I', idx_off)
    return bytes(data)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    entries = parse_po(Path(sys.argv[1]).read_text(encoding='utf-8'))
    Path(sys.argv[2]).write_bytes(build(entries))
    print('%s: %d strings' % (sys.argv[2], len(entries)))


if __name__ == '__main__':
    main()
