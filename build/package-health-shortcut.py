#!/usr/bin/env python3
"""Package a signed public template into an immutable version directory.

AEA1 is a container-format check, not cryptographic signature verification.
The signing/review step must verify the actual signed template before packaging.
Importing this module never packages files.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import io
import json
import os
import plistlib
import shutil
import sys
import tempfile
import zipfile

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
_spec=importlib.util.spec_from_file_location('health_release_builder',ROOT/'build/build-health-shortcut.py')
builder=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(builder)
SIGNED_NAME='system-techo-health.shortcut'
ZIP_NAME='system-techo-health.zip'

def _canonical_template(raw):
    try:
        source=plistlib.loads(raw)
        sends=[a['WFWorkflowActionParameters'] for a in source['WFWorkflowActions']
               if a['WFWorkflowActionIdentifier']=='is.workflow.actions.downloadurl']
        if len(sends)!=1:raise ValueError('Expected one template endpoint')
        endpoint=sends[0]['WFURL']['Value']['string']
        if source!=builder.build(endpoint):raise ValueError('Source is not the generated key-free release template')
        builder.validate(source,endpoint)
    except (KeyError,TypeError,plistlib.InvalidFileException)as error:
        raise ValueError('Invalid public template source')from error

def _archive(raw):
    stream=io.BytesIO()
    info=zipfile.ZipInfo(SIGNED_NAME,date_time=(1980,1,1,0,0,0))
    info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=0o100644<<16
    with zipfile.ZipFile(stream,'w')as archive:archive.writestr(info,raw)
    with zipfile.ZipFile(io.BytesIO(stream.getvalue()))as archive:
        if archive.namelist()!=[SIGNED_NAME]or archive.read(SIGNED_NAME)!=raw:raise ValueError('Unexpected archive content')
    return stream.getvalue()

def package(directory=None):
    directory=Path(directory)if directory is not None else ROOT/'shortcuts/health-bridge'
    release=builder.load_release()
    raw=(directory/SIGNED_NAME).read_bytes()
    if not raw.startswith(b'AEA1'):raise ValueError('Expected an Apple-signed Shortcut container; sign and verify first')
    source=(directory/'system-techo-health.source.plist').read_bytes()
    _canonical_template(source)
    archive=_archive(raw)
    files={SIGNED_NAME:raw,ZIP_NAME:archive,'source.plist':source}
    manifest={'schemaVersion':1,'shortcutName':release['shortcutName'],'shortcutVersion':release['shortcutVersion'],
              'protocolVersion':release['protocolVersion'],'stepsSource':release['source'],
              'releaseNotes':release['releaseNotes'],'signatureContainer':'AEA1',
              'signatureVerification':'not_performed_by_packager',
              'artifacts':{name:{'sha256':hashlib.sha256(value).hexdigest(),'bytes':len(value)}for name,value in files.items()}}
    files['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    releases=directory/'releases';target=releases/release['shortcutVersion']
    # Serialize packager invocations without waiting. A crash can leave a lock;
    # review it explicitly instead of silently resuming an incomplete release.
    lock=directory/'.package-health-release.lock'
    try:fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError as error:raise ValueError('Another packaging operation or unresolved package lock exists')from error
    os.close(fd);stage=None
    try:
        if target.exists():
            if not target.is_dir()or set(p.name for p in target.iterdir())!=set(files):raise ValueError('Existing release is incomplete or differs; use a new version')
            if any(not(target/name).is_file()or(target/name).is_symlink()or(target/name).read_bytes()!=value for name,value in files.items()):raise ValueError('Existing version has different hashes; never overwrite a release')
        else:
            releases.mkdir(parents=True,exist_ok=True)
            stage=Path(tempfile.mkdtemp(prefix='.'+release['shortcutVersion']+'-',dir=releases))
            for name,value in files.items():(stage/name).write_bytes(value)
            stage.rename(target);stage=None
        # Compatibility URL is updated only after immutable validation succeeds.
        with tempfile.NamedTemporaryFile(prefix='.latest-health-',dir=directory,delete=False)as temp:
            latest=Path(temp.name);temp.write(archive)
        try:os.replace(latest,directory/ZIP_NAME)
        finally:latest.unlink(missing_ok=True)
        return manifest
    finally:
        if stage is not None:shutil.rmtree(stage)
        lock.unlink(missing_ok=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--directory',type=Path,default=ROOT/'shortcuts/health-bridge');args=parser.parse_args()
    try:manifest=package(args.directory)
    except (ValueError,OSError)as error:raise SystemExit(str(error))from error
    print(json.dumps(manifest,ensure_ascii=False))

if __name__=='__main__':main()
