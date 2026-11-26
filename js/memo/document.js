// Lossless editor adapter for the existing plain-text memo body format.
// Loading never writes or migrates a record. Only explicit edits use LF separators.
const ATT_LINE = /^\[\[att:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]\]\s*$/;
const metadata = a => ({ id: a.id, name: a.name, mime: a.mime });
const sameAttachment = (a, b) => a?.id === b?.id && a?.name === b?.name && a?.mime === b?.mime;
const sameAttachments = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => sameAttachment(x, b[i]));
const toLF = text => text.replace(/\r\n|\r/g, '\n');

function decodeBody(raw) {
  const textLines = [], tokens = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    const match = line.match(ATT_LINE);
    if (match) {
      tokens.push({
        rawLine: line,
        beforeLine: textLines.length,
        att: { id: match[1], name: match[2], mime: match[3] },
      });
    } else {
      textLines.push(line);
    }
  }
  return { textLines, tokens, text: textLines.join('\n'), atts: tokens.map(t => metadata(t.att)) };
}

function assertAttachments(atts) {
  if (!Array.isArray(atts)) throw new Error('添付の一覧を保持できないため保存しません。');
  for (const a of atts) {
    if (!a || typeof a.id !== 'string' || !a.id || /[|\]\r\n]/.test(a.id)
        || typeof a.name !== 'string' || /[|\]\r\n]/.test(a.name)
        || typeof a.mime !== 'string' || /[\]\r\n]/.test(a.mime)) {
      throw new Error('添付の情報を元の形式で保持できないため保存しません。');
    }
  }
}

function boundaryMapper(original, nextLines) {
  const old = original.textLines;
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < nextLines.length && old[prefix] === nextLines[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < nextLines.length - prefix
         && old[old.length - suffix - 1] === nextLines[nextLines.length - suffix - 1]) suffix++;
  return boundary => {
    // A former attachment-only or trailing block stays after newly written text.
    if (!original.text || boundary >= old.length) return nextLines.length;
    if (boundary === 0) return 0;
    // Prefer following the unchanged next line at an insertion boundary.
    if (suffix && boundary >= old.length - suffix) return nextLines.length - (old.length - boundary);
    if (boundary <= prefix) return boundary;
    // Interior locations in a wholly edited region have no exact text anchor.
    return Math.max(prefix, Math.min(nextLines.length - suffix, boundary));
  };
}

function insertOriginalTokens(original, textLines) {
  const position = boundaryMapper(original, textLines), at = new Map();
  for (const token of original.tokens) {
    const index = Math.max(0, Math.min(textLines.length, position(token.beforeLine)));
    if (!at.has(index)) at.set(index, []);
    at.get(index).push(token.rawLine);
  }
  const lines = [];
  for (let i = 0; i <= textLines.length; i++) {
    lines.push(...(at.get(i) || []));
    if (i < textLines.length) lines.push(textLines[i]);
  }
  return lines.join('\n');
}

function appendRequestedTokens(original, textLines, atts) {
  const unused = original.tokens.slice();
  const tokens = atts.map(a => {
    const index = unused.findIndex(t => sameAttachment(t.att, a));
    if (index >= 0) return unused.splice(index, 1)[0].rawLine;
    return `[[att:${a.id}|${a.name}|${a.mime}]]`;
  });
  // The empty lines in textLines are real document content, not padding to trim.
  return [...textLines, ...tokens].join('\n');
}

export function createMemoDocument(rawBody = '') {
  const raw = rawBody == null ? '' : rawBody;
  if (typeof raw !== 'string') throw new Error('本文を文字として読み取れません。');
  const original = decodeBody(raw);
  return {
    text: original.text,
    // The caller can edit its list without mutating the private original snapshot.
    atts: original.atts.map(metadata),
    serialize(text = original.text, atts = original.atts) {
      if (typeof text !== 'string') throw new Error('本文を文字として保持できないため保存しません。');
      const normalized = toLF(text);
      if (normalized === original.text && sameAttachments(atts, original.atts)) return raw;
      assertAttachments(atts);
      // The legacy format reserves these entire lines for attachments. Reject an
      // ambiguous edit rather than silently turn the user's typed text into one.
      if (decodeBody(normalized).atts.length) {
        throw new Error('本文の添付形式の行を文字として保持できないため保存しません。');
      }
      const lines = normalized === '' ? [] : normalized.split('\n');
      const body = sameAttachments(atts, original.atts)
        ? insertOriginalTokens(original, lines)
        : appendRequestedTokens(original, lines, atts);
      const check = decodeBody(body);
      if (check.text !== normalized || !sameAttachments(check.atts, atts)) {
        throw new Error('本文または添付を完全に保持できないため保存しません。');
      }
      return body;
    },
  };
}
