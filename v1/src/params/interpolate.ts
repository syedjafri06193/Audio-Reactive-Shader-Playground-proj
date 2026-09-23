/**
 * Typed interpolation.
 *
 * A single generic lerp across all uniforms is the source of most "why does
 * this transition look wrong" bugs. Three types need special handling and
 * all three are commonly done wrong:
 *
 *   - **Colours** lerped in sRGB pass through mud rather than through the
 *     hue between them.
 *   - **Angles** lerped linearly sweep the long way round the circle.
 *   - **Integers and enums** should not be interpolated at all. An
 *     iteration count of 7.3 is meaningless.
 *
 * So every parameter declares its type and dispatch happens on that.
 */

import { converter } from "culori";

export type ParamType = "float" | "color" | "angle" | "int" | "bool" | "enum" | "vec2" | "vec3";

/** sRGB, 0–1 per channel. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * `string` is in here for enums, whose values are their option names rather
 * than indices. Storing an enum as a number would make every preset file
 * depend on the declaration order of its options, so adding one in the
 * middle would silently rewrite every saved preset.
 */
export type ParamValue = number | boolean | string | RGB | number[];

// culori's converters are built once. They parse and cache, and building
// one per call would put a surprising amount of work in the morph loop.
const toOklab = converter("oklab");
const toRgb = converter("rgb");

/**
 * Interpolate two colours through OKLab.
 *
 * Lerping sRGB values gives dark, desaturated midpoints — a red-to-green
 * blend passes through a muddy brown rather than through yellow, because
 * sRGB is perceptually non-uniform and the numeric midpoint is nowhere near
 * the visual one. Linear RGB is better; OKLab is better still, being
 * designed so that equal numeric steps are equal perceptual steps.
 */
export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const la = toOklab({ mode: "rgb", r: a.r, g: a.g, b: a.b });
  const lb = toOklab({ mode: "rgb", r: b.r, g: b.g, b: b.b });

  const mixed = toRgb({
    mode: "oklab",
    l: la.l + (lb.l - la.l) * t,
    a: la.a + (lb.a - la.a) * t,
    b: la.b + (lb.b - la.b) * t,
  });

  // OKLab can describe colours outside the sRGB gamut, and the conversion
  // back produces components outside 0–1 for them. Clamping here rather
  // than letting them reach the GPU: a negative component in a uniform
  // renders as a colour nobody chose.
  return {
    r: clamp01(mixed.r),
    g: clamp01(mixed.g),
    b: clamp01(mixed.b),
  };
}

/**
 * Interpolate two angles in degrees, taking the short way round.
 *
 * Linear interpolation from 350° to 10° sweeps 340° backwards through the
 * whole colour wheel. What anyone means by that transition is a 20° step
 * forward.
 *
 * The result is **not** wrapped back into [0, 360): `lerpAngle(350, 10, 0.5)`
 * is 360, not 0. Those are the same angle, and leaving it unwrapped is
 * deliberate — wrapping puts a discontinuity in the middle of the
 * transition, and anything downstream that smooths this value (midi/slew.ts
 * does exactly that to every parameter it drives) sees a 360° jump and spins
 * the shader backwards for a few frames. A continuous ramp costs nothing,
 * since every consumer of an angle feeds it to sin/cos or a rotation matrix.
 * Use `wrapDegrees` when a human has to read the number.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  // Wrap the difference into [-180, 180]. The +540 is +360 (to make the
  // modulo operand positive for negative differences) plus 180 (to centre
  // the range), and it is why this works for any inputs rather than only
  // for angles already in [0, 360).
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

/**
 * Fold an angle into [0, 360) for display.
 *
 * Only for showing a number to a person. Feeding a wrapped angle back into
 * an interpolation or a slew filter reintroduces exactly the discontinuity
 * `lerpAngle` avoids.
 */
export function wrapDegrees(deg: number): number {
  const w = deg % 360;
  return w < 0 ? w + 360 : w;
}

/** Interpolate angles in radians. */
export function lerpAngleRadians(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  const d = ((b - a + Math.PI * 3) % twoPi) - Math.PI;
  return a + d * t;
}

export function lerpFloat(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Snap at the midpoint rather than interpolating.
 *
 * An iteration count of 7.3, a boolean of 0.5, or an enum halfway between
 * two cases are all meaningless. If a discrete parameter needs to change
 * smoothly, the answer is to crossfade the whole preset (presets/morph.ts)
 * rather than to invent a value between them.
 */
export function snap<T>(a: T, b: T, t: number): T {
  return t < 0.5 ? a : b;
}

export function lerpVector(a: number[], b: number[], t: number): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export type Interpolator = (a: ParamValue, b: ParamValue, t: number) => ParamValue;

/** The dispatch table. Every parameter type has exactly one entry. */
export const INTERPOLATORS: Record<ParamType, Interpolator> = {
  float: (a, b, t) => lerpFloat(a as number, b as number, t),
  angle: (a, b, t) => lerpAngle(a as number, b as number, t),
  color: (a, b, t) => lerpColor(a as RGB, b as RGB, t),
  vec2: (a, b, t) => lerpVector(a as number[], b as number[], t),
  vec3: (a, b, t) => lerpVector(a as number[], b as number[], t),
  int: (a, b, t) => snap(a, b, t),
  bool: (a, b, t) => snap(a, b, t),
  enum: (a, b, t) => snap(a, b, t),
};

export function interpolate(type: ParamType, a: ParamValue, b: ParamValue, t: number): ParamValue {
  return INTERPOLATORS[type](a, b, t);
}

// ------------------------------------------------------------------ easing

/**
 * Linear `t` reads as mechanical. Easing is what makes a transition read as
 * designed rather than as a computer moving a number.
 */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

export const EASINGS = {
  linear: (t: number) => clamp01(t),
  smoothstep,
  easeInOutCubic,
  easeOutCubic,
} as const;

export type EasingName = keyof typeof EASINGS;

// ------------------------------------------------------------------ helpers

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Relative luminance, for asserting that a blend did not go through mud. */
export function luminance(c: RGB): number {
  // Rec. 709 coefficients on linearised components. Computing luminance on
  // raw sRGB — which is a common shortcut — would overstate the brightness
  // of dark colours and understate it for light ones.
  const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** "#ff0080" or "#f08" to RGB. */
export function parseHex(hex: string): RGB {
  const s = hex.replace("#", "").trim();
  const full =
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`parseHex: not a colour: ${hex}`);
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
  };
}

export function toHex(c: RGB): string {
  const byte = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
}
