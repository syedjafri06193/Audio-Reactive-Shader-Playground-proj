/**
 * The render loop and its two clocks.
 *
 * There are two clocks in a browser audio application and they do not
 * agree:
 *
 *   - `AudioContext.currentTime` advances with the audio hardware. It is
 *     the clock the music is on, and the only correct one for anything
 *     musical — beat phase, synced LFOs, scheduling.
 *   - `performance.now()` advances with the system and is what rAF
 *     reports. It is the right clock for UI animation.
 *
 * They drift, by a few milliseconds per minute, because the audio device's
 * crystal is not the system crystal. Over a three-hour set that is seconds.
 * Using `performance.now()` for beat phase produces a visualisation that
 * starts on the beat and finishes visibly behind it.
 */

export interface FrameTiming {
  /** Seconds since the previous frame, clamped. */
  dt: number;
  /** `AudioContext.currentTime`: the musical clock. */
  audioTime: number;
  /** `performance.now()` in seconds: the UI clock. */
  uiTime: number;
  /** Monotonic frame counter. */
  frame: number;
  /** Unclamped dt, for the performance monitor. */
  rawDt: number;
}

/**
 * The largest dt the simulation will accept, in seconds.
 *
 * A hidden tab throttles `requestAnimationFrame` to roughly 1 Hz — or stops
 * it entirely — while the AudioContext keeps running. Coming back to a
 * foreground tab therefore delivers a frame with a dt of several seconds,
 * and anything integrating dt (a rotation, a feedback trail, a particle
 * system) jumps by that whole interval in one frame. The visible result is
 * a violent lurch on tab focus.
 *
 * 1/20 s means the worst case is a 50 ms step, which reads as a small hitch
 * rather than a jump. The cost is that genuinely slow frames run in slow
 * motion, which is the right trade: at 20 fps the animation is already
 * broken and slowing it down is less bad than tearing it apart.
 */
export const MAX_DT = 1 / 20;

export interface LoopOptions {
  /** Source of the musical clock. */
  audioTime: () => number;
  /** Called once per frame with the timing. */
  render: (t: FrameTiming) => void;
  /**
   * Called when the page is hidden. The loop keeps running (browsers
   * throttle rather than stop it, and stopping it ourselves would mean
   * missing the return), but a caller may want to skip expensive work.
   */
  onVisibilityChange?: (visible: boolean) => void;
}

export class RenderLoop {
  private handle: number | null = null;
  private lastUiMs = 0;
  private frame = 0;
  private running = false;
  private readonly visibilityHandler: () => void;

  constructor(private readonly options: LoopOptions) {
    this.visibilityHandler = () => {
      const visible = document.visibilityState === "visible";
      if (visible) {
        // Discard the elapsed time across the hidden period rather than
        // delivering it as one enormous dt. MAX_DT would clamp it anyway,
        // but resetting here also keeps the frame-time statistics honest —
        // otherwise the scaler sees a multi-second "frame".
        this.lastUiMs = performance.now();
      }
      this.options.onVisibilityChange?.(visible);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastUiMs = performance.now();

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  private readonly tick = (uiMs: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    const timing = computeTiming(uiMs, this.lastUiMs, this.options.audioTime(), this.frame++);
    this.lastUiMs = uiMs;

    try {
      this.options.render(timing);
    } catch (err) {
      // One thrown frame must not kill the loop. A shader that fails to
      // bind, a resource read during a context loss — the next frame is
      // very likely to work, and a dead rAF chain means a page that has to
      // be reloaded.
      console.error("render frame failed", err);
    }
  };
}

/**
 * Pure timing computation, separated so it can be tested without a browser.
 */
export function computeTiming(
  uiMs: number,
  lastUiMs: number,
  audioTime: number,
  frame: number,
): FrameTiming {
  const rawDt = Math.max(0, (uiMs - lastUiMs) / 1000);
  return {
    dt: Math.min(rawDt, MAX_DT),
    rawDt,
    audioTime,
    uiTime: uiMs / 1000,
    frame,
  };
}

/**
 * Measures the drift between the two clocks.
 *
 * Not used to correct anything — the audio clock is authoritative and there
 * is nothing to correct it against. It exists so that the diagnostics panel
 * can show the drift, because "the visuals slowly fall behind the music" is
 * otherwise an unfalsifiable complaint.
 */
export class ClockDrift {
  private audioStart: number | null = null;
  private uiStart = 0;

  sample(audioTime: number, uiTimeSeconds: number): number | null {
    if (this.audioStart === null) {
      this.audioStart = audioTime;
      this.uiStart = uiTimeSeconds;
      return null;
    }
    const audioElapsed = audioTime - this.audioStart;
    const uiElapsed = uiTimeSeconds - this.uiStart;
    // Positive means the UI clock is running ahead of the audio clock.
    return uiElapsed - audioElapsed;
  }

  reset(): void {
    this.audioStart = null;
  }
}
