import { describe, expect, it } from "vitest";

import { CROSSFADE_SCALE, Morph, coercePreset, type Preset } from "../../src/presets/morph.js";
import { ParamSchema, type ParamDecl } from "../../src/params/schema.js";
import type { RGB } from "../../src/params/interpolate.js";

const DECLS: ParamDecl[] = [
  { name: "uWarp", label: "Warp", type: "float", min: 0, max: 1, default: 0 },
  { name: "uAngle", label: "Angle", type: "angle", min: 0, max: 360, default: 0 },
  { name: "uIters", label: "Iterations", type: "int", min: 1, max: 32, default: 4 },
  { name: "uTint", label: "Tint", type: "color", default: { r: 0, g: 0, b: 0 } },
];

const schema = new ParamSchema(DECLS);

function preset(id: string, shader: string, values: Record<string, unknown>): Preset {
  return { id, name: id, shader, values: schema.coerce(values).values };
}

const A = preset("a", "SHADER_ONE", { uWarp: 0, uAngle: 350, uIters: 4, uTint: { r: 1, g: 0, b: 0 } });
const B = preset("b", "SHADER_ONE", { uWarp: 1, uAngle: 10, uIters: 16, uTint: { r: 0, g: 1, b: 0 } });
const C = preset("c", "SHADER_TWO", { uWarp: 0.5, uAngle: 0, uIters: 8, uTint: { r: 0, g: 0, b: 1 } });

describe("Morph kind", () => {
  it("interpolates parameters when the shader is unchanged", () => {
    expect(new Morph(schema, A, B).kind).toBe("parameters");
  });

  it("crossfades when the shader differs", () => {
    // There is no interpolation between two GLSL programs. Rendering both
    // and crossfading the images is the only honest answer.
    expect(new Morph(schema, A, C).kind).toBe("crossfade");
  });

  it("compares source text, not preset id", () => {
    // Two presets commonly share a shader — a colour variant of the same
    // patch — and interpolating those is both cheaper and better-looking.
    const variant = preset("a2", "SHADER_ONE", { uWarp: 0.3 });
    expect(new Morph(schema, A, variant).kind).toBe("parameters");
  });
});

describe("Morph: parameter blending", () => {
  it("starts at the source and ends at the target", () => {
    const m = new Morph(schema, A, B, { durationSeconds: 1 });
    const first = m.advance(0);
    expect(first.values.uWarp).toBeCloseTo(0, 6);

    const last = m.advance(1);
    expect(last.values.uWarp).toBeCloseTo(1, 6);
    expect(last.done).toBe(true);
  });

  it("interpolates each parameter by its declared type", () => {
    const m = new Morph(schema, A, B, { durationSeconds: 1, easing: "linear" });
    const mid = m.advance(0.5);

    // float: linear
    expect(mid.values.uWarp).toBeCloseTo(0.5, 6);
    // angle: the short way round, 350 → 10 via 360, not via 180
    expect(Math.cos(((mid.values.uAngle as number) * Math.PI) / 180)).toBeCloseTo(1, 4);
    // int: snapped, never 10.0
    expect(Number.isInteger(mid.values.uIters)).toBe(true);
    // colour: through OKLab, so the midpoint is not muddy
    const tint = mid.values.uTint as RGB;
    expect(tint.r + tint.g).toBeGreaterThan(1.2);
  });

  it("never emits a fractional integer parameter", () => {
    const m = new Morph(schema, A, B, { durationSeconds: 1, easing: "linear" });
    for (let i = 0; i <= 20; i++) {
      expect(Number.isInteger(m.advance(0.05).values.uIters)).toBe(true);
    }
  });

  it("takes the existing value for a parameter only one preset declares", () => {
    // Interpolating from a default would sweep the parameter in from a
    // value the author never chose.
    const partial: Preset = { id: "p", name: "p", shader: "SHADER_ONE", values: { uWarp: 0.8 } };
    const m = new Morph(schema, partial, B, { durationSeconds: 1, easing: "linear" });
    const mid = m.advance(0.5);
    expect(mid.values.uWarp).toBeCloseTo(0.9, 6);
    // uTint exists only in B.
    expect(mid.values.uTint).toEqual(B.values.uTint);
  });

  it("renders at full resolution throughout", () => {
    // Only one shader is running; there is nothing to pay for.
    const m = new Morph(schema, A, B, { durationSeconds: 1 });
    expect(m.advance(0.5).scaleHint).toBe(1);
  });

  it("eases rather than moving linearly by default", () => {
    // Linear t reads as mechanical.
    const eased = new Morph(schema, A, B, { durationSeconds: 1 });
    const linear = new Morph(schema, A, B, { durationSeconds: 1, easing: "linear" });
    expect(eased.advance(0.25).values.uWarp).toBeLessThan(
      linear.advance(0.25).values.uWarp as number,
    );
  });
});

describe("Morph: crossfade", () => {
  it("fades the outgoing image out over the transition", () => {
    const m = new Morph(schema, A, C, { durationSeconds: 1, easing: "linear" });
    expect(m.advance(0).fromOpacity).toBeCloseTo(1, 6);
    expect(m.advance(0.5).fromOpacity).toBeCloseTo(0.5, 6);
    expect(m.advance(0.5).fromOpacity).toBeCloseTo(0, 6);
  });

  it("drops resolution while two shaders are running", () => {
    // Two renders at 0.7× is about the cost of one at full size, and a
    // transition is when a viewer is least able to notice softness.
    const m = new Morph(schema, A, C, { durationSeconds: 1 });
    expect(m.advance(0.5).scaleHint).toBe(CROSSFADE_SCALE);
    expect(CROSSFADE_SCALE * CROSSFADE_SCALE * 2).toBeCloseTo(0.98, 1);
  });

  it("returns to full resolution on the final frame, not after it", () => {
    // So the resolution pop happens under cover of the transition
    // finishing rather than a frame later, on a settled image.
    const m = new Morph(schema, A, C, { durationSeconds: 1 });
    m.advance(0.9);
    const last = m.advance(0.2);
    expect(last.done).toBe(true);
    expect(last.scaleHint).toBe(1);
  });

  it("uses the target's own parameters throughout", () => {
    // The same parameter name usually means something different in two
    // different shaders, so blending across them is meaningless.
    const m = new Morph(schema, A, C, { durationSeconds: 1 });
    expect(m.advance(0.5).values).toEqual(C.values);
  });
});

describe("Morph.redirect", () => {
  it("continues from the current blend rather than jumping back", () => {
    // Clicking through presets quickly starts a new morph per click.
    // Restarting from the original source would jump the image backwards.
    const m = new Morph(schema, A, B, { durationSeconds: 1, easing: "linear" });
    m.advance(0.5);

    const next = m.redirect(A, { durationSeconds: 1, easing: "linear" });
    const first = next.advance(0);
    expect(first.values.uWarp).toBeCloseTo(0.5, 2);
  });

  it("ends at the new target", () => {
    const m = new Morph(schema, A, B, { durationSeconds: 1, easing: "linear" });
    m.advance(0.5);
    const next = m.redirect(A, { durationSeconds: 1, easing: "linear" });
    expect(next.advance(1).values.uWarp).toBeCloseTo(0, 6);
  });
});

describe("Morph timing", () => {
  it("clamps progress at 1 even if overshot", () => {
    const m = new Morph(schema, A, B, { durationSeconds: 0.5 });
    const f = m.advance(10);
    expect(f.t).toBeCloseTo(1, 6);
    expect(f.done).toBe(true);
    expect(m.progress).toBeCloseTo(1, 6);
  });

  it("does not divide by zero on a zero duration", () => {
    const m = new Morph(schema, A, B, { durationSeconds: 0 });
    const f = m.advance(0.016);
    expect(Number.isFinite(f.t)).toBe(true);
    expect(f.done).toBe(true);
  });

  it("reaches the target in the declared time at any frame rate", () => {
    for (const fps of [30, 60, 144]) {
      const m = new Morph(schema, A, B, { durationSeconds: 1, easing: "linear" });
      const dt = 1 / fps;
      let f = m.advance(0);
      for (let i = 0; i < fps; i++) f = m.advance(dt);
      expect(f.values.uWarp, `${fps} fps`).toBeCloseTo(1, 6);
      expect(f.done).toBe(true);
    }
  });
});

describe("coercePreset", () => {
  it("accepts a well-formed preset", () => {
    const p = coercePreset(schema, { id: "x", name: "X", shader: "void main(){}", values: { uWarp: 0.5 } }, "fb");
    expect(p).toMatchObject({ id: "x", name: "X" });
    expect(p!.values.uWarp).toBe(0.5);
  });

  it("rejects anything without a shader", () => {
    expect(coercePreset(schema, { name: "X" }, "fb")).toBeNull();
    expect(coercePreset(schema, { shader: "" }, "fb")).toBeNull();
    expect(coercePreset(schema, null, "fb")).toBeNull();
    expect(coercePreset(schema, "a string", "fb")).toBeNull();
  });

  it("repairs bad values instead of discarding the preset", () => {
    // Losing a library because one entry is malformed is worse than
    // loading it with one entry reset.
    const p = coercePreset(schema, { shader: "x", values: { uWarp: "banana", uIters: 99 } }, "fb")!;
    expect(p.values.uWarp).toBe(0);
    expect(p.values.uIters).toBe(32);
  });

  it("supplies a fallback id and name", () => {
    const p = coercePreset(schema, { shader: "x" }, "generated-id")!;
    expect(p.id).toBe("generated-id");
    expect(p.name).toBe("Untitled");
  });

  it("fills in parameters the preset predates", () => {
    const p = coercePreset(schema, { shader: "x", values: {} }, "fb")!;
    expect(Object.keys(p.values).sort()).toEqual(["uAngle", "uIters", "uTint", "uWarp"]);
  });
});
