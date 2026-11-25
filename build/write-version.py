#!/usr/bin/env python3
"""Write only static release metadata. Never reads user records or credentials."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
sw = re.search(r'const BUILD_VERSION = "(\d{8}-\d{6})"', (root/'sw.js').read_text())
page = re.search(r'<meta name="app-build" content="(\d{8}-\d{6})"', (root/'index.html').read_text())
if not sw or not page or sw[1] != page[1]:
    raise SystemExit('index.html and sw.js must have matching build versions')
paths = [root/name for name in ['index.html','sw.js','manifest.json','privacy.html','support.html']]
paths += list((root/'js').rglob('*.js')) + list((root/'css').glob('*.css'))
paths += [p for p in (root/'icons').iterdir() if p.is_file()]
paths += [root/'shortcuts/health-bridge'/name for name in ['system-techo-health.shortcut','system-techo-health.zip']]
assets = [{'path':p.relative_to(root).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(set(paths))]
assert len(assets) <= 128
(root/'version.json').write_text(json.dumps({'build':sw[1],'assets':assets},ensure_ascii=False,indent=2)+'\n')
print(f'[version] {sw[1]}: {len(assets)} static files hashed')
