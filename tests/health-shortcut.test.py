"""Checks Shortcuts parameter serialization; no Health, user shortcuts, or network."""
import hashlib, json
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

    def test_success_does_not_open_safari_or_claim_app_records_are_saved(self):
        workflow = builder.build(ENDPOINT)
        actions = workflow['WFWorkflowActions']
        self.assertFalse(any(a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.openurl' for a in actions),
                         'an HTTPS callback opens Safari, not the originating Home Screen app')
        notice = next(a['WFWorkflowActionParameters'] for a in actions
                      if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.notification')
        self.assertEqual(notice['WFNotificationActionTitle']['Value']['string'], 'ヘルスケアの送信を受け付けました')
        body = notice['WFNotificationActionBody']['Value']['string']
        self.assertIn('左上', body)
        self.assertIn('システム手帳', body)
        self.assertNotIn('Safariが開いた', body)

    def test_date_window_adjustments_use_native_single_token_text_inputs(self):
        workflow = builder.build(ENDPOINT)
        actions = workflow['WFWorkflowActions']
        adjustments = [a['WFWorkflowActionParameters'] for a in actions
                       if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.adjustdate']
        self.assertEqual(len(adjustments), 2)
        for adjustment in adjustments:
            # Native bounds probe: a standalone Attachment renders WFDate as
            # empty and produces no WindowStart; this field takes token text.
            value = adjustment['WFDate']
            self.assertEqual(value['WFSerializationType'], 'WFTextTokenString')
            self.assertEqual(value['Value']['string'], '\ufffc')
            self.assertEqual(set(value['Value']['attachmentsByRange']), {'{0, 1}'})
        start_token = adjustments[0]['WFDate']['Value']['attachmentsByRange']['{0, 1}']
        raw_date = next(a for a in actions
                        if a['WFWorkflowActionParameters']['UUID'] == start_token['OutputUUID'])
        self.assertEqual(raw_date['WFWorkflowActionIdentifier'], 'is.workflow.actions.date')
        self.assertEqual(adjustments[0]['WFAdjustOperation'], 'Get Start of Day')
        self.assertEqual(adjustments[1]['WFDate']['Value']['attachmentsByRange']['{0, 1}'],
                         {'Type': 'Variable', 'VariableName': 'WindowStart'})
        self.assertEqual(adjustments[1]['WFAdjustOperation'], 'Add')
        self.assertEqual(adjustments[1]['WFDuration']['Value'], {'Magnitude': '1', 'Unit': 'days'})

    def test_each_health_sample_uses_the_native_custom_date_format_field(self):
        workflow = builder.build(ENDPOINT)
        formats = [a['WFWorkflowActionParameters'] for a in workflow['WFWorkflowActions']
                   if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.format.date']
        self.assertEqual(len(formats), 4)
        for fmt in formats:
            # Native fixed-date RED/GREEN: old Format='Custom' produced an
            # empty string for Nov24 and Nov25; Format='yyyy-MM-dd' kept both.
            self.assertEqual(fmt['WFDateFormatStyle'], 'Custom')
            self.assertEqual(fmt['WFDateFormat'], 'yyyy-MM-dd')
            self.assertNotIn('WFDateFormatString', fmt)

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

    def test_watch_steps_query_and_source_gate_are_explicit(self):
        actions = builder.build(ENDPOINT)['WFWorkflowActions']
        kind = lambda a: a['WFWorkflowActionIdentifier'].removeprefix('is.workflow.actions.')
        params = lambda a: a['WFWorkflowActionParameters']
        queries = [params(a) for a in actions if kind(a) == 'filter.health.quantity']
        self.assertNotIn('WFHKSampleFilteringGroupBy', queries[-1])
        self.assertEqual(queries[2]['WFHKSampleFilteringGroupBy'], 'Day')
        source = next(a for a in actions if kind(a) == 'properties.health.quantity' and params(a)['WFContentItemPropertyName'] == 'Source')
        match = next(a for a in actions if kind(a) == 'text.match' and params(a)['WFMatchTextPattern'] == 'Apple Watch')
        self.assertFalse(params(match)['WFMatchTextCaseSensitive'])
        self.assertLess(actions.index(source), actions.index(match))
        guard = actions[actions.index(match)+1]
        self.assertEqual(params(guard)['WFCondition'], 100)
        self.assertEqual(params(guard)['WFInput']['Variable']['Value'], {'Type':'ActionOutput','OutputUUID':params(match)['UUID'],'OutputName':'Matches'})
        steps_setters = [params(a) for a in actions if kind(a) == 'setvalueforkey' and params(a)['WFDictionaryKey'] == 'steps']
        self.assertEqual(len(steps_setters), 2)
        self.assertEqual(steps_setters[0]['WFDictionaryValue']['Value']['attachmentsByRange']['{0, 1}'], {'Type':'Variable','VariableName':'WatchStepsSum'})
        self.assertTrue(any(kind(a) == 'math' and params(a)['WFMathOperation'] == '+' for a in actions))

    def test_other_three_metrics_and_date_window_are_byte_equivalent_to_baseline(self):
        # Snapshot captured from pre-Watch HEAD 2417aaecfdea66681c1f206407b4261ae6ec9d80.
        # Includes the exact date bounds, all actions/UUIDs in the other three
        # metric blocks, and their missing/latest/day/unit extraction gates.
        actions = builder.build(ENDPOINT)['WFWorkflowActions']
        kind = lambda a: a['WFWorkflowActionIdentifier'].removeprefix('is.workflow.actions.')
        params = lambda a: a['WFWorkflowActionParameters']
        start = next(i for i,a in enumerate(actions) if kind(a) == 'date')
        query = next(i for i,a in enumerate(actions) if kind(a) == 'filter.health.quantity' and params(a)['WFContentItemFilter']['Value']['WFActionParameterFilterTemplates'][0]['Values']['Enumeration']['Value'] == 'Steps')
        end = max(i for i in range(query) if kind(actions[i]) == 'comment')
        digest = hashlib.sha256(json.dumps(actions[start:end],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.assertEqual(digest, '0343a1735b2607e79dc7fa91b8a9a8e73cf3d2075600f0f7a8b3656c3c267481')

    def test_payload_statically_identifies_watch_steps_without_changing_endpoint_or_input(self):
        workflow = builder.build(ENDPOINT)
        actions = workflow['WFWorkflowActions']
        source = [a['WFWorkflowActionParameters'] for a in actions if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.setvalueforkey' and a['WFWorkflowActionParameters']['WFDictionaryKey'] == 'stepsSource']
        self.assertEqual(len(source), 1)
        self.assertEqual(source[0]['WFDictionaryValue']['Value']['string'], 'apple_watch')
        self.assertEqual(source[0]['WFDictionary']['Value']['VariableName'], 'Payload')
        send = next(a['WFWorkflowActionParameters'] for a in actions if a['WFWorkflowActionIdentifier'] == 'is.workflow.actions.downloadurl')
        self.assertEqual(send['WFURL']['Value']['string'], ENDPOINT)
        self.assertEqual(workflow['WFWorkflowInputContentItemClasses'], ['WFStringContentItem'])
        self.assertEqual(len(workflow['WFWorkflowImportQuestions']), 1)

    def test_plist_round_trip_and_setup_question_keep_the_placeholder(self):
        workflow = builder.build(ENDPOINT)
        self.assertEqual(plistlib.loads(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY)), workflow)
        question = workflow['WFWorkflowImportQuestions'][0]
        action = workflow['WFWorkflowActions'][question['ActionIndex']]
        self.assertEqual(action['WFWorkflowActionParameters'][question['ParameterKey']], builder.PLACEHOLDER)
        builder.validate(workflow, ENDPOINT)


if __name__ == '__main__':
    unittest.main()
