// メモ本文と既存の添付トークンの相互変換。保存形式を変更しない。
const ATT_RE = /^\[\[att:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]\]\s*$/;

// 本文を「文字」と「添付」に分ける（添付は本文の末尾に1行ずつ記録している）
export function splitBody(body) {
  const lines = String(body || "").split(/\r?\n/);
  const atts = [];
  const text = [];
  for (const ln of lines) {
    const m = ln.match(ATT_RE);
    if (m) atts.push({ id: m[1], name: m[2], mime: m[3] });
    else text.push(ln);
  }
  return { text: text.join("\n").replace(/\s+$/, ""), atts };
}

export function joinBody(text, atts) {
  const tokens = atts.map((a) => `[[att:${a.id}|${a.name.replace(/[|\]\n]/g, "_")}|${a.mime}]]`);
  return [text.replace(/\s+$/, ""), ...tokens].filter((x, i) => i === 0 || x).join("\n");
}
