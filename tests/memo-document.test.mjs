import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoDocument } from '../js/memo/document.js';

const a = Object.freeze({ id: 'old-a', name: '日本語.pdf', mime: 'application/pdf' });
const b = Object.freeze({ id: 'old-b', name: '写真.jpg', mime: 'image/jpeg' });
const token = x => `[[att:${x.id}|${x.name}|${x.mime}]]`;
const parse = body => createMemoDocument(body);
function sameContent(serialized, text, atts) {
  const actual = parse(serialized);
  assert.equal(actual.text, text);
  assert.deepEqual(actual.atts, atts);
}

test('opening or changing only the title never rewrites original body bytes', () => {
  for (const raw of ['', '\n', '\n\n', '末尾  \t\n\n', '先頭\r\n末尾\r\n', '混在\r\n次\n最終\r', token(a), token(a) + '\r\n', '\n' + token(a) + ' \t\r\n次\n\n']) {
    const doc = parse(raw);
    assert.equal(doc.serialize(doc.text, doc.atts), raw);
  }
  assert.equal(createMemoDocument().text, '');
  assert.equal(createMemoDocument(null).serialize('', []), '');
});

test('display normalizes line endings without trimming whitespace, empty lines or Unicode', () => {
  const raw = '\r\n☐ 日本語 👩🏽‍💻\r\n☑ 完了\r\n' + token(a) + '\r\n末尾 \t\r\n\r\n';
  const doc = parse(raw);
  assert.equal(doc.text, '\n☐ 日本語 👩🏽‍💻\n☑ 完了\n末尾 \t\n\n');
  assert.deepEqual(doc.atts, [a]);
  assert.equal(doc.serialize(doc.text, doc.atts), raw);
});

test('inline, incomplete and unknown tokens remain opaque editable text', () => {
  const raw = '文中 ' + token(a) + '\n[[att:未完成]]\n[[future:保持|v1]]\n [[att:a|b|c]]\n☑買い物';
  const doc = parse(raw);
  assert.equal(doc.text, raw);
  assert.deepEqual(doc.atts, []);
  sameContent(doc.serialize(raw + '\n追記  ', []), raw + '\n追記  ', []);
});

test('editing text keeps the exact attachment token line and its interior position', () => {
  const raw = '前文\r\n' + token(a) + ' \t\r\n後文 \r\n\r\n';
  const doc = parse(raw);
  const text = doc.text.replace('前文', '前文に追記');
  const body = doc.serialize(text, doc.atts);
  assert.equal(body, '前文に追記\n' + token(a) + ' \t\n後文 \n\n');
  sameContent(body, text, [a]);
});

test('tail attachments stay after newly appended text and retain duplicate IDs', () => {
  const second = { ...a, name: '同じIDの別名.pdf' };
  const doc = parse('本文\n' + token(a) + '\n' + token(second));
  const text = doc.text + '\n新しい行\n';
  const body = doc.serialize(text, doc.atts);
  assert.equal(body, '本文\n新しい行\n\n' + token(a) + '\n' + token(second));
  sameContent(body, text, [a, second]);
});

test('line insertions preserve attachments next to an unchanged suffix when possible', () => {
  const doc = parse('先頭\n' + token(a) + '\n末尾');
  const body = doc.serialize('先頭\n追加\n末尾', doc.atts);
  assert.equal(body, '先頭\n追加\n' + token(a) + '\n末尾');
  sameContent(body, '先頭\n追加\n末尾', [a]);
});

test('attachment additions, removals and ordering keep the requested text and metadata', () => {
  const doc = parse('本文 \n\n' + token(a) + ' \t\n' + token(b));
  const added = { id: 'new', name: '新規.txt', mime: 'text/plain' };
  for (const atts of [[a, b, added], [b], [b, a], []]) {
    const body = doc.serialize(doc.text, atts);
    sameContent(body, doc.text, atts);
    if (atts.includes(a)) assert(body.includes(token(a) + ' \t'), 'reuses original token spelling and whitespace');
  }
});

test('attachments-only and entirely cleared text serialize without introducing text', () => {
  const doc = parse(token(a) + '\r\n' + token(b));
  sameContent(doc.serialize('新しい本文\n\n', doc.atts), '新しい本文\n\n', [a, b]);
  sameContent(doc.serialize('', [b]), '', [b]);
  sameContent(doc.serialize('', []), '', []);
  const textOnly = parse('本文\n\n');
  sameContent(textOnly.serialize('', [a]), '', [a]);
});

test('caller mutations cannot silently change the original body snapshot', () => {
  const raw = '本文\n' + token(a);
  const doc = parse(raw);
  doc.atts[0].name = '変更.pdf';
  const body = doc.serialize(doc.text, doc.atts);
  sameContent(body, doc.text, [{ ...a, name: '変更.pdf' }]);
  assert.equal(doc.serialize('本文', [a]), raw);
});

test('unrepresentable new attachment metadata fails before returning damaged data', () => {
  const doc = parse('本文');
  for (const changed of [{ ...a, name: '縦|棒.pdf' }, { ...a, id: 'id]' }, { ...a, mime: 'text/plain\n次' }, { ...a, name: '改\r行.pdf' }]) {
    assert.throws(() => doc.serialize(doc.text, [changed]), /添付/);
  }
  assert.throws(() => doc.serialize(doc.text, null), /添付/);
  assert.throws(() => doc.serialize(null, []), /本文/);
});

test('reserved standalone attachment lines cannot be silently reclassified from editor text', () => {
  const doc = parse('元の本文');
  assert.throws(() => doc.serialize('通常の本文\n' + token(a), []), /添付/);
  assert.equal(doc.serialize(doc.text, doc.atts), '元の本文');
});
