"use client";

import { useEffect, useRef } from "react";

interface Props {
  /** The document the editor opens with. Later changes come from typing. */
  value: string;
  /** The server's language name, as the source view names it. */
  language: string;
  wrap: boolean;
  isDark: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
}

type Modules = {
  state: typeof import("@codemirror/state");
  view: typeof import("@codemirror/view");
  commands: typeof import("@codemirror/commands");
  language: typeof import("@codemirror/language");
  search: typeof import("@codemirror/search");
  highlight: typeof import("@lezer/highlight");
  javascript: typeof import("@codemirror/lang-javascript");
  json: typeof import("@codemirror/lang-json");
  markdown: typeof import("@codemirror/lang-markdown");
  python: typeof import("@codemirror/lang-python");
  html: typeof import("@codemirror/lang-html");
  css: typeof import("@codemirror/lang-css");
};

type EditorViewInstance = InstanceType<Modules["view"]["EditorView"]>;
type CompartmentInstance = InstanceType<Modules["state"]["Compartment"]>;

// Loaded on the first edit, so a file that is only ever read never pays for
// the editor. Promise.all keeps each grammar in a chunk of its own.
let modulesPromise: Promise<Modules> | null = null;

function loadModules(): Promise<Modules> {
  modulesPromise ??= Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
    import("@codemirror/search"),
    import("@lezer/highlight"),
    import("@codemirror/lang-javascript"),
    import("@codemirror/lang-json"),
    import("@codemirror/lang-markdown"),
    import("@codemirror/lang-python"),
    import("@codemirror/lang-html"),
    import("@codemirror/lang-css"),
  ]).then(([
    state, view, commands, language, search, highlight, javascript, json, markdown, python, html, css,
  ]) => ({ state, view, commands, language, search, highlight, javascript, json, markdown, python, html, css }));
  return modulesPromise;
}

/** The grammar for the language names `getLanguage()` in the file route emits. */
function grammarFor({ javascript, json, markdown, python, html, css }: Modules, language: string) {
  switch (language) {
    case "typescript": return javascript.javascript({ typescript: true });
    case "tsx": return javascript.javascript({ typescript: true, jsx: true });
    case "jsx": return javascript.javascript({ jsx: true });
    case "javascript": return javascript.javascript();
    case "json": return json.json();
    case "markdown": return markdown.markdown();
    case "python": return python.python();
    case "html": return html.html();
    case "css": return css.css();
    // Every other name the viewer highlights with Prism edits as plain text.
    default: return [];
  }
}

const DARK_PALETTE = {
  keyword: "#c678dd", string: "#98c379", number: "#d19a66", comment: "#7f848e",
  func: "#61afef", type: "#e5c07b", prop: "#e06c75", operator: "#56b6c2",
};

const LIGHT_PALETTE = {
  keyword: "#a626a4", string: "#50a14f", number: "#986801", comment: "#9d9d9f",
  func: "#4078f2", type: "#c18401", prop: "#e45649", operator: "#0184bc",
};

function highlightStyle(modules: Modules, isDark: boolean) {
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  const tags = modules.highlight.tags;
  return modules.language.syntaxHighlighting(
    modules.language.HighlightStyle.define([
      { tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword], color: palette.keyword },
      { tag: [tags.string, tags.special(tags.string), tags.regexp], color: palette.string },
      { tag: [tags.number, tags.bool, tags.null, tags.atom], color: palette.number },
      { tag: [tags.comment, tags.lineComment, tags.blockComment], color: palette.comment, fontStyle: "italic" },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: palette.func },
      { tag: [tags.typeName, tags.className, tags.namespace], color: palette.type },
      { tag: [tags.propertyName, tags.attributeName, tags.tagName, tags.heading], color: palette.prop },
      { tag: [tags.operator, tags.punctuation, tags.bracket], color: palette.operator },
      { tag: [tags.link, tags.url], color: palette.func, textDecoration: "underline" },
      { tag: tags.emphasis, fontStyle: "italic" },
      { tag: tags.strong, fontWeight: "600" },
    ]),
  );
}

function editorTheme(modules: Modules, isDark: boolean) {
  return modules.view.EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--bg)",
      color: "var(--text)",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontWeight: "var(--font-mono-weight)",
      lineHeight: "1.6",
      overflow: "auto",
    },
    ".cm-content": { caretColor: "var(--text)", padding: "8px 0" },
    ".cm-line": { padding: "0 12px" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text-dim)",
      border: "none",
      borderRight: "1px solid var(--border)",
      fontSize: "11px",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px", minWidth: "40px" },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--text-muted)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--bg-selected)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
    ".cm-selectionMatch": { backgroundColor: "var(--bg-selected)" },
    ".cm-searchMatch": { backgroundColor: "var(--bg-selected)", outline: "1px solid var(--border)" },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--bg-selected)",
      outline: "1px solid var(--accent)",
    },
    ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--text)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
    ".cm-textfield": {
      backgroundColor: "var(--bg)",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      padding: "2px 6px",
      fontSize: "12px",
    },
    ".cm-button": {
      backgroundColor: "var(--bg)",
      backgroundImage: "none",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      fontSize: "12px",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-panel)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
  }, { dark: isDark });
}

function appearanceExtensions(modules: Modules, isDark: boolean) {
  return [editorTheme(modules, isDark), highlightStyle(modules, isDark)];
}

/**
 * The viewer's editor. CodeMirror is created once and owns the document from
 * then on: a caller replacing the content (a reload after a conflict) changes
 * the component's `key`, so what is on screen is always what the editor holds.
 * Wrap and theme are compartments, so toggling them keeps the document.
 */
export function CodeMirrorEditor({ value, language, wrap, isDark, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorViewInstance | null>(null);
  const modulesRef = useRef<Modules | null>(null);
  const wrapCompartmentRef = useRef<CompartmentInstance | null>(null);
  const appearanceCompartmentRef = useRef<CompartmentInstance | null>(null);
  const callbacksRef = useRef({ onChange, onSave });
  callbacksRef.current = { onChange, onSave };

  useEffect(() => {
    let disposed = false;
    let view: EditorViewInstance | null = null;

    void loadModules().then((modules) => {
      if (disposed || !hostRef.current) return;
      const { EditorState, Compartment } = modules.state;
      const {
        EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
        drawSelection, dropCursor, rectangularSelection,
      } = modules.view;
      const { defaultKeymap, history, historyKeymap } = modules.commands;
      const { indentOnInput, bracketMatching, indentUnit } = modules.language;
      const { searchKeymap, highlightSelectionMatches } = modules.search;

      const wrapCompartment = new Compartment();
      const appearanceCompartment = new Compartment();
      wrapCompartmentRef.current = wrapCompartment;
      appearanceCompartmentRef.current = appearanceCompartment;

      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: value,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            history(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            indentOnInput(),
            indentUnit.of("  "),
            bracketMatching(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            keymap.of([{
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                callbacksRef.current.onSave();
                return true;
              },
            }]),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
            appearanceCompartment.of(appearanceExtensions(modules, isDark)),
            grammarFor(modules, language),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) callbacksRef.current.onChange(update.state.doc.toString());
            }),
          ],
        }),
      });

      modulesRef.current = modules;
      viewRef.current = view;
      view.focus();
    });

    return () => {
      disposed = true;
      viewRef.current = null;
      modulesRef.current = null;
      wrapCompartmentRef.current = null;
      appearanceCompartmentRef.current = null;
      view?.destroy();
    };
    // The document is opened once; `key` is how a caller replaces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = wrapCompartmentRef.current;
    const modules = modulesRef.current;
    if (!view || !compartment || !modules) return;
    view.dispatch({
      effects: compartment.reconfigure(wrap ? modules.view.EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = appearanceCompartmentRef.current;
    const modules = modulesRef.current;
    if (!view || !compartment || !modules) return;
    view.dispatch({ effects: compartment.reconfigure(appearanceExtensions(modules, isDark)) });
  }, [isDark]);

  return <div ref={hostRef} className="file-viewer-editor" style={{ height: "100%", overflow: "hidden" }} />;
}
