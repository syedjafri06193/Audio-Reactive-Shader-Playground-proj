/**
 * The modulation matrix: audio features and LFOs driving parameters.
 *
 * This is the layer that turns "the analyser produced numbers" into "the
 * shader reacts to the music", and almost all of its difficulty is in the
 * combining rules rather than in any individual route.
 *
 * Three decisions shape everything here:
 *
 * 1. **Modulation is an offset on a base value, not a replacement.** The
 *    base is whatever the UI slider or a MIDI CC last set. If modulation
 *    overwrote it, moving the slider during a performance would do nothing
 *    while the music was playing, which is exactly when someone reaches for
 *    it.
 *
 * 2. **Routes to the same target sum, and the sum is clamped once.** Clamping
 *    per route means two routes of +0.6 each land at 1.0 rather than being
 *    visibly saturated, and the second route silently does nothing.
 *
 * 3. **Smoothing lives on the route, not on the source.** Bass driving a
 *    scale wants to be smooth; bass driving a flash wants to be immediate.
 *    Smoothing the source once would force one answer on both.
 */

import type { AudioFeatures } from "../audio/features.ts";
import { denormalize, normalize, type ParamDecl, type ParamSchema, type ParamValues } from "./schema.ts";
import type { ParamValue } from "./interpolate.ts";

/**
 * Where modulation comes from.
 *
 * All sources are normalised to 0–1 before they reach a route, so a route's
 * `amount` means the same thing whatever it is connected to. Without that,
 * every route would need to be retuned when it was repointed.
 */
export type ModSourceName =
  | "level"
  | "sub"
  | "bass"
  | "lowMid"
  | "mid"
  | "highMid"
  | "treble"
  | "centroid"
  | "flux"
  | "onset"
  | "beatPhase"
  | "lfo1"
  | "lfo2";

export type ModCurve = "linear" | "exp" | "log" | "scurve";

export interface ModRoute {
  /** Stable identity, so the UI can edit a route without recreating it. */
  id: string;
  source: ModSourceName;
  /** Parameter name, matching a declaration in the schema. */
  target: string;
  /**
   * How far the source moves the target, in fractions of the target's full
   * declared range. 1 means a source at full scale sweeps the whole range;
   * negative inverts.
   */
  amount: number;
  curve?: ModCurve;
  /**
   * Seconds to cover ~63% of a step change. 0 is instantaneous, which is
   * what an onset-driven flash wants.
   */
  smoothingSeconds?: number;
  /**
   * Bipolar routes centre the source on 0.5 and swing either side, so a
   * quiet passage pulls the parameter *below* its base rather than merely
   * failing to push it above. Unipolar is the default because it is what
   * "louder means more" means.
   */
  bipolar?: boolean;
  enabled?: boolean;
}

/** A free-running LFO, the one modulation source that is not the audio. */
export interface LfoConfig {
  /** Hz, or beats per cycle when `sync` is set. */
  rate: number;
  shape: "sine" | "triangle" | "saw" | "square";
  /**
   * Lock the LFO to the detected tempo. A free-running LFO drifts against
   * the music and the drift is the thing people notice; `rate` then reads
   * as cycles per beat.
   */
  sync?: boolean;
  phase?: number;
}

export interface ModulationState {
  routes: ModRoute[];
  lfo1: LfoConfig;
  lfo2: LfoConfig;
}

export const DEFAULT_LFO: LfoConfig = { rate: 0.25, shape: "sine" };

// ----------------------------------------------------------------- sources

/**
 * Read every source into a flat 0–1 table.
 *
 * Built once per frame and shared by all routes, because several routes
 * commonly point at the same source and recomputing an LFO per route makes
 * two routes on `lfo1` run at subtly different phases.
 */
export function sampleSources(
  features: AudioFeatures,
  mod: ModulationState,
  audioTime: number,
): Record<ModSourceName, number> {
  return {
    level: features.rms,
    sub: features.sub,
    bass: features.bass,
    lowMid: features.lowMid,
    mid: features.mid,
    highMid: features.highMid,
    treble: features.treble,
    centroid: features.centroid,
    flux: features.flux,
    onset: features.onsetEnvelope,
    beatPhase: features.beatPhase,
    lfo1: evaluateLfo(mod.lfo1, audioTime, features.bpm, features.beatPhase),
    lfo2: evaluateLfo(mod.lfo2, audioTime, features.bpm, features.beatPhase),
  };
}

/**
 * Evaluate an LFO to 0–1.
 *
 * Driven by `AudioContext.currentTime` rather than `performance.now()`: an
 * LFO is musical timing, and the two clocks drift. A tempo-synced LFO that
 * followed the UI clock would slip against the beat it is supposed to be
 * locked to over the course of a set.
 */
export function evaluateLfo(
  lfo: LfoConfig,
  audioTime: number,
  bpm: number | null,
  beatPhase: number,
): number {
  let phase: number;

  if (lfo.sync && bpm !== null) {
    // `rate` is cycles per beat. Anchoring on the tracker's beat phase
    // rather than integrating our own counter means the LFO re-locks when
    // the tempo estimate changes, instead of holding an old tempo and
    // drifting further out with every bar.
    phase = beatPhase * lfo.rate;
  } else {
    phase = audioTime * lfo.rate;
  }

  phase = (phase + (lfo.phase ?? 0)) % 1;
  if (phase < 0) phase += 1;

  switch (lfo.shape) {
    case "sine":
      return 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    case "triangle":
      return phase < 0.5 ? phase * 2 : 2 - phase * 2;
    case "saw":
      return phase;
    case "square":
      return phase < 0.5 ? 1 : 0;
  }
}

// ------------------------------------------------------------------ curves

/**
 * Shape a 0–1 source before it is scaled.
 *
 * The curve matters more than it looks. Loudness is perceived
 * logarithmically, so a linear route from `bass` to a scale parameter spends
 * most of its travel in the top of the range and reads as a parameter that
 * is either off or pinned. An `exp` curve pulls the response down into the
 * quiet part where the interesting variation is.
 */
export function applyModCurve(x: number, curve: ModCurve = "linear"): number {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  switch (curve) {
    case "exp":
      return v * v;
    case "log":
      return Math.sqrt(v);
    case "scurve":
      return v * v * (3 - 2 * v);
    default:
      return v;
  }
}

// --------------------------------------------------------------- the engine

/**
 * Per-route smoothing state.
 *
 * Kept outside `ModRoute` so that routes stay plain serialisable data — a
 * preset is a list of routes, and a filter's running value has no business
 * being saved into one.
 */
interface RouteState {
  smoothed: number;
}

/** Reported per frame so the UI can show what each route is actually doing. */
export interface RouteActivity {
  id: string;
  /** The post-curve, post-smoothing source value, 0–1. */
  value: number;
  /** Its contribution in normalised target units, before summing. */
  contribution: number;
}

export interface ApplyResult {
  values: ParamValues;
  activity: RouteActivity[];
  /** Routes that could not be applied, with the reason. Shown once, not per frame. */
  rejected: Array<{ id: string; reason: string }>;
}

export class ModulationEngine {
  private readonly state = new Map<string, RouteState>();

  constructor(private readonly schema: ParamSchema) {}

  /**
   * Apply every enabled route to the base values.
   *
   * @param base   parameters as set by the UI and MIDI.
   * @param dt     seconds since the last call, already clamped by the caller.
   * @returns a new value table; `base` is not mutated, because the UI holds
   *          a reference to it and modulated values must not write back into
   *          the slider positions.
   */
  apply(
    base: ParamValues,
    mod: ModulationState,
    sources: Record<ModSourceName, number>,
    dt: number,
  ): ApplyResult {
    const activity: RouteActivity[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];

    // Accumulate in normalised units so routes of different curves and
    // ranges add commensurably, then denormalise once per target.
    const offsets = new Map<string, number>();

    for (const route of mod.routes) {
      if (route.enabled === false) continue;

      const decl = this.schema.get(route.target);
      if (!decl) {
        rejected.push({ id: route.id, reason: `no parameter named "${route.target}"` });
        continue;
      }
      if (!isModulatable(decl)) {
        // A colour has three dimensions and an enum has no ordering, so
        // "80% of the way along" is not defined for either. Rejecting is
        // honest; picking an axis arbitrarily would produce behaviour no
        // one asked for and no one could predict.
        rejected.push({
          id: route.id,
          reason: `${decl.type} parameters cannot be modulated by a scalar source`,
        });
        continue;
      }

      const raw = sources[route.source] ?? 0;
      const shaped = applyModCurve(raw, route.curve);
      const smoothed = this.smooth(route, shaped, dt);

      // Bipolar: recentre so that a source at its midpoint leaves the
      // parameter alone and either direction moves it.
      const signal = route.bipolar ? (smoothed - 0.5) * 2 : smoothed;
      const contribution = signal * route.amount;

      offsets.set(route.target, (offsets.get(route.target) ?? 0) + contribution);
      activity.push({ id: route.id, value: smoothed, contribution });
    }

    if (offsets.size === 0) return { values: base, activity, rejected };

    const values: ParamValues = { ...base };
    for (const [target, offset] of offsets) {
      const decl = this.schema.get(target);
      if (!decl) continue;

      // Round-trip through the declaration's own curve so that a log-scaled
      // parameter is modulated log-scaled. Adding in raw units would make a
      // route's effect depend on where the base value happens to sit.
      const baseNorm = normalize(decl, base[target] ?? 0);
      values[target] = denormalize(decl, baseNorm + offset);
    }

    return { values, activity, rejected };
  }

  /**
   * One-pole smoothing, frame-rate independent.
   *
   * `1 - exp(-rate * dt)` rather than a fixed per-frame coefficient. A fixed
   * coefficient is the standard bug here: it smooths over a number of
   * *frames*, so the same patch responds twice as fast on a 120 Hz display
   * as on a 60 Hz one, and a dropped frame changes the sound of the
   * visualisation.
   */
  private smooth(route: ModRoute, target: number, dt: number): number {
    const seconds = route.smoothingSeconds ?? 0;
    if (seconds <= 0) {
      this.state.set(route.id, { smoothed: target });
      return target;
    }

    let st = this.state.get(route.id);
    if (!st) {
      // A new route starts *at* its source rather than ramping from zero.
      // Ramping would make every newly added route fade in, which looks
      // like a bug when someone adds one mid-performance.
      st = { smoothed: target };
      this.state.set(route.id, st);
      return target;
    }

    const alpha = 1 - Math.exp(-dt / seconds);
    st.smoothed += (target - st.smoothed) * alpha;
    return st.smoothed;
  }

  /** Drop filter state for routes that no longer exist. */
  prune(mod: ModulationState): void {
    const live = new Set(mod.routes.map((r) => r.id));
    for (const id of this.state.keys()) {
      if (!live.has(id)) this.state.delete(id);
    }
  }

  reset(): void {
    this.state.clear();
  }
}

/**
 * Whether a scalar source can drive this parameter.
 *
 * Numeric parameters yes; colours, booleans and enums no. A bool could
 * arguably be threshold-driven, but a boolean flickering at the threshold
 * on every analysis frame is not a feature anyone wants — an onset-driven
 * envelope on a float is the thing people actually mean when they ask for
 * it.
 */
export function isModulatable(decl: ParamDecl): boolean {
  return decl.type === "float" || decl.type === "angle" || decl.type === "int";
}

/** Create a route with sensible defaults filled in. */
export function makeRoute(
  source: ModSourceName,
  target: string,
  amount: number,
  extra: Partial<ModRoute> = {},
): ModRoute {
  return {
    id: extra.id ?? `${source}->${target}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    target,
    amount,
    curve: extra.curve ?? "linear",
    // A little smoothing by default. Raw analyser output at 60 fps is
    // visibly steppy on anything geometric, and the most common first
    // reaction to an unsmoothed route is that the analysis is broken.
    smoothingSeconds: extra.smoothingSeconds ?? 0.08,
    bipolar: extra.bipolar ?? false,
    enabled: extra.enabled ?? true,
  };
}

export function emptyModulation(): ModulationState {
  return { routes: [], lfo1: { ...DEFAULT_LFO }, lfo2: { ...DEFAULT_LFO, rate: 0.1 } };
}

/** Re-export for callers that only import this module. */
export type { ParamValue };
