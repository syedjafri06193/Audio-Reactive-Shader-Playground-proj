/**
 * The shader editor.
 *
 * CodeMirror 6 with GLSL-ish highlighting and a diagnostics gutter fed from
 * the compiler. The interesting part is the debounce policy, which is not
 * the usual "wait until they stop typing".
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine, gutter, GutterMarker } from "@codemirror/view";
import { EditorState, StateEffect, StateField, RangeSet, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";

import type { ShaderDiagnostic } from "../gl/errors.ts";

/**
 * How long to wait after a keystroke before recompiling.
 *
 * 300 ms, and the reasoning is not the usual one. The constraint is not CPU
 * — a parallel compile costs almost nothing on the main thread — it is that
 * recompiling mid-identifier produces a stream of "undeclared identifier"
 * errors for names the user is halfway through typing. That fills the
 * gutter with red while someone is simply writing code, which trains them
 * to ignore it.
 *
 * Shorter feels more live but makes the diagnostics useless; longer feels
 * laggy. 300 ms is roughly the gap between words rather than between
 * keystrokes.
 */
export const COMPILE_DEBOUNCE_MS = 300;

const setDiagnostics = StateEffect.define<ShaderDiagnostic[]>();

class DiagnosticMarker extends GutterMarker {
  constructor(private readonly severity: "error" | "warning") {
    super();
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = `cm-diagnostic-marker cm-diagnostic-${this.severity}`;
    el.textContent = this.severity === "error" ? "●" : "▲";
    return el;
  }
}

const ERROR_MARKER = new DiagnosticMarker("error");
const WARNING_MARKER = new DiagnosticMarker("warning");

const diagnosticsField = StateField.define<ShaderDiagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiagnostics)) return e.value;
    return value;
  },
});

function diagnosticGutter(): Extension {
  return gutter({
    class: "cm-diagnostic-gutter",
    markers(view) {
      const diags = view.state.field(diagnosticsField, false) ?? [];
      const doc = view.state.doc;
      const ranges: Array<{ from: number; value: GutterMarker }> = [];

      for (const d of diags) {
        // A diagnostic with no line number cannot be placed. It is shown in
        // the status bar instead — dropping it entirely is how a user on an
        // unrecognised driver sees silence in place of a real error.
        if (d.line === null) continue;
        // Clamp: the compiler can report a line past the end of the
        // document when the error is at EOF.
        const line = Math.min(Math.max(1, d.line), doc.lines);
        ranges.push({ from: doc.line(line).from, value: d.severity === "error" ? ERROR_MARKER : WARNING_MARKER });
      }

      ranges.sort((a, b) => a.from - b.from);
      return RangeSet.of(
        ranges.map((r) => r.value.range(r.from)),
        true,
      );
    },
  });
}

export interface EditorOptions {
  parent: HTMLElement;
  initial: string;
  /** Called after the debounce, with the current source. */
  onCompile: (source: string) => void;
  /** Called on every change, for the "unsaved" indicator. */
  onChange?: (source: string) => void;
}

export class ShaderEditor {
  readonly view: EditorView;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: EditorOptions) {
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.initial,
        extensions: [
          lineNumbers(),
          diagnosticGutter(),
          diagnosticsField,
          history(),
          bracketMatching(),
          indentOnInput(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          keymap.of([
            // Explicit recompile, for when someone wants it now rather
            // than in 300 ms. Every live-coding tool has this and people
            // reach for it constantly.
            {
              key: "Mod-Enter",
              run: () => {
                this.compileNow();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const source = u.state.doc.toString();
            options.onChange?.(source);
            this.scheduleCompile();
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
            ".cm-diagnostic-gutter": { width: "14px" },
            ".cm-diagnostic-error": { color: "#ff5f56" },
            ".cm-diagnostic-warning": { color: "#ffbd2e" },
          }),
        ],
      }),
    });
  }

  private scheduleCompile(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.compileNow(), COMPILE_DEBOUNCE_MS);
  }

  compileNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.options.onCompile(this.source);
  }

  get source(): string {
    return this.view.state.doc.toString();
  }

  setSource(source: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: source },
    });
  }

  showDiagnostics(diagnostics: ShaderDiagnostic[]): void {
    this.view.dispatch({ effects: setDiagnostics.of(diagnostics) });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.view.destroy();
  }
}
