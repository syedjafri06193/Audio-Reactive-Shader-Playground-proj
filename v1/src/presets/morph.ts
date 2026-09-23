/**
 * Morphing between presets.
 *
 * Two presets can differ in two ways, and they need entirely different
 * treatment:
 *
 *   - **Same shader, different parameters.** Interpolate the parameters,
 *     per their declared types (params/interpolate.ts). Cheap and smooth.
 *   - **Different shaders.** There is no interpolation between two GLSL
 *     programs. The only honest answer is to render both and crossfade the
 *     images, which costs two full renders for the duration of the
 *     transition.
 *
 * Because that second case doubles the frame cost exactly when something
 * visually busy is happening, the renderer drops to 0.7× resolution while a
 * crossfade is in flight. 0.7 is roughly half the pixels, which pays for
 * the second render almost exactly; and a transition is the moment a
 * viewer is least able to notice softness, because the whole image is
 * changing anyway.
 */

import { EASINGS, type EasingName, type ParamValue } from "../params/interpolate.ts";
import { interpolate } from "../params/interpolate.ts";
import type { ParamSchema, ParamValues } from "../params/schema.ts";
import type { ModulationState } from "../params/modulation.ts";

export interface Preset {
  id: string;
  name: string;
  /** The user's fragment source, without the prelude. */
  shader: string;
  values: ParamValues;
  modulation?: ModulationState;
  author?: string;
  description?: string;
}

export type MorphKind = "parameters" | "crossfade";

export interface MorphOptions {
  durationSeconds?: number;
  easing?: EasingName;
}

export interface MorphFrame {
  /** Eased progress, 0–1. */
  t: number;
  kind: MorphKind;
  /** Parameters to render with. For a crossfade these are the target's. */
  values: ParamValues;
  /** Crossfade only: how much of the outgoing image to show. */
  fromOpacity: number;
  /** Resolution multiplier the renderer should apply this frame. */
  scaleHint: number;
  done: boolean;
}

/**
 * Resolution multiplier while a crossfade is running.
 *
 * 0.7² ≈ 0.49, so the two renders together cost about what one full-size
 * render did. Anything less aggressive does not pay for the second pass;
 * anything more is visible as a resolution pop at the seams.
 */
export const CROSSFADE_SCALE = 0.7;

export class Morph {
  private elapsed = 0;
  private readonly duration: number;
  private readonly ease: (t: number) => number;
  readonly kind: MorphKind;

  constructor(
    private readonly schema: ParamSchema,
    readonly from: Preset,
    readonly to: Preset,
    options: MorphOptions = {},
  ) {
    this.duration = Math.max(1e-3, options.durationSeconds ?? 1.5);
    this.ease = EASINGS[options.easing ?? "easeInOutCubic"];

    // Comparing source text rather than an id: two presets can share a
    // shader (a colour variant of the same patch), and interpolating those
    // parameters is both cheaper and better-looking than a crossfade.
    this.kind = from.shader === to.shader ? "parameters" : "crossfade";
  }

  advance(dt: number): MorphFrame {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);

    // Accumulating dt in floating point leaves `elapsed` a hair under
    // `duration` — sixty additions of 1/60 sum to 0.9999999999999999 — so a
    // strict `>= 1` never fires. The consequence is not cosmetic: a
    // crossfade that never reports done keeps both shaders rendering and
    // holds the resolution at 0.7× indefinitely. The epsilon is a frame at
    // 10,000 fps, far below any real dt.
    const done = this.elapsed >= this.duration - 1e-6;
    const raw = done ? 1 : this.elapsed / this.duration;
    const t = this.ease(raw);

    if (this.kind === "parameters") {
      return {
        t,
        kind: "parameters",
        values: this.blend(t),
        fromOpacity: 0,
        scaleHint: 1,
        done,
      };
    }

    return {
      t,
      kind: "crossfade",
      // The incoming shader renders with its own parameters throughout.
      // Blending values across two different shaders is meaningless — the
      // same parameter name usually means something different in each.
      values: this.to.values,
      fromOpacity: 1 - t,
      // Return to full resolution on the last frame rather than one frame
      // later, so the pop happens under cover of the transition finishing.
      scaleHint: done ? 1 : CROSSFADE_SCALE,
      done,
    };
  }

  /** Interpolate every parameter by its declared type. */
  private blend(t: number): ParamValues {
    const out: ParamValues = {};

    for (const decl of this.schema.order) {
      const a = this.from.values[decl.name];
      const b = this.to.values[decl.name];

      // A parameter present in only one preset is not interpolated from a
      // default — that would make it sweep in from a value the author
      // never chose. It simply takes the value that exists.
      if (a === undefined && b === undefined) continue;
      if (a === undefined) {
        out[decl.name] = b as ParamValue;
        continue;
      }
      if (b === undefined) {
        out[decl.name] = a as ParamValue;
        continue;
      }

      out[decl.name] = interpolate(decl.type, a, b, t);
    }

    return out;
  }

  get progress(): number {
    return this.elapsed / this.duration;
  }

  get isDone(): boolean {
    return this.elapsed >= this.duration;
  }

  /**
   * Restart toward a new target from wherever this morph currently is.
   *
   * Someone clicking through presets quickly starts a new morph every
   * click. Beginning each from the *original* source would jump the image
   * back before moving forward again; beginning from the current blend is
   * what makes rapid clicking look continuous.
   */
  redirect(to: Preset, options: MorphOptions = {}): Morph {
    const current: Preset =
      this.kind === "parameters"
        ? { ...this.from, values: this.blend(this.ease(this.progress)) }
        : this.to;
    return new Morph(this.schema, current, to, options);
  }
}

/**
 * Validate and normalise a preset loaded from JSON.
 *
 * Presets are shared as files and pasted from the internet, so the input
 * is untrusted in the ordinary sense — malformed, from an older version, or
 * hand-edited. Never throws: losing a library because one entry is
 * malformed is worse than loading it with one entry reset.
 */
export function coercePreset(schema: ParamSchema, raw: unknown, fallbackId: string): Preset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.shader !== "string" || r.shader.length === 0) return null;

  const { values } = schema.coerce(
    typeof r.values === "object" && r.values !== null ? (r.values as Record<string, unknown>) : {},
  );

  return {
    id: typeof r.id === "string" ? r.id : fallbackId,
    name: typeof r.name === "string" ? r.name : "Untitled",
    shader: r.shader,
    values,
    author: typeof r.author === "string" ? r.author : undefined,
    description: typeof r.description === "string" ? r.description : undefined,
    modulation:
      typeof r.modulation === "object" && r.modulation !== null
        ? (r.modulation as ModulationState)
        : undefined,
  };
}
