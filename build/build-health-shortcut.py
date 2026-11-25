#!/usr/bin/env python3
"""Build the key-free iPhone Health bridge prototype. Does not read Health or run a shortcut."""
from pathlib import Path
import argparse, json, plistlib, re, uuid

ROOT = Path(__file__).resolve().parents[1]
NAME = 'システム手帳 ヘルスケア同期'
CALLBACK = 'https://basabasa-maker.github.io/system-techo-v3/#health-return'
PLACEHOLDER = 'PASTE_HEALTH_PAIR_KEY_HERE'
NS = uuid.UUID('b6d14ce9-5f18-4c39-9421-317d60fb7be4')

class Workflow:
    def __init__(self): self.actions=[]; self.sequence=0
    def uid(self, label):
        self.sequence+=1
        return str(uuid.uuid5(NS, f'{self.sequence}:{label}')).upper()
    def add(self, identifier, **params):
        ident = identifier if identifier.startswith('is.workflow.actions.') else 'is.workflow.actions.'+identifier
        output=self.uid(ident);params['UUID']=output
        self.actions.append({'WFWorkflowActionIdentifier':ident,'WFWorkflowActionParameters':params})
        return output
    def ref(self, output, name='Output'):
        return {'Type':'ActionOutput','OutputUUID':output,'OutputName':name}
    def var(self, name): return {'Type':'Variable','VariableName':name}
    def att(self, value): return {'Value':value,'WFSerializationType':'WFTextTokenAttachment'}
    def text(self, *parts):
        string='';attachments={}
        for part in parts:
            if isinstance(part,dict): attachments['{%d, 1}'%len(string)]=part;string+='\ufffc'
            else: string+=str(part)
        return {'Value':{'string':string, **({'attachmentsByRange':attachments} if attachments else {})},'WFSerializationType':'WFTextTokenString'}
    def bind(self,name,ref): return self.add('setvariable',WFVariableName=name,WFInput=self.att(ref))
    def get(self,source,key):return self.add('getvalueforkey',WFGetDictionaryValueType='Value',WFDictionaryKey=key,WFInput=self.att(source))
    def condition(self,ref,code,literal=None):
        group=self.uid('if');params={'GroupingIdentifier':group,'WFControlFlowMode':0,'WFCondition':code,'WFInput':{'Type':'Variable','Variable':self.att(ref)}}
        if literal is not None:
            if isinstance(literal,(float,int)):
                if code==4:params['WFCondition']=1003;params['WFAnotherNumber']=literal
                params['WFNumberValue']=literal
            else:params['WFConditionalActionString']=self.text(literal) if isinstance(literal,str) else self.text(literal)
        self.add('conditional',**params);return group
    def end(self,group,kind='conditional'):return self.add(kind,GroupingIdentifier=group,WFControlFlowMode=2)
    def stop(self,message):
        self.add('alert',WFAlertActionTitle='ヘルスケア連携',WFAlertActionMessage=self.text(message),WFAlertActionCancelButtonShown=False)
        self.add('exit')
    def regex_guard(self,ref,pattern,message):
        out=self.add('text.match',text=self.text(ref),WFMatchTextPattern=pattern,WFMatchTextCaseSensitive=True)
        group=self.condition(self.ref(out,'Matches'),101);self.stop(message);self.end(group)
    def dictionary(self):return self.add('dictionary',WFItems={'Value':{'WFDictionaryFieldValueItems':[]},'WFSerializationType':'WFDictionaryFieldValue'})
    def put(self,dictionary,key,ref):
        out=self.add('setvalueforkey',WFDictionaryKey=key,WFDictionaryValue=self.text(ref if isinstance(ref,dict) else str(ref)),WFDictionary=self.att(self.var(dictionary)))
        self.bind(dictionary,self.ref(out,'Dictionary'))


def build(endpoint):
    w=Workflow()
    w.add('comment',WFCommentActionText='試作品：対象日の4項目だけを読み取り、一時保管APIに送信します。Healthへの書込・習慣シートへの直接書込は行いません。実機での単位・集計の確認後に連携を有効にしてください。')
    key_index=len(w.actions)
    pair=w.add('gettext',WFTextActionText=PLACEHOLDER);w.bind('PairKey',w.ref(pair,'Text'))
    w.regex_guard(w.var('PairKey'),r'^[A-Za-z0-9_-]{43}$','手帳の連携設定で発行した43文字の連携キーを、このショートカット冒頭のテキストへ設定してください。')
    request=w.add('detect.dictionary',WFInput=w.att({'Type':'ExtensionInput'}));w.bind('Request',w.ref(request,'Dictionary'))
    for key,name,pattern in [('request_id','RequestID',r'^[A-Za-z0-9_-]{32,96}$'),('date','TargetDay',r'^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$')]:
        value=w.get(w.var('Request'),key);w.bind(name,w.ref(value,'Dictionary Value'))
        w.regex_guard(w.var(name),pattern,'手帳の習慣タブの更新ボタンから実行してください。入力された対象日またはリクエストが正しくありません。')
    issued=w.get(w.var('Request'),'issued_at');number=w.add('number',WFNumberActionNumber=w.text(w.ref(issued,'Dictionary Value')));w.bind('IssuedAt',w.ref(number,'Number'))
    raw_date=w.add('date',WFDateActionMode='Specified Date',WFDateActionDate=w.text(w.var('TargetDay')))
    start=w.add('adjustdate',WFDate=w.att(w.ref(raw_date,'Date')),WFAdjustOperation='Get Start of Day');w.bind('WindowStart',w.ref(start,'Adjusted Date'))
    end=w.add('adjustdate',WFDate=w.att(w.var('WindowStart')),WFAdjustOperation='Add',WFDuration={'Value':{'Magnitude':'1','Unit':'days'},'WFSerializationType':'WFQuantityFieldValue'});w.bind('WindowEnd',w.ref(end,'Adjusted Date'))
    for name in ['HealthValues','HealthUnits']:
        empty=w.dictionary();w.bind(name,w.ref(empty,'Dictionary'))
    for key,label,unit,cumulative in [('weight','Weight','kg',False),('bodyFat','Body Fat Percentage','%',False),('kcal','Active Calories','kcal',True),('steps','Steps','count',True)]:
        w.add('comment',WFCommentActionText=f'{label}: '+('日ごとの集計値。生サンプルの合算はしません。' if cumulative else '対象日内の最新測定のみ。')+' 欠測を0で埋めません。')
        nothing=w.add('nothing');candidates=key+'Candidates';w.bind(candidates,w.ref(nothing,'Nothing'))
        kind={'Bounded':True,'Operator':4,'Property':'Type','Removable':False,'Values':{'Enumeration':{'Value':label,'WFSerializationType':'WFStringSubstitutableState'}}}
        dates={'Bounded':True,'Operator':1003,'Property':'Start Date','Removable':False,'Values':{'Date':w.att(w.var('WindowStart')),'AnotherDate':w.att(w.var('WindowEnd'))}}
        params={'WFContentItemFilter':{'Value':{'WFActionParameterFilterPrefix':1,'WFContentPredicateBoundedDate':False,'WFActionParameterFilterTemplates':[kind,dates]},'WFSerializationType':'WFContentPredicateTableTemplate'},'WFContentItemInputParameter':'Library','WFContentItemLimitEnabled':False,'WFContentItemSortProperty':'Start Date','WFContentItemSortOrder':'Latest First','WFHKSampleFilteringUnit':unit,'WFHKSampleFilteringFillMissing':False}
        if cumulative:params['WFHKSampleFilteringGroupBy']='Day'
        found=w.add('is.workflow.actions.filter.health.quantity',**params)
        have=w.condition(w.ref(found,'Health Samples'),100)
        loop=w.uid('repeat');w.add('repeat.each',GroupingIdentifier=loop,WFControlFlowMode=0,WFInput=w.att(w.ref(found,'Health Samples')))
        date=w.add('is.workflow.actions.properties.health.quantity',WFContentItemPropertyName='Start Date',WFInput=w.att(w.var('Repeat Item')))
        day=w.add('is.workflow.actions.format.date',WFDate=w.text(w.ref(date,'Start Date')),WFDateFormatStyle='Custom',WFDateFormat='Custom',WFDateFormatString='yyyy-MM-dd')
        same=w.condition(w.ref(day,'Formatted Date'),4,w.var('TargetDay'))
        unit_detail=w.add('is.workflow.actions.properties.health.quantity',WFContentItemPropertyName='Unit',WFInput=w.att(w.var('Repeat Item')))
        unit_matches=w.condition(w.ref(unit_detail,'Unit'),4,unit)
        value=w.add('is.workflow.actions.properties.health.quantity',WFContentItemPropertyName='Value',WFInput=w.att(w.var('Repeat Item')))
        number=w.add('number',WFNumberActionNumber=w.text(w.ref(value,'Value')))
        w.add('appendvariable',WFVariableName=candidates,WFInput=w.att(w.ref(number,'Number')))
        w.end(unit_matches);w.end(same);w.end(loop,'is.workflow.actions.repeat.each')
        any_candidates=w.condition(w.var(candidates),100)
        if cumulative:
            count=w.add('count',WFCountType='Items',Input=w.att(w.var(candidates)))
            one=w.condition(w.ref(count,'Count'),4,1)
        first=w.add('getitemfromlist',WFItemSpecifier='First Item',WFInput=w.att(w.var(candidates)))
        w.put('HealthValues',key,w.ref(first,'Item from List'));w.put('HealthUnits',key,unit)
        if cumulative:w.end(one)
        w.end(any_candidates);w.end(have)
    body=w.dictionary();w.bind('Payload',w.ref(body,'Dictionary'))
    for key,ref in [('type','health_bridge_upload'),('request_id',w.var('RequestID')),('pair_key',w.var('PairKey')),('date',w.var('TargetDay')),('issued_at',w.var('IssuedAt')),('values',w.var('HealthValues')),('units',w.var('HealthUnits'))]:w.put('Payload',key,ref)
    json_text=w.add('gettext',WFTextActionText=w.text(w.var('Payload')))
    request=w.add('downloadurl',WFURL=w.text(endpoint),WFHTTPMethod='POST',WFHTTPBodyType='File',WFRequestVariable=w.att(w.ref(json_text,'Text')),WFFormValues={'Value':{'WFDictionaryFieldValueItems':[]},'WFSerializationType':'WFDictionaryFieldValue'},WFHTTPHeaders={'Value':{'WFDictionaryFieldValueItems':[{'WFItemType':0,'WFKey':w.text('Content-Type'),'WFValue':w.text('application/json')}]},'WFSerializationType':'WFDictionaryFieldValue'})
    response=w.add('detect.dictionary',WFInput=w.att(w.ref(request,'Contents of URL')))
    ok=w.get(w.ref(response,'Dictionary'),'ok');ok_number=w.add('number',WFNumberActionNumber=w.text(w.ref(ok,'Dictionary Value')));success=w.condition(w.ref(ok_number,'Number'),4,1)
    w.add('notification',WFNotificationActionTitle=w.text('ヘルスケアの読み取りが完了しました'),WFNotificationActionBody=w.text('元のシステム手帳へ戻ってください。Safariが開いた場合も元の手帳を開くと取り込みを続けます。'),WFNotificationActionSound=False)
    w.add('openurl',WFInput=w.text(CALLBACK))
    w.add('conditional',GroupingIdentifier=success,WFControlFlowMode=1)
    w.stop('読み取り結果を送れませんでした。通信と連携キーを確認し、元の手帳からもう一度更新してください。')
    w.end(success)
    return {'WFWorkflowName':NAME,'WFWorkflowClientVersion':'2700.0.4','WFWorkflowMinimumClientVersion':900,'WFWorkflowMinimumClientVersionString':'900','WFWorkflowIcon':{'WFWorkflowIconGlyphNumber':61440,'WFWorkflowIconStartColor':4274264319},'WFWorkflowActions':w.actions,'WFWorkflowHasShortcutInputVariables':True,'WFWorkflowInputContentItemClasses':['WFStringContentItem'],'WFWorkflowOutputContentItemClasses':[],'WFWorkflowTypes':[],'WFWorkflowHasOutputFallback':False,'WFWorkflowIsDisabledOnLockScreen':True,'WFWorkflowImportQuestions':[{'ActionIndex':key_index,'Category':'Parameter','ParameterKey':'WFTextActionText','Text':'手帳の「ヘルスケア連携」で発行した連携キーを貼り付けてください。','DefaultValue':PLACEHOLDER}]}


def validate(workflow,endpoint):
    actions=workflow['WFWorkflowActions'];ids={a['WFWorkflowActionParameters']['UUID'] for a in actions}
    assert len(ids)==len(actions)
    def walk(x):
        if isinstance(x,dict):
            if x.get('Type')=='ActionOutput':assert x['OutputUUID'] in ids
            for v in x.values():walk(v)
        elif isinstance(x,list):
            for v in x:walk(v)
    walk(workflow)
    groups=[]
    for action in actions:
        ident=action['WFWorkflowActionIdentifier'];p=action['WFWorkflowActionParameters']
        assert ident.startswith('is.workflow.actions.')
        assert ident not in ['is.workflow.actions.health.quantity.log','is.workflow.actions.health.workout.log']
        if p.get('WFControlFlowMode')==0 and ident=='is.workflow.actions.conditional':
            if p['WFCondition'] in [4,5,8,9,99,999]:assert 'WFConditionalActionString' in p
            if p['WFCondition'] in [0,1,2,3,1003]:assert 'WFNumberValue' in p
            if p['WFCondition']==1003:assert 'WFAnotherNumber' in p
        if 'WFControlFlowMode' in p:
            if p['WFControlFlowMode']==0:groups.append((ident,p['GroupingIdentifier']))
            elif p['WFControlFlowMode']==2:assert groups.pop()==(ident,p['GroupingIdentifier'])
        if ident=='is.workflow.actions.filter.health.quantity':
            assert p['WFHKSampleFilteringFillMissing'] is False
            assert p['WFContentItemLimitEnabled'] is False
        if ident=='is.workflow.actions.setvalueforkey':
            value=p['WFDictionaryValue']
            # This action's Value is a text parameter even for one variable.
            # A standalone Attachment imports as an empty required value.
            assert value['WFSerializationType']=='WFTextTokenString'
            state=value['Value']
            if 'attachmentsByRange' in state:
                assert state['string']=='\ufffc'
                assert set(state['attachmentsByRange'])=={'{0, 1}'}
                assert state['attachmentsByRange']['{0, 1}']['Type'] in ['ActionOutput','Variable']
        if ident=='is.workflow.actions.downloadurl':
            assert p['WFURL']['Value']['string']==endpoint
            assert p['WFRequestVariable']['WFSerializationType']=='WFTextTokenAttachment'
            assert p['WFRequestVariable']['Value']['Type']=='ActionOutput'
        if ident=='is.workflow.actions.openurl':assert p['WFInput']['Value']['string']==CALLBACK
    assert not groups
    assert len([a for a in actions if a['WFWorkflowActionIdentifier']=='is.workflow.actions.filter.health.quantity'])==4
    encoded=plistlib.dumps(workflow)
    assert b'habit_day_upsert' not in encoded and b'Basal' not in encoded
    assert PLACEHOLDER.encode() in encoded
    return {'actions':len(actions),'health_queries':4,'contains_real_pair_key':False,'writes_health':False,'posts_existing_habits':False,'callback_contains_health_or_credentials':False,'dynamic_dictionary_values_use_single_token_strings':True,'ios_execution':'not_tested'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output-dir',type=Path,default=ROOT/'shortcuts/health-bridge');args=parser.parse_args()
    endpoint=re.search(r'export const GAS_URL\s*=\s*"([^"]+)"', (ROOT/'js/config.js').read_text()).group(1)
    workflow=build(endpoint);result=validate(workflow,endpoint);args.output_dir.mkdir(parents=True,exist_ok=True)
    (args.output_dir/'system-techo-health.unsigned.shortcut').write_bytes(plistlib.dumps(workflow,fmt=plistlib.FMT_BINARY,sort_keys=False))
    (args.output_dir/'system-techo-health.source.plist').write_bytes(plistlib.dumps(workflow,fmt=plistlib.FMT_XML,sort_keys=False))
    (args.output_dir/'structure-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
