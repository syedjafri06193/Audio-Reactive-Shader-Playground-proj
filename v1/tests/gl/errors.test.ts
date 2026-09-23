import { describe, expect, it } from "vitest";

import { hasErrors, mapDiagnostics, summarize } from "../../src/gl/errors.js";

/**
 * Real compiler output shapes.
 *
 * The design document is emphatic that these differ between drivers and
 * that a regex tuned on one silently fails on another. These are the three
 * families that matter, written out rather than described, because the
 * difference is entirely in the punctuation.
 */
const ANGLE = "ERROR: 0:47: 'foo' : undeclared identifier";
const ANGLE_WARNING = "WARNING: 0:12: 'bar' : unused variable";
const MESA = "0:47(12): error: `foo' undeclared";
const MESA_WARNING = "0:9(3): warning: unused variable `bar'";
const APPLE = "ERROR: 47: 'foo' : undeclared identifier";

const PRELUDE_LINES = 35;

describe("mapDiagnostics", () => {
  it("shifts ANGLE line numbers into the user's coordinates", () => {
    const [d] = mapDiagnostics(ANGLE, PRELUDE_LINES);
    expect(d.severity).toBe("error");
    expect(d.line).toBe(47 - PRELUDE_LINES);
    expect(d.message).toContain("undeclared identifier");
  });

  it("shifts Mesa line numbers, which use a different shape entirely", () => {
    const [d] = mapDiagnostics(MESA, PRELUDE_LINES);
    expect(d.severity).toBe("error");
    expect(d.line).toBe(47 - PRELUDE_LINES);
    expect(d.column).toBe(12);
    expect(d.message).toContain("undeclared");
  });

  it("shifts Apple's line numbers, which omit the string number", () => {
    const [d] = mapDiagnostics(APPLE, PRELUDE_LINES);
    expect(d.severity).toBe("error");
    expect(d.line).toBe(47 - PRELUDE_LINES);
  });

  it("gives the same answer for the same error across all three drivers", () => {
    // The property that matters. A user on Linux and a user on Windows
    // looking at the same broken shader should be pointed at the same line.
    const angle = mapDiagnostics(ANGLE, PRELUDE_LINES)[0];
    const mesa = mapDiagnostics(MESA, PRELUDE_LINES)[0];
    const apple = mapDiagnostics(APPLE, PRELUDE_LINES)[0];

    expect(angle.line).toBe(mesa.line);
    expect(mesa.line).toBe(apple.line);
  });

  it("tells warnings from errors on every driver", () => {
    expect(mapDiagnostics(ANGLE_WARNING, PRELUDE_LINES)[0].severity).toBe("warning");
    expect(mapDiagnostics(MESA_WARNING, PRELUDE_LINES)[0].severity).toBe("warning");
  });

  it("reports an error inside the prelude as unmapped rather than line 1", () => {
    // An error in the injected prelude is the playground's bug, not the
    // user's. Clamping it to line 1 would send them to inspect code that is
    // perfectly fine, which is exactly the confusion this module exists to
    // prevent.
    const [d] = mapDiagnostics("ERROR: 0:4: 'x' : syntax error", PRELUDE_LINES);
    expect(d.line).toBeNull();
    expect(d.message).toContain("syntax error");
  });

  it("keeps a line it cannot parse instead of dropping it", () => {
    // A driver nobody anticipated still reports real errors, and silence is
    // the worst possible response to one.
    const weird = "something went terribly wrong in the shader compiler";
    const [d] = mapDiagnostics(weird, PRELUDE_LINES);
    expect(d.line).toBeNull();
    expect(d.message).toBe(weird);
    expect(d.severity).toBe("error");
  });

  it("parses a multi-line log into one diagnostic per line", () => {
    const log = [ANGLE, ANGLE_WARNING, "ERROR: 0:51: 'baz' : no matching overloaded function"].join(
      "\n",
    );
    const diagnostics = mapDiagnostics(log, PRELUDE_LINES);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map((d) => d.severity)).toEqual(["error", "warning", "error"]);
  });

  it("ignores blank lines and the trailing NUL some drivers emit", () => {
    const log = `${ANGLE}\n\n\u0000\n`;
    expect(mapDiagnostics(log, PRELUDE_LINES)).toHaveLength(1);
  });

  it("returns nothing for an empty log", () => {
    expect(mapDiagnostics("", PRELUDE_LINES)).toEqual([]);
    expect(mapDiagnostics("\n\n", PRELUDE_LINES)).toEqual([]);
  });

  it("handles a zero-line prelude, for a raw compile", () => {
    const [d] = mapDiagnostics(ANGLE, 0);
    expect(d.line).toBe(47);
  });

  it("does not mistake the string number for the line number", () => {
    // The classic off-by-one-group bug. In "ERROR: 0:47:", the 0 is the
    // shader string index and the 47 is the line — reading the first number
    // gives every error the same line.
    const first = mapDiagnostics("ERROR: 0:47: a", 0)[0];
    const second = mapDiagnostics("ERROR: 0:12: b", 0)[0];
    expect(first.line).toBe(47);
    expect(second.line).toBe(12);
  });

  it("tolerates a non-zero string number", () => {
    // Multi-string compiles report the string they came from.
    const [d] = mapDiagnostics("ERROR: 2:47: 'foo' : undeclared identifier", 0);
    expect(d.line).toBe(47);
  });

  it("tolerates loose spacing", () => {
    const [d] = mapDiagnostics("ERROR:0:47:'foo' : undeclared identifier", 0);
    expect(d.line).toBe(47);
  });
});

describe("hasErrors", () => {
  it("is true only when something is fatal", () => {
    expect(hasErrors(mapDiagnostics(ANGLE_WARNING, 0))).toBe(false);
    expect(hasErrors(mapDiagnostics(ANGLE, 0))).toBe(true);
    expect(hasErrors([])).toBe(false);
  });
});

describe("summarize", () => {
  it("names the line when it knows it", () => {
    expect(summarize(mapDiagnostics(ANGLE, PRELUDE_LINES))).toContain(`line ${47 - PRELUDE_LINES}`);
  });

  it("says the line is unknown rather than guessing one", () => {
    const s = summarize(mapDiagnostics("mystery driver output", 0));
    expect(s).toContain("line unknown");
  });

  it("counts the errors it is not showing", () => {
    const log = [ANGLE, "ERROR: 0:51: another", "ERROR: 0:52: and another"].join("\n");
    expect(summarize(mapDiagnostics(log, PRELUDE_LINES))).toContain("+2 more");
  });

  it("says so when there is nothing wrong", () => {
    expect(summarize([])).toBe("compiled");
    expect(summarize(mapDiagnostics(ANGLE_WARNING, 0))).toBe("compiled");
  });
});
