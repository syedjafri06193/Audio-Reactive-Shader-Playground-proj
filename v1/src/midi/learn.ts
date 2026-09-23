/**
 * MIDI learn: binding a physical control by moving it.
 *
 * The naive implementation — bind the first CC that arrives — fails on real
 * hardware for a reason that is obvious in hindsight. Controllers emit
 * traffic nobody touched: motorised faders settle, a jog wheel drifts, a
 * pressure-sensitive pad sends aftertouch from the weight of the case,
 * some devices send periodic CC as a keepalive. The first message to arrive
 * during a learn is very often not the control the user moved.
 *
 * So learn watches for a few seconds and binds the control that moved
 * *most*, which is unambiguous the moment someone actually turns something.
 */

import type { MidiMessage } from "./access.ts";

export interface MidiBinding {
  /** Parameter name this control drives. */
  target: string;
  portId: string;
  channel: number;
  /** CC number, or note number for a note binding. */
  number: number;
  kind: "cc" | "note" | "pitchbend";
  /** Relative encoders send deltas, not positions. */
  relative?: boolean;
  /** Set when a controller sends a 14-bit pair; the LSB controller number. */
  lsbNumber?: number;
}

export interface LearnCandidate {
  key: string;
  message: MidiMessage;
  /** max - min over the learn window: the score bindings are ranked by. */
  range: number;
  /** Summed absolute movement. Diagnostic, and used to spot relative encoders. */
  travel: number;
  /** How many messages this control sent. */
  count: number;
  min: number;
  max: number;
}

/**
 * How far a control must range to count as deliberate.
 *
 * Eight CC steps out of 127. Below that is drift, noise, or a fader
 * settling; above it is a hand.
 *
 * Note that this is measured as `max - min`, not as summed travel. Summed
 * travel is the tempting metric and it is wrong: a control dithering by one
 * step accumulates unlimited travel just by sitting there, so a noisy
 * pressure pad left alone for a second out-scores a knob the user actually
 * swept. Range is immune to that — dither has a range of 1 no matter how
 * long it runs — while still catching the case summed travel was meant to
 * handle, a knob swept up and brought back, whose range is the full extent
 * of the sweep.
 */
const MIN_RANGE = 8;

/**
 * How long to keep listening after something first crosses the threshold.
 *
 * Binding the instant a control crosses `MIN_RANGE` looks correct and is
 * not, because MIDI messages interleave: when two controls move together,
 * whichever one happens to report first crosses the threshold a message
 * before its rival, and the tie-break below never sees a rival to compare
 * against. A short settle window lets every control that is moving get its
 * messages in, so the comparison is made on equal evidence.
 *
 * 150 ms is long enough to collect several messages from every moving
 * control (controllers send tens per second) and short enough that the
 * binding still feels instant.
 */
const SETTLE_MS = 150;

/** A note or a button has no travel to measure, so it binds on a single press. */
const NOTE_KINDS = new Set(["noteon"]);

export class MidiLearn {
  private candidates = new Map<string, LearnCandidate>();
  private target: string | null = null;
  private startedAt = 0;
  /** When something first crossed MIN_RANGE, starting the settle window. */
  private armedAt: number | null = null;

  /** Begin learning for a parameter. */
  start(target: string, nowMs: number): void {
    this.target = target;
    this.candidates.clear();
    this.startedAt = nowMs;
    this.armedAt = null;
  }

  get isLearning(): boolean {
    return this.target !== null;
  }

  get learningTarget(): string | null {
    return this.target;
  }

  cancel(): void {
    this.target = null;
    this.candidates.clear();
    this.armedAt = null;
  }

  /**
   * Feed a message during a learn.
   *
   * @returns a binding once one is unambiguous, otherwise null.
   */
  observe(m: MidiMessage): MidiBinding | null {
    if (!this.target) return null;

    // A note binds immediately: a button press is unambiguous, and asking
    // someone to "move" a button to bind it makes no sense.
    if (NOTE_KINDS.has(m.kind)) {
      const binding: MidiBinding = {
        target: this.target,
        portId: m.portId,
        channel: m.channel,
        number: m.number,
        kind: "note",
      };
      this.cancel();
      return binding;
    }

    if (m.kind !== "cc" && m.kind !== "pitchbend") return null;

    const key = `${m.portId}:${m.channel}:${m.kind}:${m.number}`;
    let c = this.candidates.get(key);
    if (!c) {
      c = { key, message: m, range: 0, travel: 0, count: 0, min: m.value, max: m.value };
      this.candidates.set(key, c);
    } else {
      c.travel += Math.abs(m.value - c.message.value);
      c.message = m;
      c.min = Math.min(c.min, m.value);
      c.max = Math.max(c.max, m.value);
      c.range = c.max - c.min;
    }
    c.count++;

    return this.decide(m.timeMs);
  }

  /**
   * Decide whether anything has moved enough to bind.
   *
   * Requires the winner to have moved clearly more than the runner-up, not
   * merely to have crossed the threshold. Two controls moving together —
   * a crossfader and its LED ring echo, say — should not resolve to a coin
   * flip that differs between attempts.
   */
  private decide(nowMs: number): MidiBinding | null {
    const ranked = [...this.candidates.values()].sort((a, b) => b.range - a.range);
    const best = ranked[0];
    if (!best || best.range < MIN_RANGE) return null;

    // Start the settle window the first time anything qualifies, and keep
    // collecting until it closes.
    if (this.armedAt === null) this.armedAt = nowMs;
    if (nowMs - this.armedAt < SETTLE_MS) return null;

    const runnerUp = ranked[1];
    if (runnerUp && best.range < runnerUp.range * 2) return null;

    const m = best.message;
    const binding: MidiBinding = {
      target: this.target!,
      portId: m.portId,
      channel: m.channel,
      number: m.number,
      kind: m.kind === "pitchbend" ? "pitchbend" : "cc",
      relative: looksRelative(best),
    };
    this.cancel();
    return binding;
  }

  /** Candidates so far, for a UI that shows what it is hearing. */
  ranked(): LearnCandidate[] {
    return [...this.candidates.values()].sort((a, b) => b.range - a.range);
  }

  /** Give up after a timeout, so a learn does not stay armed forever. */
  checkTimeout(nowMs: number, timeoutMs = 8000): boolean {
    if (this.target && nowMs - this.startedAt > timeoutMs) {
      this.cancel();
      return true;
    }
    return false;
  }
}

/**
 * Detect an endless (relative) encoder.
 *
 * These send a small delta rather than an absolute position — typically
 * 1 or 65 for one click in each direction, depending on the encoding. The
 * signature is that every value sits in one of two tight clusters near 0
 * and 127 while the control is clearly being turned a lot. Treating one as
 * an absolute control makes the parameter flick between its extremes.
 */
function looksRelative(c: LearnCandidate): boolean {
  if (c.count < 6) return false;
  const nearEnds = c.min <= 4 && c.max >= 123;
  return nearEnds && c.travel > 120 * 2;
}

/**
 * Decode a relative encoder's value into a delta.
 *
 * Two encodings are common and they are mutually exclusive, so the caller
 * picks. "twos-complement" (1..63 up, 65..127 down) is the more common;
 * "signed-bit" (65..127 up, 1..63 down) is the inverse and appears on
 * several popular controllers.
 */
export function decodeRelative(value: number, encoding: "twos-complement" | "signed-bit" = "twos-complement"): number {
  if (value === 0 || value === 64) return 0;
  if (encoding === "twos-complement") {
    return value < 64 ? value : value - 128;
  }
  return value > 64 ? value - 64 : -value;
}

/** Whether a message matches a binding. */
export function matches(binding: MidiBinding, m: MidiMessage): boolean {
  if (binding.portId !== m.portId || binding.channel !== m.channel) return false;
  switch (binding.kind) {
    case "cc":
      return m.kind === "cc" && (m.number === binding.number || m.number === binding.lsbNumber);
    case "note":
      return (m.kind === "noteon" || m.kind === "noteoff") && m.number === binding.number;
    case "pitchbend":
      return m.kind === "pitchbend";
  }
}

/**
 * Find a binding for a message.
 *
 * Linear over the binding list, which is fine: a large setup has a few
 * dozen bindings and messages arrive at a few hundred per second at most.
 * An index keyed on port+channel+number would be faster and would need
 * invalidating on every rebind, which is a worse trade at this scale.
 */
export function findBinding(bindings: MidiBinding[], m: MidiMessage): MidiBinding | null {
  for (const b of bindings) if (matches(b, m)) return b;
  return null;
}
