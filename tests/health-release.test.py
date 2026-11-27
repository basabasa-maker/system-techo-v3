"""Release contract and immutable packaging tests; fake AEA bytes only, no signing/network."""
import ast,copy,importlib.util,json,plistlib,sys,tempfile,unittest,zipfile
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
builder=module('release_builder',ROOT/'build/build-health-shortcut.py')
pack_path=ROOT/'build/package-health-shortcut.py'
safe=any(isinstance(n,ast.FunctionDef)and n.name=='package'for n in ast.parse(pack_path.read_text()).body)
packager=module('release_packager',pack_path)if safe else None
ENDPOINT='https://example.invalid/health-cache'
class ReleaseTests(unittest.TestCase):
 def test_central_release_definition_and_builder_entrypoints_exist(self):
  self.assertTrue((ROOT/'build/health-release.json').is_file())
  self.assertTrue(callable(getattr(builder,'load_release',None)))
  self.assertTrue(callable(getattr(builder,'release_js',None)))
  self.assertIsNotNone(packager,'packager must be import-safe with an explicit package entrypoint')
 def release(self):
  if not hasattr(builder,'load_release'):self.skipTest('release slice not implemented')
  return builder.load_release()
 def test_template_name_comment_and_static_payload_version_fields(self):
  release=self.release();self.assertEqual((release['shortcutVersion'],release['protocolVersion'],release['source']),('1.0.1',1,'apple_watch'))
  w=builder.build(ENDPOINT);self.assertEqual(w['WFWorkflowName'],'system-techo-health')
  first=w['WFWorkflowActions'][0]['WFWorkflowActionParameters']['WFCommentActionText'];self.assertIn('1.0.1',first);self.assertIn('protocol=1',first)
  actions=w['WFWorkflowActions'];bind=next(i for i,a in enumerate(actions)if a['WFWorkflowActionIdentifier']=='is.workflow.actions.setvariable'and a['WFWorkflowActionParameters'].get('WFVariableName')=='Payload')
  fields=actions[bind-1]['WFWorkflowActionParameters']['WFItems']['Value']['WFDictionaryFieldValueItems'];self.assertEqual(len(fields),2)
  self.assertEqual([(x['WFKey']['Value']['string'],x['WFItemType'])for x in fields],[('shortcutVersion',0),('protocolVersion',3)])
  self.assertEqual(fields[0]['WFValue']['Value']['string'],'1.0.1')
  self.assertNotIn('shortcutVersion',[a['WFWorkflowActionParameters'].get('WFDictionaryKey')for a in actions if a['WFWorkflowActionIdentifier']=='is.workflow.actions.setvalueforkey'])
  self.assertEqual(len(actions),176,'static metadata must not insert or reorder existing actions')
 def test_static_number_uses_native_number_item_type(self):
  actions=builder.build(ENDPOINT)['WFWorkflowActions']
  i=next(i for i,a in enumerate(actions)if a['WFWorkflowActionIdentifier']=='is.workflow.actions.setvariable'and a['WFWorkflowActionParameters'].get('WFVariableName')=='Payload')
  fields=actions[i-1]['WFWorkflowActionParameters']['WFItems']['Value']['WFDictionaryFieldValueItems']
  field=next(field for field in fields if field['WFKey']['Value']['string']=='protocolVersion')
  self.assertEqual(field['WFItemType'],3,'type1 is a nested Dictionary, not Number')
  # Apple-authored key-free dictionary export: type3 chooses Number,
  # while the literal itself uses the same token-text state as the key.
  self.assertEqual(field['WFValue'],{'Value':{'string':'1'},'WFSerializationType':'WFTextTokenString'})
 def test_generated_js_comes_from_same_release_and_versioned_zip_path(self):
  r=self.release();js=builder.release_js(r)
  for text in ['HEALTH_SHORTCUT_RELEASE','HEALTH_SHORTCUT_VERSION','HEALTH_SHORTCUT_PROTOCOL_VERSION','HEALTH_STEPS_SOURCE','HEALTH_SHORTCUT_ZIP_URL','releases/1.0.1/system-techo-health.zip','apple_watch','system-techo-health']:self.assertIn(text,js)
  self.assertEqual((ROOT/'js/health/release.js').read_text(),js)
 def make_dir(self,tmp,raw=b'AEA1_FAKE_SYNTHETIC_SIGNED_CONTAINER'):
  directory=Path(tmp)/'health-bridge';directory.mkdir()
  (directory/'system-techo-health.shortcut').write_bytes(raw)
  (directory/'system-techo-health.source.plist').write_bytes(plistlib.dumps(builder.build(ENDPOINT),fmt=plistlib.FMT_XML,sort_keys=False))
  return directory
 def test_packaging_is_immutable_idempotent_and_latest_zip_compatible(self):
  self.release()
  if packager is None:self.skipTest('packager slice not implemented')
  with tempfile.TemporaryDirectory()as tmp:
   d=self.make_dir(tmp);manifest=packager.package(d);version=d/'releases/1.0.1'
   self.assertEqual(set(p.name for p in version.iterdir()),{'system-techo-health.shortcut','system-techo-health.zip','source.plist','manifest.json'})
   self.assertEqual(manifest['shortcutVersion'],'1.0.1');self.assertEqual(manifest['protocolVersion'],1);self.assertEqual(manifest['stepsSource'],'apple_watch');self.assertEqual(manifest['shortcutName'],'system-techo-health')
   self.assertEqual((version/'system-techo-health.zip').read_bytes(),(d/'system-techo-health.zip').read_bytes())
   with zipfile.ZipFile(version/'system-techo-health.zip')as z:self.assertEqual(z.namelist(),['system-techo-health.shortcut']);self.assertEqual(z.read(z.namelist()[0]),(d/'system-techo-health.shortcut').read_bytes())
   before={p.name:p.read_bytes()for p in version.iterdir()};self.assertEqual(packager.package(d),manifest);self.assertEqual({p.name:p.read_bytes()for p in version.iterdir()},before)
   (d/'system-techo-health.shortcut').write_bytes(b'AEA1_FAKE_DIFFERENT_BYTES');latest=(d/'system-techo-health.zip').read_bytes()
   with self.assertRaises(ValueError):packager.package(d)
   self.assertEqual({p.name:p.read_bytes()for p in version.iterdir()},before);self.assertEqual((d/'system-techo-health.zip').read_bytes(),latest)
 def test_packaging_rejects_unsigned_and_personalized_sources_before_writes(self):
  self.release()
  if packager is None:self.skipTest('packager slice not implemented')
  for mode in ['unsigned','personalized','metadata']:
   with self.subTest(mode=mode),tempfile.TemporaryDirectory()as tmp:
    d=self.make_dir(tmp,raw=b'NOT_SIGNED'if mode=='unsigned'else b'AEA1_FAKE')
    if mode!='unsigned':
     path=d/'system-techo-health.source.plist';source=plistlib.loads(path.read_bytes())
     if mode=='personalized':source['WFWorkflowActions'][1]['WFWorkflowActionParameters']['WFTextActionText']='x'*43
     else:source['WFWorkflowName']='unexpected-name'
     path.write_bytes(plistlib.dumps(source))
    with self.assertRaises(ValueError):packager.package(d)
    self.assertFalse((d/'releases').exists());self.assertFalse((d/'system-techo-health.zip').exists())
 def test_manifest_contains_only_public_fixed_release_fields_and_hashes(self):
  self.release()
  if packager is None:self.skipTest('packager slice not implemented')
  with tempfile.TemporaryDirectory()as tmp:
   d=self.make_dir(tmp);manifest=packager.package(d);text=json.dumps(manifest)
   self.assertNotIn('pair_key',text);self.assertNotIn('PairKey',text);self.assertNotIn(ENDPOINT,text);self.assertNotIn(builder.PLACEHOLDER,text)
   for artifact in manifest['artifacts'].values():self.assertRegex(artifact['sha256'],r'^[a-f0-9]{64}$');self.assertGreater(artifact['bytes'],0)
 def test_partial_or_tampered_existing_version_is_rejected(self):
  self.release()
  if packager is None:self.skipTest('packager slice not implemented')
  with tempfile.TemporaryDirectory()as tmp:
   d=self.make_dir(tmp);packager.package(d);path=d/'releases/1.0.1/source.plist';path.write_bytes(b'tampered');before=path.read_bytes()
   with self.assertRaises(ValueError):packager.package(d)
   self.assertEqual(path.read_bytes(),before)
if __name__=='__main__':unittest.main()
