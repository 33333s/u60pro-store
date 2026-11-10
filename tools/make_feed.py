#!/usr/bin/env python3
"""Build the U60 Pro package feed (apk v3, as OpenWrt 25.12 uses): the packages in packages/ and a signed index.  Run on the Linux
build host as root (files in the packages are then owned by root).

usage: make_feed.py --apk <apk.static> --key <private EC key> --out <dir> --url <repository URL>
       make_feed.py --apk <apk.static> --only <package> --out <dir> --url <repository URL>

  --url    what u60pro-feed puts into /etc/apk/repositories.d/u60pro.list (the address of <out>/u60pro/packages.adb)
  --only   build only these packages, without an index (no key needed): for putting u60pro-feed and the others into a firmware root
  --external  where files built outside this repository are: <dir>/<package>/... (see "external" below); default build/external
  --skip   leave these packages out (a package that is not to be published yet)

Output: <out>/u60pro/ with <name>-<version>.apk, packages.adb (signed with --key; the device verifies it with
/etc/apk/keys/u60pro-feed.pem) and feed.json (what was built).  Packages are not signed one by one, as in OpenWrt: the signed index
carries their hashes.

Package sources: packages/<name>/package.json ({version, arch, description, depends, provides, license,
scripts: {post-install: path, ...}}) and files/ (the tree that gets installed), and for LuCI pages po/zh_Hans/<name>.po (compiled
into the package as /usr/lib/lua/luci/i18n/<name>.zh-cn.lmo).  Files under usr/bin, usr/sbin, usr/libexec, bin, sbin, etc/init.d and
etc/uci-defaults get mode 755.  The public key (u60pro-feed.pem) goes into u60pro-feed.

A package with files built elsewhere (the screen UI's binary, pages and font) names them in "external": {installed path: path under
<external>/<package>/}, a file or a directory; "exec" lists the installed paths that are programs.  The package is left out, with a
note, while they have not been built.

A package can also take files from elsewhere in this repository, where their owner keeps working on them: "repo": {installed
path: path from the repository root}.  "exec" applies to
these too.

All packages are "noarch" (scripts and web pages), so the feed does not depend on the architecture the firmware is built for.
Kernel modules are not here yet: they belong to one kernel build each and come with the kernel work."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import po2lmo  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
DIST = 'u60pro'
EXEC_PREFIXES = ('usr/bin/', 'usr/sbin/', 'usr/libexec/', 'bin/', 'sbin/', 'etc/init.d/', 'etc/uci-defaults/')
BINARY = ('.png', '.jpg', '.gif', '.ico', '.woff', '.woff2', '.bin', '.ko', '.gz', '.otf', '.ttf')
MAINTAINER = 'U60 Pro OpenWrt'


def copy_tree(src, dst):
    """files/ into a fresh tree with root-friendly modes: 755 for directories and programs, 644 for the rest"""
    for p in sorted(src.rglob('*')):
        rel = p.relative_to(src).as_posix()
        t = dst / rel
        if p.is_dir():
            t.mkdir(parents=True, exist_ok=True)
            t.chmod(0o755)
        else:
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(p.read_bytes() if rel.endswith(BINARY) else p.read_bytes().replace(b'\r\n', b'\n'))
            t.chmod(0o755 if rel.startswith(EXEC_PREFIXES) else 0o644)
    dst.chmod(0o755)


def put(files, rel, data, mode=0o644):
    t = files / rel
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_bytes(data)
    t.chmod(mode)
    for q in t.relative_to(files).parents:
        (files / q).chmod(0o755)


def source_date_epoch():
    """SOURCE_DATE_EPOCH, by default the time of the HEAD commit"""
    if not os.environ.get('SOURCE_DATE_EPOCH'):
        os.environ['SOURCE_DATE_EPOCH'] = subprocess.check_output(['git', '-C', str(REPO), 'log', '-1', '--format=%ct'], text=True).strip()
    return int(os.environ['SOURCE_DATE_EPOCH'])


def mkpkg(apk, out, name, meta, files, scripts):
    # every file time is SOURCE_DATE_EPOCH: the same commit makes the same packages (the signed index differs, ECDSA is randomised)
    t = source_date_epoch()
    for p in [files, *files.rglob('*')]:
        os.utime(p, (t, t), follow_symlinks=False)
    cmd = [str(apk), 'mkpkg', '--info', 'name:' + name, '--info', 'version:' + meta['version'], '--info', 'arch:' + meta.get('arch', 'noarch'),
           '--info', 'description:' + meta['description'], '--info', 'maintainer:' + MAINTAINER, '--info', 'license:' + meta.get('license', 'MIT')]
    if meta.get('depends'):
        cmd += ['--info', 'depends:' + ' '.join(meta['depends'])]
    if meta.get('provides'):
        cmd += ['--info', 'provides:' + ' '.join(meta['provides'])]
    for kind, path in scripts.items():
        cmd += ['--script', '%s:%s' % (kind, path)]
    target = out / ('%s-%s.apk' % (name, meta['version']))
    subprocess.run(cmd + ['--files', str(files), '-o', str(target)], check=True)
    return target


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apk', type=Path, required=True)
    ap.add_argument('--key', type=Path)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--url', required=True)
    ap.add_argument('--only', action='append', default=[], metavar='PACKAGE')
    ap.add_argument('--external', type=Path, default=REPO / 'build' / 'external')
    ap.add_argument('--skip', action='append', default=[], metavar='PACKAGE')
    a = ap.parse_args()
    if not a.only and not a.key:
        raise SystemExit('--key is needed to sign the index (or --only for single packages)')
    packages = REPO / 'packages'
    unknown = sorted(set(a.only) - {d.name for d in packages.iterdir()})
    if unknown:
        raise SystemExit('--only: no such package in packages: %s' % ', '.join(unknown))
    out = a.out / DIST
    if out.exists():
        raise SystemExit('output exists: %s' % out)
    out.mkdir(parents=True)
    made = []
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for d in sorted(packages.iterdir()):
            if (a.only and d.name not in a.only) or d.name in a.skip or not (d / 'package.json').is_file():
                continue
            meta = json.loads((d / 'package.json').read_text(encoding='utf-8'))
            external = {k: a.external / d.name / v for k, v in meta.get('external', {}).items()}
            missing = [str(v) for v in external.values() if not v.exists()]
            if missing:
                print('skipping %s: not built (%s)' % (d.name, ', '.join(missing)))
                continue
            in_repo = {k: REPO / v for k, v in meta.get('repo', {}).items()}
            missing = [str(v) for v in in_repo.values() if not v.is_file()]
            if missing:
                raise SystemExit('%s: no such file in the repository: %s' % (d.name, ', '.join(missing)))
            files = tmp / ('files-' + d.name)
            files.mkdir()
            if (d / 'files').is_dir():
                copy_tree(d / 'files', files)
            for rel, src in external.items():
                if src.is_dir():
                    (files / rel).mkdir(parents=True, exist_ok=True)
                    copy_tree(src, files / rel)
                    for q in (files / rel).relative_to(files).parents:
                        (files / q).chmod(0o755)
                else:
                    put(files, rel, src.read_bytes(), 0o755 if rel in meta.get('exec', []) else 0o644)
            for rel, src in in_repo.items():
                put(files, rel, src.read_bytes().replace(b'\r\n', b'\n'), 0o755 if rel in meta.get('exec', []) else 0o644)
            for po in sorted((d / 'po' / 'zh_Hans').glob('*.po')):
                put(files, 'usr/lib/lua/luci/i18n/%s.zh-cn.lmo' % po.stem, po2lmo.build(po2lmo.parse_po(po.read_text(encoding='utf-8'))))
            if d.name == 'u60pro-feed':
                put(files, 'etc/apk/keys/u60pro-feed.pem', (REPO / 'u60pro-feed.pem').read_bytes())
                put(files, 'etc/apk/repositories.d/u60pro.list',
                    ('# the U60 Pro package feed (device-specific packages), signed with /etc/apk/keys/u60pro-feed.pem\n%s\n' % a.url).encode())
            scripts = {}
            for kind, rel in meta.get('scripts', {}).items():
                s = tmp / ('script-%s-%s' % (d.name, kind))
                s.write_bytes((d / rel).read_bytes().replace(b'\r\n', b'\n'))
                scripts[kind] = str(s)
            made.append(mkpkg(a.apk, out, d.name, meta, files, scripts))
    if not a.only:
        subprocess.run([str(a.apk), '--allow-untrusted', '--sign-key', str(a.key), 'mkndx', '--output', str(out / 'packages.adb')]
                       + [str(p) for p in made], check=True)
    listing = [{'file': p.name, 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in made]
    (out / 'feed.json').write_text(json.dumps({'url': a.url, 'packages': listing}, indent=1) + '\n')
    for f in [out] + list(out.iterdir()):
        os.chmod(f, 0o755 if f.is_dir() else 0o644)
    print(json.dumps({'out': str(out), 'packages': len(made)}))


if __name__ == '__main__':
    main()
