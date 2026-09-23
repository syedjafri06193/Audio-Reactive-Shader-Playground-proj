/**
 * Mapping GLSL compiler errors back to the user's editor coordinates.
 *
 * The playground injects a prelude — `#version`, precision qualifiers,
 * uniform declarations, helper functions — so the compiler's line numbers
 * refer to the full source while the editor shows only the user's part. An
 * error on prelude-adjusted line 47 might be their line 12, and reporting
 * 47 makes the message worse than useless: it points at code the user
 * cannot see and did not write.
 *
 * The formats differ between drivers, which is the part that bites. A regex
 * tuned on ANGLE silently produces wrong line numbers on Mesa, and a wrong
 * line number is worse than none — the user goes and looks at the wrong
 * code.
 */

export type Severity = "error" | "warning";

export interface ShaderDiagnostic {
  severity: Severity;
  /** 1-based line in the *user's* source, or null if it could not be mapped. */
  line: number | null;
  /** 1-based column, when the driver reports one. */
  column: number | null;
  message: string;
  /** The compiler's original line, kept so the raw log stays available. */
  raw: string;
}

/**
 * The formats seen in the wild.
 *
 * The canonical shape from the GLSL ES spec is
 * `ERROR: <string-number>:<line>: <message>`, and ANGLE, Mesa and Apple all
 * follow it — but with enough variation in spacing, casing and the presence
 * of the string number that one pattern does not cover them.
 */
const PATTERNS: Array<{
  re: RegExp;
  /** Which capture groups hold what. */
  severity: number;
  line: number;
  column: number | null;
  message: number;
}> = [
  // ANGLE (Chrome/Edge on Windows) and most desktop drivers:
  //   ERROR: 0:47: 'foo' : undeclared identifier
  { re: /^\s*(ERROR|WARNING)\s*:\s*(\d+)\s*:\s*(\d+)\s*:\s*(.*)$/i, severity: 1, line: 3, column: 2, message: 4 },

  // Mesa (Linux) reports line:column and no string number:
  //   0:47(12): error: `foo' undeclared
  { re: /^\s*\d+\s*:\s*(\d+)\s*\(\s*(\d+)\s*\)\s*:\s*(error|warning)\s*:\s*(.*)$/i, severity: 3, line: 1, column: 2, message: 4 },

  // Apple's compiler occasionally omits the string number entirely:
  //   ERROR: 47: 'foo' : undeclared identifier
  { re: /^\s*(ERROR|WARNING)\s*:\s*(\d+)\s*:\s*(.*)$/i, severity: 1, line: 2, column: null, message: 3 },
];

/**
 * Parse a compiler log and shift line numbers back into the user's source.
 *
 * @param log `gl.getShaderInfoLog()` or `gl.getProgramInfoLog()`.
 * @param preludeLines how many lines were injected above the user's source.
 */
export function mapDiagnostics(log: string, preludeLines: number): ShaderDiagnostic[] {
  if (!log) return [];

  const out: ShaderDiagnostic[] = [];

  for (const raw of log.split("\n")) {
    const text = raw.replace(/\0/g, "").trim();
    if (!text) continue;

    let parsed: ShaderDiagnostic | null = null;

    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;

      const reported = Number.parseInt(m[p.line], 10);
      if (!Number.isFinite(reported)) continue;

      const mapped = reported - preludeLines;

      parsed = {
        severity: m[p.severity].toLowerCase() === "warning" ? "warning" : "error",
        // An error genuinely inside the prelude maps to a non-positive
        // number. That is a bug in the playground, not in the user's
        // shader, so it is reported as unmapped rather than clamped to
        // line 1 — which would send the user to inspect code that is fine.
        line: mapped >= 1 ? mapped : null,
        column: p.column !== null ? Number.parseInt(m[p.column], 10) : null,
        message: m[p.message].trim(),
        raw: text,
      };
      break;
    }

    // Unrecognised format. Keep the raw line rather than dropping it: a
    // diagnostic with no line number is far more useful than silence, and
    // silence is what a user sees when a driver the regexes do not know
    // about reports a real error.
    out.push(
      parsed ?? {
        severity: /warn/i.test(text) ? "warning" : "error",
        line: null,
        column: null,
        message: text,
        raw: text,
      },
    );
  }

  return out;
}

/** True when anything in the log is fatal. */
export function hasErrors(diagnostics: ShaderDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/**
 * A one-line summary for a status bar.
 *
 * Deliberately says "line unknown" rather than guessing. The whole reason
 * this module exists is that a confident wrong line number sends someone to
 * read the wrong code.
 */
export function summarize(diagnostics: ShaderDiagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return "compiled";

  const first = errors[0];
  const where = first.line !== null ? `line ${first.line}` : "line unknown";
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return `${where}: ${first.message}${more}`;
}
