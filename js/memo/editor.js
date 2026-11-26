// Plain-text memo editor. Styling lives on the real document, never a mirror layer.
import {
  EditorView, EditorState, Decoration, ViewPlugin, WidgetType, keymap,
  placeholder, history, historyKeymap, defaultKeymap, insertNewline,
  StateEffect, Prec,
} from "../../vendor/codemirror/codemirror.js";

const refreshDecorations = StateEffect.define();
const checkPrefix = text => /^[☐☑]/.test(text);
const prefixLength = text => checkPrefix(text) ? (text[1] === " " ? 2 : 1) : 0;

function toggleCheckAt(view, position) {
  if (!Number.isInteger(position) || position < 0 || position >= view.state.doc.length) return;
  const line = view.state.doc.lineAt(position);
  if (line.from !== position || !checkPrefix(line.text)) return;
  const next = line.text[0] === "☑" ? "☐" : "☑";
  view.dispatch({ changes: { from: position, to: position + 1, insert: next }, userEvent: "input.check" });
}

class CheckWidget extends WidgetType {
  constructor(checked, position) { super(); this.checked = checked; this.position = position; }
  eq(other) { return other.checked === this.checked && other.position === this.position; }
  setAttributes(button) {
    button.dataset.memoCheckbox = String(this.position);
    button.setAttribute("aria-checked", String(this.checked));
    button.setAttribute("aria-label", this.checked ? "チェックを外す" : "完了にする");
  }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "memo-editor-check-wrap";
    wrap.contentEditable = "false";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memo-editor-checkbox";
    button.setAttribute("role", "checkbox");
    this.setAttributes(button);
    // Only the control consumes a mouse press. Text selection/touch scrolling stay native.
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", event => {
      event.preventDefault();
      toggleCheckAt(view, Number(button.dataset.memoCheckbox));
    });
    wrap.append(button);
    return wrap;
  }
  updateDOM(wrap) {
    this.setAttributes(wrap.firstElementChild);
    return true;
  }
  ignoreEvent() { return true; }
}

function decorationsFor(view) {
  const marks = [], seen = new Set();
  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from);
    while (line.from <= range.to) {
      if (!seen.has(line.number) && checkPrefix(line.text)) {
        seen.add(line.number);
        marks.push(Decoration.replace({widget: new CheckWidget(line.text[0] === "☑", line.from)}).range(line.from, line.from + 1));
        const contentFrom = line.from + prefixLength(line.text);
        if (line.text[0] === "☑" && contentFrom < line.to) {
          marks.push(Decoration.mark({class: "memo-editor-done"}).range(contentFrom, line.to));
        }
      }
      if (line.number === view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(marks, true);
}

// Parse HTML only in an inert template; never mount pasted elements or their attributes.
function plainHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TR"]);
  const skip = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
  let out = "";
  const visit = node => {
    if (node.nodeType === 3) { out += node.nodeValue; return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (skip.has(node.nodeName)) return;
    if (node.nodeName === "BR") { out += "\n"; return; }
    const block = blocks.has(node.nodeName);
    if (block && out && !out.endsWith("\n")) out += "\n";
    for (const child of node.childNodes) visit(child);
    if (block && !out.endsWith("\n")) out += "\n";
  };
  visit(template.content);
  return out;
}

export function createMemoEditor(host, {
  text = "", onChange = () => {}, onFiles = () => {},
  onCompositionChange = () => {}, ruled = true,
} = {}) {
  let destroyed = false, compositionActive = false, compositionFrame = 0, ruledEnabled = !!ruled;
  let lastText = String(text), enterKeydownPending = false, enterPendingTimer = 0;
  const appleTouch = /iP(?:hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let initialTouch = null;
  const clearPendingEnter = () => {
    enterKeydownPending = false;
    clearTimeout(enterPendingTimer);
  };
  const checklistEnter = view => {
    if (compositionActive || view.composing) return false;
    const {from, to} = view.state.selection.main;
    if (from !== to) return false;
    const line = view.state.doc.lineAt(from), prefix = prefixLength(line.text);
    if (!prefix || from < line.from + prefix) return false;
    if (line.text.slice(prefix).length === 0) {
      view.dispatch({changes: {from: line.from, to: line.from + prefix, insert: ""}, userEvent: "input"});
    } else {
      view.dispatch(view.state.replaceSelection("\n☐ "), {scrollIntoView: true, userEvent: "input"});
    }
    return true;
  };
  const decorationPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = decorationsFor(view); }
    update(update) {
      // Keep composition DOM stable. Remap old marks until the native IME commits.
      if (compositionActive || update.view.composing) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      } else if (update.docChanged || update.viewportChanged || update.transactions.some(t => t.effects.some(e => e.is(refreshDecorations)))) {
        this.decorations = decorationsFor(update.view);
      }
    }
  }, {decorations: plugin => plugin.decorations});
  const events = EditorView.domEventHandlers({
    touchstart(event, view) {
      initialTouch = null;
      // iOS's default first tap can pan the page while opening the keyboard.
      // Only replace that first short tap. Active editing/selection stays native.
      if (!appleTouch || view.hasFocus || compositionActive || view.composing
          || event.touches.length !== 1
          || event.target.closest?.("button, a, input, select, textarea")
          || view.root.getSelection?.()?.isCollapsed === false) return false;
      const touch = event.touches[0];
      initialTouch = { id: touch.identifier, x: touch.clientX, y: touch.clientY,
        at: performance.now(), top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
      return false;
    },
    touchmove(event) {
      if (!initialTouch) return false;
      const touch = Array.from(event.touches).find(t => t.identifier === initialTouch.id);
      if (event.touches.length !== 1 || !touch
          || Math.hypot(touch.clientX - initialTouch.x, touch.clientY - initialTouch.y) > 8) initialTouch = null;
      return false;
    },
    touchcancel() { initialTouch = null; return false; },
    touchend(event, view) {
      const start = initialTouch;
      initialTouch = null;
      if (!start || !event.cancelable || event.touches.length
          || performance.now() - start.at > 350
          || compositionActive || view.composing
          || view.root.getSelection?.()?.isCollapsed === false
          || Math.abs(view.scrollDOM.scrollTop - start.top) > 2
          || Math.abs(view.scrollDOM.scrollLeft - start.left) > 2) return false;
      const touch = Array.from(event.changedTouches).find(t => t.identifier === start.id);
      if (!touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 8) return false;
      const position = view.posAtCoords({ x: touch.clientX, y: touch.clientY }, false);
      if (position == null) return false;
      event.preventDefault();
      // Use the actual document's coordinates; no mirror or fake caret is needed.
      // No scroll request and no text change: preserve the tapped line and body.
      focusEditor({ anchor: position });
      return true;
    },
    beforeinput(event, view) {
      if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return false;
      if (!event.cancelable || event.isComposing || compositionActive || view.composing) return false;
      // CodeMirror handles iOS's delayed Enter after a keydown. This fallback is
      // only for virtual keyboards that emit beforeinput without a key event.
      if (enterKeydownPending) return false;
      if (!checklistEnter(view)) return false;
      event.preventDefault();
      return true;
    },
    compositionstart() {
      compositionActive = true;
      cancelAnimationFrame(compositionFrame);
      onCompositionChange(true);
      return false;
    },
    compositionend(_event, view) {
      compositionActive = false;
      cancelAnimationFrame(compositionFrame);
      compositionFrame = requestAnimationFrame(() => {
        if (destroyed) return;
        view.dispatch({effects: refreshDecorations.of(null)});
        onCompositionChange(false);
      });
      return false;
    },
    paste(event, view) {
      const data = event.clipboardData;
      if (!data) return false;
      const files = Array.from(data.files || []);
      if (files.length) { event.preventDefault(); onFiles(files); return true; }
      let inserted;
      if (data.types.includes("text/plain")) inserted = data.getData("text/plain");
      else if (data.types.includes("text/html")) inserted = plainHTML(data.getData("text/html"));
      else return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(inserted), {scrollIntoView: true, userEvent: "input.paste"});
      return true;
    },
    dragover(event) {
      if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
      return false;
    },
    drop(event) {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return false;
      event.preventDefault(); onFiles(files); return true;
    },
  });
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: lastText,
      extensions: [
        EditorView.editorAttributes.of(() => ({class: ruledEnabled ? "memo-editor memo-editor-ruled" : "memo-editor"})),
        EditorView.contentAttributes.of({id: "d-text-input", role: "textbox", "aria-label": "メモ本文", "aria-multiline": "true", spellcheck: "false", autocapitalize: "sentences"}),
        EditorView.lineWrapping,
        placeholder("ここにメモ"),
        history(),
        Prec.high(events),
        keymap.of([
          {key: "Enter", run: view => {
            clearPendingEnter();
            if (compositionActive || view.composing) return false;
            return checklistEnter(view) || insertNewline(view);
          }},
          // Do not fall through to a second Enter command during IME commit.
          ...defaultKeymap.filter(binding => binding.key !== "Enter"),
          ...historyKeymap,
        ]),
        decorationPlugin,
        EditorView.updateListener.of(update => {
          if (!update.docChanged || destroyed) return;
          lastText = update.state.sliceDoc();
          onChange(lastText);
        }),
      ],
    }),
  });
  function focusEditor(selection = null) {
    if (appleTouch) {
      // CodeMirror's Safari >=26 fallback omits this native option. Its
      // synchronous scroll restore cannot stop the later keyboard viewport pan.
      // Set the real DOM caret first. iOS may focus implicitly while doing so;
      // the explicit preventScroll call must follow that selection update.
      view.dispatch({ selection: selection || view.state.selection, userEvent: "select.pointer" });
      view.contentDOM.focus({ preventScroll: true });
      view.dispatch({});
    } else {
      if (selection) view.dispatch({ selection, userEvent: "select.pointer" });
      view.focus();
    }
  }
  // Capture runs even when CodeMirror's iOS/Android handler defers keydown
  // before plugin event hooks run. Avoid processing that same Enter twice.
  const captureEnter = event => {
    if (event.target.closest?.(".memo-editor-checkbox") || event.isComposing || compositionActive) return;
    if (event.key !== "Enter" && event.keyCode !== 13) return;
    clearPendingEnter();
    enterKeydownPending = true;
    enterPendingTimer = setTimeout(clearPendingEnter, 500);
  };
  view.dom.addEventListener("keydown", captureEnter, true);
  return {
    getText: () => destroyed ? lastText : view.state.sliceDoc(),
    getSelection() {
      const {from, to, anchor, head} = view.state.selection.main;
      return {from, to, anchor, head};
    },
    toggleChecklist() {
      if (destroyed || compositionActive || view.composing) return;
      const doc = view.state.doc, {from, to} = view.state.selection.main;
      const first = doc.lineAt(from).number;
      let last = doc.lineAt(to).number;
      if (to > from && doc.line(last).from === to) last--;
      const lines = Array.from({length: last - first + 1}, (_, i) => doc.line(first + i));
      const remove = lines.every(line => checkPrefix(line.text));
      const changes = [];
      for (const line of lines) {
        const prefix = prefixLength(line.text);
        if (remove) changes.push({from: line.from, to: line.from + prefix, insert: ""});
        else if (!prefix) changes.push({from: line.from, insert: "☐ "});
      }
      if (changes.length) {
        // A caret exactly at an added prefix otherwise maps before the widget.
        // Put new typing in editable label text, including native Japanese IME.
        const afterPrefix = from === to && changes.some(change => change.from === from && change.insert === "☐ ");
        view.dispatch({ changes, ...(afterPrefix ? { selection: { anchor: from + 2 } } : {}), userEvent: "input.checklist" });
      }
      focusEditor();
    },
    focus({preventScroll = true} = {}) {
      if (destroyed) return;
      if (preventScroll) focusEditor();
      else view.contentDOM.focus();
    },
    setRuled(value) {
      if (destroyed || ruledEnabled === !!value) return;
      ruledEnabled = !!value;
      view.dispatch({effects: refreshDecorations.of(null)});
    },
    isFocused: () => !destroyed && view.hasFocus,
    isComposing: () => !destroyed && (compositionActive || view.composing),
    destroy() {
      if (destroyed) return;
      lastText = view.state.sliceDoc();
      destroyed = true; compositionActive = false; initialTouch = null;
      cancelAnimationFrame(compositionFrame);
      clearPendingEnter();
      view.dom.removeEventListener("keydown", captureEnter, true);
      view.destroy();
    },
  };
}
