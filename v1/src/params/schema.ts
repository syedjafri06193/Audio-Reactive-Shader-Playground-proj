/**
 * Parameter declarations.
 *
 * Every parameter the UI, MIDI layer, preset system and morph engine touch
 * is declared here once. The declaration carries the type — which is what
 * interpolate.ts dispatches on — plus the range, which four separate
 * subsystems would otherwise each have to guess at:
 *
 *   - the UI, to size a slider;
 *   - MIDI, to map 0–127 onto something meaningful;
 *   - presets, to validate a file written by an older version;
 *   - modulation, to scale an audio feature into the parameter's units.
 *
 * Having them guess independently is how a slider ends up with a different
 * range from the CC mapped to it.
 */

import type { ParamType, ParamValue, RGB } from "./interpolate.ts";

export interface ParamDeclBase {
  /** Uniform name in GLSL, e.g. `uWarp`. Also the preset key. */
  name: string;
  /** Label for the UI. */
  label: string;
  type: ParamType;
  /** Optional grouping for the UI panel. */
  group?: string;
  /** One line of help text. */
  description?: string;
}

export interface NumericParamDecl extends ParamDeclBase {
  type: "float" | "angle" | "int";
  min: number;
  max: number;
  default: number;
  /**
   * Slider granularity, and the quantum MIDI snaps to. For an `int` this is
   * forced to 1 regardless of what is declared.
   */
  step?: number;
  /**
   * A skew for the slider and for MIDI mapping. Frequencies, scales and
   * iteration counts are all perceived logarithmically: a linear 0–127
   * mapped onto a 0.1–100 scale parameter spends the first half of the knob
   * travel in a range nobody can tell apart.
   */
  curve?: "linear" | "log";
}

export interface BoolParamDecl extends ParamDeclBase {
  type: "bool";
  default: boolean;
}

export interface EnumParamDecl extends ParamDeclBase {
  type: "enum";
  options: readonly string[];
  default: string;
}

export interface ColorParamDecl extends ParamDeclBase {
  type: "color";
  default: RGB;
}

export interface VectorParamDecl extends ParamDeclBase {
  type: "vec2" | "vec3";
  min: number;
  max: number;
  default: number[];
}

export type ParamDecl =
  | NumericParamDecl
  | BoolParamDecl
  | EnumParamDecl
  | ColorParamDecl
  | VectorParamDecl;

export type ParamValues = Record<string, ParamValue>;

// ------------------------------------------------------------------ ranges

/** True when this declaration has a numeric range to normalise against. */
export function hasRange(decl: ParamDecl): decl is NumericParamDecl | VectorParamDecl {
  return decl.type === "float" || decl.type === "angle" || decl.type === "int" || decl.type === "vec2" || decl.type === "vec3";
}

/**
 * Map a normalised 0–1 value into the parameter's own units.
 *
 * This is the single place the curve is applied. MIDI, modulation and the
 * UI all go through it, so a CC and a slider bound to the same parameter
 * cannot disagree about where the middle is.
 */
export function denormalize(decl: ParamDecl, t: number): ParamValue {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;

  switch (decl.type) {
    case "bool":
      return x >= 0.5;

    case "enum": {
      // Spread the options evenly. The `min` guards the x===1 case, which
      // would otherwise index one past the end.
      const i = Math.min(decl.options.length - 1, Math.floor(x * decl.options.length));
      return decl.options[i];
    }

    case "color":
      // Colours are not driven by a single scalar; a modulation route
      // targeting one is rejected at bind time rather than silently doing
      // something arbitrary here.
      return decl.default;

    case "vec2":
    case "vec3": {
      const v = decl.min + (decl.max - decl.min) * x;
      return new Array(decl.type === "vec2" ? 2 : 3).fill(v);
    }

    case "int":
      return Math.round(applyCurve(decl, x));

    default:
      return quantize(decl, applyCurve(decl, x));
  }
}

/** The inverse of `denormalize`, for putting a value back on a slider. */
export function normalize(decl: ParamDecl, value: ParamValue): number {
  switch (decl.type) {
    case "bool":
      return value ? 1 : 0;

    case "enum": {
      const i = decl.options.indexOf(value as string);
      // An unknown enum value (a preset from a newer version) reads as 0
      // rather than -1/length, which would put the slider off its own scale.
      return i < 0 ? 0 : (i + 0.5) / decl.options.length;
    }

    case "color":
      return 0;

    case "vec2":
    case "vec3": {
      const arr = value as number[];
      const mean = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
      return clamp01((mean - decl.min) / (decl.max - decl.min || 1));
    }

    default: {
      const n = value as number;
      if (decl.curve === "log") {
        const lo = Math.log(Math.max(decl.min, LOG_FLOOR));
        const hi = Math.log(Math.max(decl.max, LOG_FLOOR * 2));
        return clamp01((Math.log(Math.max(n, LOG_FLOOR)) - lo) / (hi - lo));
      }
      return clamp01((n - decl.min) / (decl.max - decl.min || 1));
    }
  }
}

/**
 * A log curve cannot start at zero, and plenty of real parameters do
 * (intensity, warp amount). Rather than rejecting the declaration, the
 * curve is evaluated from a small positive floor — three decades below 1 is
 * far below any value a person can distinguish on screen.
 */
const LOG_FLOOR = 1e-3;

function applyCurve(decl: NumericParamDecl, x: number): number {
  if (decl.curve !== "log") return decl.min + (decl.max - decl.min) * x;

  const lo = Math.log(Math.max(decl.min, LOG_FLOOR));
  const hi = Math.log(Math.max(decl.max, LOG_FLOOR * 2));
  return Math.exp(lo + (hi - lo) * x);
}

function quantize(decl: NumericParamDecl, v: number): number {
  if (!decl.step) return v;
  const snapped = Math.round((v - decl.min) / decl.step) * decl.step + decl.min;
  // Floating-point accumulation leaves 0.30000000000000004 on a 0.1 step,
  // which shows up in the UI and in saved presets. Round to the step's own
  // precision.
  const decimals = Math.max(0, Math.ceil(-Math.log10(decl.step)));
  return Number(snapped.toFixed(decimals));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ------------------------------------------------------------------ registry

/**
 * A set of declarations, keyed by name.
 *
 * Built from a list rather than written as an object literal so that
 * declaration order — which is the UI's display order — is preserved, and
 * so that a duplicate name is an error rather than a silent overwrite.
 */
export class ParamSchema {
  private readonly byName = new Map<string, ParamDecl>();
  readonly order: readonly ParamDecl[];

  constructor(decls: readonly ParamDecl[]) {
    for (const d of decls) {
      if (this.byName.has(d.name)) {
        throw new Error(`ParamSchema: duplicate parameter name "${d.name}"`);
      }
      this.byName.set(d.name, d);
    }
    this.order = decls;
  }

  get(name: string): ParamDecl | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every parameter at its declared default. */
  defaults(): ParamValues {
    const out: ParamValues = {};
    for (const d of this.order) out[d.name] = defaultOf(d);
    return out;
  }

  /**
   * Coerce a loaded preset into this schema.
   *
   * Presets outlive the shaders they were written for. A preset saved
   * before a parameter existed is missing a key; one saved after a
   * parameter was removed carries an extra; one saved when a parameter was
   * a float and reloaded after it became an enum carries the wrong type
   * entirely. All three are normal, and none of them should throw — losing
   * someone's preset because a shader was edited is not acceptable
   * behaviour. Unknown keys are returned separately rather than dropped
   * silently, so the UI can say what it ignored.
   */
  coerce(values: Record<string, unknown>): { values: ParamValues; unknown: string[]; invalid: string[] } {
    const out: ParamValues = {};
    const invalid: string[] = [];

    for (const d of this.order) {
      const raw = values[d.name];
      if (raw === undefined) {
        out[d.name] = defaultOf(d);
        continue;
      }
      const ok = coerceOne(d, raw);
      if (ok === undefined) {
        invalid.push(d.name);
        out[d.name] = defaultOf(d);
      } else {
        out[d.name] = ok;
      }
    }

    const unknown = Object.keys(values).filter((k) => !this.byName.has(k));
    return { values: out, unknown, invalid };
  }

  /** Clamp a single value into its declared range. */
  clamp(name: string, value: ParamValue): ParamValue {
    const d = this.byName.get(name);
    if (!d) return value;
    return coerceOne(d, value) ?? defaultOf(d);
  }
}

export function defaultOf(d: ParamDecl): ParamValue {
  // Colours and vectors are objects and arrays. Returning the declaration's
  // own default would hand every caller a reference to the same object, and
  // the first one to mutate it would change the default for everyone.
  if (d.type === "color") return { ...d.default };
  if (d.type === "vec2" || d.type === "vec3") return [...d.default];
  return d.default;
}

function coerceOne(d: ParamDecl, raw: unknown): ParamValue | undefined {
  switch (d.type) {
    case "bool":
      return typeof raw === "boolean" ? raw : undefined;

    case "enum":
      return typeof raw === "string" && d.options.includes(raw) ? raw : undefined;

    case "color": {
      if (typeof raw !== "object" || raw === null) return undefined;
      const c = raw as Partial<RGB>;
      if (typeof c.r !== "number" || typeof c.g !== "number" || typeof c.b !== "number") {
        return undefined;
      }
      return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) };
    }

    case "vec2":
    case "vec3": {
      const want = d.type === "vec2" ? 2 : 3;
      if (!Array.isArray(raw) || raw.length !== want) return undefined;
      if (!raw.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
      return raw.map((v: number) => Math.min(d.max, Math.max(d.min, v)));
    }

    default: {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      // Angles wrap rather than clamp. Clamping a rotation to its declared
      // range turns "spun past the end" into "stuck at the end", which is a
      // visible bug rather than a safe fallback.
      if (d.type === "angle") return raw;
      const clamped = Math.min(d.max, Math.max(d.min, raw));
      return d.type === "int" ? Math.round(clamped) : clamped;
    }
  }
}
