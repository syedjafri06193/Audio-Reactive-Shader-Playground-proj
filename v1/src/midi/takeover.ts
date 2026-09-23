/**
 * Takeover: what happens when a physical knob's position disagrees with the
 * parameter's value.
 *
 * They disagree constantly. A preset was loaded, a parameter was modulated,
 * the value was changed with the mouse, or a different bank was selected on
 * the controller. The knob is at 20 and the parameter is at 0.9, and the
 * first thing the performer does is nudge the knob.
 *
 * There is no correct answer, only three wrong-in-different-ways ones, and
 * which one is wrong matters entirely on context — which is why this is a
 * setting rather than a constant.
 */

export type TakeoverMode = "jump" | "pickup" | "scale";

export interface TakeoverState {
  /** The parameter's value, 0–1. */
  value: number;
  /**
   * The last physical position seen, 0–1, or null if the controller has
   * not sent this CC since the parameter was last set elsewhere.
   */
  knob: number | null;
  /** True once the knob has caught up and is driving the parameter. */
  engaged: boolean;
}

export interface TakeoverResult {
  value: number;
  engaged: boolean;
  /**
   * How far the knob is from the value, 0–1, while not engaged. The UI
   * shows this as a ghost marker so the performer can see which way to
   * turn — without it, `pickup` feels like a broken knob.
   */
  distance: number;
}

/**
 * How close the knob must get before `pickup` engages.
 *
 * Two CC steps. One step is too tight: a jittery or slightly noisy
 * controller can step over a single-value window without ever landing in
 * it, and the knob then never picks up at all.
 */
const PICKUP_TOLERANCE = 2 / 127;

export function applyTakeover(
  mode: TakeoverMode,
  state: TakeoverState,
  incoming: number,
): TakeoverResult {
  switch (mode) {
    case "jump":
      // The parameter snaps to the knob. Honest and predictable, and
      // completely unusable live — the audience sees the jump.
      return { value: incoming, engaged: true, distance: 0 };

    case "pickup":
      return pickup(state, incoming);

    case "scale":
      return scale(state, incoming);
  }
}

/**
 * Pickup (also called "soft takeover"): the knob does nothing until it
 * passes through the parameter's current value, then takes control.
 *
 * The default for live use. Nothing moves until the performer means it,
 * and the cost — a knob that appears dead for the first part of its
 * travel — is exactly why the UI has to show the distance.
 */
function pickup(state: TakeoverState, incoming: number): TakeoverResult {
  if (state.engaged) {
    return { value: incoming, engaged: true, distance: 0 };
  }

  const distance = Math.abs(incoming - state.value);
  if (distance <= PICKUP_TOLERANCE) {
    return { value: incoming, engaged: true, distance: 0 };
  }

  // Crossing counts as catching. Turning a knob quickly sends sparse CC
  // values, so it can step from below the parameter to above it without
  // ever sending one inside the tolerance window — and the performer, who
  // saw the knob pass the marker, would be left with a dead control.
  if (state.knob !== null && Math.sign(incoming - state.value) !== Math.sign(state.knob - state.value)) {
    return { value: incoming, engaged: true, distance: 0 };
  }

  return { value: state.value, engaged: false, distance };
}

/**
 * Scale (also called "relative" or "value scaling"): the knob moves the
 * parameter proportionally from wherever both happen to be, so every turn
 * has an effect and the two converge at the ends of the travel.
 *
 * The compromise. Nothing is dead and nothing jumps, but the mapping is
 * not one-to-one, so the same knob position means different things at
 * different times — which makes it a poor fit for anything that has to be
 * recalled exactly.
 */
function scale(state: TakeoverState, incoming: number): TakeoverResult {
  const knob = state.knob;
  if (knob === null) {
    // No previous position to measure movement from. Do not move the
    // parameter; just record where the knob is.
    return { value: state.value, engaged: false, distance: Math.abs(incoming - state.value) };
  }

  const delta = incoming - knob;
  if (delta === 0) return { value: state.value, engaged: false, distance: 0 };

  // Scale the movement by how much room is left in that direction, on both
  // sides, so the knob and the value reach the ends together.
  const knobRoom = delta > 0 ? 1 - knob : knob;
  const valueRoom = delta > 0 ? 1 - state.value : state.value;
  const factor = knobRoom > 1e-6 ? valueRoom / knobRoom : 1;

  const next = clamp01(state.value + delta * factor);
  // Engaged once the two agree, after which it behaves like a normal knob.
  const engaged = Math.abs(next - incoming) <= PICKUP_TOLERANCE;
  return { value: next, engaged, distance: Math.abs(next - incoming) };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Per-binding takeover bookkeeping.
 *
 * `disengage` is called whenever the parameter is changed by anything other
 * than this control — a preset load, the mouse, a modulation route being
 * armed. Forgetting it is the bug that makes pickup mode feel random: the
 * knob stays engaged from a previous session and jumps the parameter on
 * first touch, which is the behaviour pickup exists to prevent.
 */
export class TakeoverTracker {
  private readonly states = new Map<string, TakeoverState>();

  constructor(private mode: TakeoverMode = "pickup") {}

  setMode(mode: TakeoverMode): void {
    this.mode = mode;
    // Changing mode re-arms everything. Carrying an `engaged` flag from
    // pickup into scale would skip the convergence the new mode is for.
    for (const s of this.states.values()) s.engaged = false;
  }

  get currentMode(): TakeoverMode {
    return this.mode;
  }

  /** Feed a controller value; returns the parameter's new value. */
  receive(key: string, value: number, incoming: number): TakeoverResult {
    const state = this.states.get(key) ?? { value, knob: null, engaged: false };
    state.value = value;

    const result = applyTakeover(this.mode, state, incoming);

    state.knob = incoming;
    state.engaged = result.engaged;
    state.value = result.value;
    this.states.set(key, state);

    return result;
  }

  /** The parameter moved by some other means; the knob must catch up again. */
  disengage(key: string): void {
    const s = this.states.get(key);
    if (s) s.engaged = false;
  }

  disengageAll(): void {
    for (const s of this.states.values()) s.engaged = false;
  }

  /** For the UI's ghost marker. */
  knobPosition(key: string): number | null {
    return this.states.get(key)?.knob ?? null;
  }

  isEngaged(key: string): boolean {
    return this.states.get(key)?.engaged ?? false;
  }

  forget(key: string): void {
    this.states.delete(key);
  }
}
