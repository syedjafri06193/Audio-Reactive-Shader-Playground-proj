/**
 * Smoothing 7-bit MIDI control values.
 *
 * A MIDI CC carries 0–127. Mapped onto a parameter that visibly affects
 * geometry, each step is a jump, and turning a knob produces a staircase
 * rather than a sweep — 128 discrete positions is coarse enough to see.
 *
 * The fix is to smooth between received values. The trap is to smooth
 * *per frame*, which makes the response rate depend on the display refresh
 * rate: the same knob feels twice as fast on a 120 Hz monitor as on a
 * 60 Hz one, and a dropped frame changes the feel.
 */

/**
 * Exponential slew toward a target.
 *
 * `1 - exp(-rate * dt)` is the frame-rate independent form. The naive
 * `value += (target - value) * 0.1` is the same filter only when dt is
 * constant, and dt is never constant.
 */
export class Slew {
  private value: number;
  private target: number;

  /**
   * @param rate per-second convergence rate. Larger is faster; 20 is
   *   roughly a 50 ms response, which is about the fastest that still
   *   removes the staircase.
   */
  constructor(initial = 0, private rate = 20) {
    this.value = initial;
    this.target = initial;
  }

  setTarget(v: number): void {
    this.target = v;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  /** Jump immediately, e.g. when loading a preset. */
  reset(v: number): void {
    this.value = v;
    this.target = v;
  }

  update(dt: number): number {
    if (this.rate <= 0 || dt <= 0) {
      this.value = this.target;
      return this.value;
    }
    this.value += (this.target - this.value) * (1 - Math.exp(-this.rate * dt));
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  get goal(): number {
    return this.target;
  }

  /** Within a quantum of the target — useful for stopping redundant uploads. */
  get settled(): boolean {
    return Math.abs(this.target - this.value) < 1e-4;
  }
}

/**
 * Map a 7-bit CC value to 0–1.
 *
 * Divides by 127, not 128, so that a CC of 127 reaches exactly 1.0. The
 * /128 version tops out at 0.992, which means a knob turned fully clockwise
 * never quite reaches maximum — a small thing that is immediately obvious
 * on a parameter with a visible ceiling.
 */
export function ccToUnit(cc: number): number {
  return Math.min(127, Math.max(0, cc)) / 127;
}

/** The inverse, for sending values back to a motorised or LED controller. */
export function unitToCc(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 127);
}

/**
 * Decode a 14-bit CC pair (MSB on controller n, LSB on n+32).
 *
 * Few controllers send these, but the ones that do are precisely the ones
 * people use for fine parameter control, and treating the LSB as a separate
 * parameter — which is what happens without this — produces a second,
 * mysterious knob that jitters.
 */
export function highResToUnit(msb: number, lsb: number): number {
  return ((msb << 7) | (lsb & 0x7f)) / 16383;
}
