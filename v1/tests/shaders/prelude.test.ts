import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AUDIO_UNIFORMS, RESERVED_UNIFORMS, SYSTEM_UNIFORMS } from "../../src/shaders/index.js";

/**
 * Read prelude.glsl from disk rather than through Vite's `?raw`, so this
 * suite runs under plain vitest without the bundler in the loop.
 */
const PRELUDE = readFileSync(
  fileURLToPath(new URL("../../shaders/prelude.glsl", import.meta.url)),
  "utf8",
);

const SPECTRUM_BANDS = 64;

function buildPrelude(bands = SPECTRUM_BANDS): string {
  return PRELUDE.replace(/SPECTRUM_BANDS/g, String(bands));
}

function assemble(user: string): { source: string; preludeLines: number } {
  const prelude = buildPrelude();
  return { source: `${prelude}\n${user}`, preludeLines: prelude.split("\n").length };
}

describe("prelude line mapping", () => {
  it("maps a user line back to itself through the offset", () => {
    // The property every error message depends on. If this drifts, every
    // diagnostic in the application points a few lines off, and the
    // symptom looks like a driver quirk rather than a bug here.
    const user = ["// line 1", "// line 2", "void main() {", "  BROKEN", "}"].join("\n");
    const { source, preludeLines } = assemble(user);

    const lines = source.split("\n");
    // Find where "BROKEN" actually landed in the assembled source, 1-based.
    const absolute = lines.findIndex((l) => l.includes("BROKEN")) + 1;

    // That is what the compiler would report; mapping it must give 4.
    expect(absolute - preludeLines).toBe(4);
  });

  it("holds for the first and last line of the user's source", () => {
    const user = ["FIRST", "middle", "LAST"].join("\n");
    const { source, preludeLines } = assemble(user);
    const lines = source.split("\n");

    expect(lines.findIndex((l) => l.includes("FIRST")) + 1 - preludeLines).toBe(1);
    expect(lines.findIndex((l) => l.includes("LAST")) + 1 - preludeLines).toBe(3);
  });

  it("counts the prelude rather than hard-coding a number", () => {
    // Adding a uniform must change the offset automatically. A constant
    // written down somewhere is the failure this test exists to prevent.
    const original = buildPrelude().split("\n").length;
    const extended = `${buildPrelude()}\nuniform float uExtra;`;
    expect(extended.split("\n").length).toBe(original + 1);
  });

  it("starts with the version directive, which must be the first line", () => {
    // GLSL requires #version to precede everything, including comments.
    expect(buildPrelude().split("\n")[0].trim()).toBe("#version 300 es");
  });

  it("substitutes the band count, because GLSL needs a constant array size", () => {
    const p = buildPrelude(32);
    expect(p).toContain("uniform float uSpectrum[32]");
    expect(p).not.toContain("SPECTRUM_BANDS");
  });

  it("declares every uniform the renderer uploads", () => {
    const prelude = buildPrelude();
    for (const name of [...AUDIO_UNIFORMS, ...SYSTEM_UNIFORMS]) {
      expect(prelude, name).toMatch(new RegExp(`uniform[^;]*\\b${name}\\b`));
    }
  });

  it("reserves exactly the names it declares", () => {
    expect(RESERVED_UNIFORMS.has("uBass")).toBe(true);
    expect(RESERVED_UNIFORMS.has("iTime")).toBe(true);
    expect(RESERVED_UNIFORMS.has("uWarp")).toBe(false);
  });

  it("exposes the onset as a float, not a bool", () => {
    // A boolean would be true for one frame — 16 ms, below the threshold
    // at which anyone perceives it — so every shader author would write
    // their own decay and most would write a frame-rate dependent one.
    expect(buildPrelude()).toMatch(/uniform\s+float\s+uOnset/);
    expect(buildPrelude()).not.toMatch(/uniform\s+bool\s+uOnset/);
  });

  it("declares an out variable, as GLSL ES 3.00 requires", () => {
    // gl_FragColor does not exist in 3.00; a shader pasted from a 1.00
    // tutorial fails here and the error should be about that, not about a
    // missing output.
    expect(buildPrelude()).toMatch(/out\s+vec4\s+fragColor/);
  });
});
