#!/usr/bin/env python3
"""Package the signed, key-free template without changing its filename."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
directory = root / 'shortcuts/health-bridge'
signed = directory / 'system-techo-health.shortcut'
raw = signed.read_bytes()
if not raw.startswith(b'AEA1'):
    raise SystemExit('Expected an Apple-signed Shortcut container; sign first')
archive = directory / 'system-techo-health.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
    package.writestr(signed.name, raw)
with zipfile.ZipFile(archive) as package:
    assert package.namelist() == [signed.name]
    assert package.read(signed.name) == raw
print(json.dumps({'file': archive.name, 'contains': [signed.name],
                  'signed_bytes': len(raw), 'signed_sha256': hashlib.sha256(raw).hexdigest(),
                  'zip_sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
