"""Checks Shortcuts parameter serialization; no Health, user shortcuts, or network."""
import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
import plistlib
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('health_shortcut_builder', ROOT / 'build/build-health-shortcut.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
ENDPOINT = 'https://example.invalid/health-cache'


class HealthShortcutTests(unittest.TestCase):
    def test_dictionary_value_fields_use_exported_single_token_text_format(self):
        # The failing format was reproduced in native Shortcuts: an Attachment
        # placed in WFDictionaryValue is treated as a missing required value.
        workflow = builder.build(ENDPOINT)
        setters = [a['WFWorkflowActionParameters'] for a in workflow['WFWorkflowActions']
                   if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.setvalueforkey']
        dynamic = []
        for setter in setters:
            value = setter['WFDictionaryValue']
            self.assertEqual(value['WFSerializationType'], 'WFTextTokenString', setter['WFDictionaryKey'])
            state = value['Value']
            if 'attachmentsByRange' in state:
                self.assertEqual(state['string'], '\ufffc', 'one variable, no added quotes or text coercion')
                self.assertEqual(set(state['attachmentsByRange']), {'{0, 1}'})
                variable = state['attachmentsByRange']['{0, 1}']
                self.assertIn(variable['Type'], ('Variable', 'ActionOutput'))
                dynamic.append(setter['WFDictionaryKey'])
            self.assertEqual(setter['WFDictionary']['WFSerializationType'], 'WFTextTokenAttachment')
        self.assertEqual(len(dynamic), 10)
        for key in ('request_id', 'pair_key', 'date', 'issued_at', 'values', 'units'):
            self.assertIn(key, dynamic)

    def test_http_body_is_an_attachment_to_the_json_text_output(self):
        workflow = builder.build(ENDPOINT)
        actions = workflow['WFWorkflowActions']
        send = next(a['WFWorkflowActionParameters'] for a in actions
                    if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.downloadurl')
        # Native File body selector ignores WFTextTokenString and displays
        # an unassigned variable. Exported native selection uses Attachment.
        body = send['WFRequestVariable']
        self.assertEqual(body['WFSerializationType'], 'WFTextTokenAttachment')
        token = body['Value']
        self.assertEqual(token['Type'], 'ActionOutput')
        source = next(a for a in actions if a['WFWorkflowActionParameters']['UUID'] == token['OutputUUID'])
        self.assertEqual(source['WFWorkflowActionIdentifier'], 'is.workflow.actions.gettext')
        value = source['WFWorkflowActionParameters']['WFTextActionText']['Value']
        self.assertEqual(value['string'], '\ufffc')
        self.assertEqual(value['attachmentsByRange']['{0, 1}'], builder.Workflow().var('Payload'))
        self.assertEqual(send['WFHTTPBodyType'], 'File')
        self.assertEqual(send['WFHTTPMethod'], 'POST')

    def test_all_four_health_filters_and_missing_value_rules_remain(self):
        workflow = builder.build(ENDPOINT)
        actions = workflow['WFWorkflowActions']
        filters = [a['WFWorkflowActionParameters'] for a in actions
                   if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.filter.health.quantity']
        kinds = []
        for params in filters:
            rows = params['WFContentItemFilter']['Value']['WFActionParameterFilterTemplates']
            kinds.append(next(r for r in rows if r['Property'] == 'Type')['Values']['Enumeration']['Value'])
            self.assertFalse(params['WFHKSampleFilteringFillMissing'])
        self.assertEqual(kinds, ['Weight', 'Body Fat Percentage', 'Active Calories', 'Steps'])
        self.assertFalse(any(a['WFWorkflowActionIdentifier'].startswith('is.workflow.actions.health.') for a in actions))
        self.assertNotIn(b'habit_day_upsert', plistlib.dumps(workflow))
        self.assertNotIn(b'Basal', plistlib.dumps(workflow))

    def test_plist_round_trip_and_setup_question_keep_the_placeholder(self):
        workflow = builder.build(ENDPOINT)
        self.assertEqual(plistlib.loads(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY)), workflow)
        question = workflow['WFWorkflowImportQuestions'][0]
        action = workflow['WFWorkflowActions'][question['ActionIndex']]
        self.assertEqual(action['WFWorkflowActionParameters'][question['ParameterKey']], builder.PLACEHOLDER)
        builder.validate(workflow, ENDPOINT)


if __name__ == '__main__':
    unittest.main()
