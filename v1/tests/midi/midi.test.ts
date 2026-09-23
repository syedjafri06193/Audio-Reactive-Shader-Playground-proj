import { describe, expect, it } from "vitest";

import { MidiClock, parseMidi, type MidiMessage } from "../../src/midi/access.js";
import { MidiLearn, decodeRelative, findBinding, matches, type MidiBinding } from "../../src/midi/learn.js";
import { Slew, ccToUnit, highResToUnit, unitToCc } from "../../src/midi/slew.js";
import { TakeoverTracker, applyTakeover } from "../../src/midi/takeover.js";

function cc(number: number, value: number, extra: Partial<MidiMessage> = {}): MidiMessage {
  return { channel: 0, kind: "cc", number, value, portId: "p1", timeMs: 0, ...extra };
}

describe("ccToUnit", () => {
  it("reaches exactly 1.0 at CC 127", () => {
    // Dividing by 128 tops out at 0.992, so a knob turned fully clockwise
    // never quite reaches maximum — immediately obvious on a parameter
    // with a visible ceiling.
    expect(ccToUnit(127)).toBe(1);
    expect(ccToUnit(0)).toBe(0);
    expect(ccToUnit(64)).toBeCloseTo(0.504, 3);
  });

  it("clamps out-of-range input", () => {
    expect(ccToUnit(200)).toBe(1);
    expect(ccToUnit(-5)).toBe(0);
  });

  it("round-trips through unitToCc", () => {
    for (let v = 0; v <= 127; v++) expect(unitToCc(ccToUnit(v))).toBe(v);
  });
});

describe("highResToUnit", () => {
  it("decodes a 14-bit pair across the full range", () => {
    expect(highResToUnit(0, 0)).toBe(0);
    expect(highResToUnit(127, 127)).toBe(1);
    expect(highResToUnit(64, 0)).toBeCloseTo(0.5, 2);
  });

  it("gives finer resolution than 7-bit", () => {
    // The whole point: the values between two adjacent MSB steps.
    const a = highResToUnit(64, 0);
    const b = highResToUnit(64, 1);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(1 / 127);
  });
});

describe("Slew", () => {
  it("converges at the same rate regardless of frame rate", () => {
    // `1 - exp(-rate*dt)`. A fixed per-frame coefficient makes the same
    // knob feel twice as fast on a 120 Hz display.
    const run = (fps: number) => {
      const s = new Slew(0, 10);
      s.setTarget(1);
      const dt = 1 / fps;
      const frames = Math.round(0.5 * fps);
      let v = 0;
      for (let i = 0; i < frames; i++) v = s.update(dt);
      return v;
    };

    const analytic = 1 - Math.exp(-10 * 0.5);
    for (const fps of [30, 60, 120, 144]) {
      expect(run(fps), `${fps} fps`).toBeCloseTo(analytic, 9);
    }
  });

  it("approaches without overshooting", () => {
    const s = new Slew(0, 20);
    s.setTarget(1);
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      const v = s.update(1 / 60);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(prev).toBeCloseTo(1, 6);
  });

  it("jumps immediately at rate 0", () => {
    const s = new Slew(0, 0);
    s.setTarget(0.8);
    expect(s.update(1 / 60)).toBe(0.8);
  });

  it("resets without a ramp, for a preset load", () => {
    const s = new Slew(0, 5);
    s.setTarget(1);
    s.update(0.1);
    s.reset(0.25);
    expect(s.current).toBe(0.25);
    expect(s.goal).toBe(0.25);
    expect(s.settled).toBe(true);
  });

  it("removes the staircase from successive CC steps", () => {
    // 128 discrete positions is coarse enough to see on anything
    // geometric. Between two CC values the slew should emit many distinct
    // intermediate values.
    const s = new Slew(ccToUnit(60), 20);
    s.setTarget(ccToUnit(61));
    const seen = new Set<number>();
    for (let i = 0; i < 10; i++) seen.add(Number(s.update(1 / 60).toFixed(6)));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("parseMidi", () => {
  it("parses a control change", () => {
    const m = parseMidi(new Uint8Array([0xb2, 7, 100]), "p", 5)!;
    expect(m).toMatchObject({ kind: "cc", channel: 2, number: 7, value: 100, timeMs: 5 });
  });

  it("treats note-on with velocity 0 as note-off", () => {
    // Most controllers send it this way because it allows running status.
    // Treating it as a note-on leaves every key permanently held.
    expect(parseMidi(new Uint8Array([0x90, 60, 0]), "p", 0)!.kind).toBe("noteoff");
    expect(parseMidi(new Uint8Array([0x90, 60, 64]), "p", 0)!.kind).toBe("noteon");
    expect(parseMidi(new Uint8Array([0x80, 60, 64]), "p", 0)!.kind).toBe("noteoff");
  });

  it("assembles pitch bend from its two bytes", () => {
    expect(parseMidi(new Uint8Array([0xe0, 0, 64]), "p", 0)!.value).toBe(8192);
    expect(parseMidi(new Uint8Array([0xe0, 127, 127]), "p", 0)!.value).toBe(16383);
  });

  it("recognises real-time clock messages, which carry no channel", () => {
    // These can arrive *between* the bytes of another message, so they
    // must be handled before any channel decoding.
    expect(parseMidi(new Uint8Array([0xf8]), "p", 0)!.kind).toBe("clock");
    expect(parseMidi(new Uint8Array([0xfa]), "p", 0)!.kind).toBe("start");
    expect(parseMidi(new Uint8Array([0xfc]), "p", 0)!.kind).toBe("stop");
  });

  it("returns null for empty data", () => {
    expect(parseMidi(new Uint8Array([]), "p", 0)).toBeNull();
    expect(parseMidi(null, "p", 0)).toBeNull();
  });

  it("tolerates a short message", () => {
    expect(parseMidi(new Uint8Array([0xb0, 7]), "p", 0)!.value).toBe(0);
  });
});

describe("MidiClock", () => {
  it("reports nothing until a full quarter note of pulses", () => {
    const c = new MidiClock();
    for (let i = 0; i < 24; i++) expect(c.tick(i * 20.83)).toBeNull();
    expect(c.tick(24 * 20.83)).not.toBeNull();
  });

  it("derives the tempo from 24 pulses per quarter note", () => {
    const c = new MidiClock();
    const bpm = 120;
    const pulseMs = 60000 / bpm / 24;
    let out: number | null = null;
    for (let i = 0; i <= 24; i++) out = c.tick(i * pulseMs);
    expect(out).toBeCloseTo(120, 3);
  });

  it("averages over a whole quarter note rather than consecutive pulses", () => {
    // USB MIDI jitter between individual clocks is tens of milliseconds;
    // taken pairwise that implies tempos swinging by 30 bpm.
    const c = new MidiClock();
    const pulseMs = 60000 / 120 / 24;
    let out: number | null = null;
    for (let i = 0; i <= 24; i++) {
      const jitter = (i % 3) - 1; // ±1 ms of jitter
      out = c.tick(i * pulseMs + jitter);
    }
    expect(out).toBeCloseTo(120, 0);
  });

  it("tracks phase within the quarter note", () => {
    const c = new MidiClock();
    for (let i = 0; i < 12; i++) c.tick(i);
    expect(c.phase).toBeCloseTo(0.5, 6);
  });
});

describe("MidiLearn", () => {
  const start = () => {
    const l = new MidiLearn();
    l.start("uWarp", 0);
    return l;
  };

  it("does not bind the first message to arrive", () => {
    // Controllers emit traffic nobody touched: motorised faders settling,
    // aftertouch from the weight of the case, periodic keepalives.
    const l = start();
    expect(l.observe(cc(1, 64))).toBeNull();
    expect(l.isLearning).toBe(true);
  });

  it("ignores drift below the deliberate-movement threshold", () => {
    const l = start();
    // A fader settling: a few steps of movement, then still.
    for (const v of [64, 65, 64, 63, 64]) expect(l.observe(cc(1, v))).toBeNull();
    expect(l.isLearning).toBe(true);
  });

  it("never binds a control that only dithers, however long it dithers", () => {
    // Summed travel grows without bound here — a pad left alone for a
    // second out-scores a knob someone actually swept. Range does not.
    const l = start();
    for (let i = 0; i < 400; i++) expect(l.observe(cc(1, 64 + (i % 2), { timeMs: i * 10 }))).toBeNull();
    expect(l.isLearning).toBe(true);
    expect(l.ranked()[0].travel).toBeGreaterThan(100);
    expect(l.ranked()[0].range).toBe(1);
  });

  it("binds the control that moved most", () => {
    const l = start();
    let t = 0;
    // Noise on CC 1 while the user sweeps CC 7.
    for (let i = 0; i < 10; i++) l.observe(cc(1, 64 + (i % 2), { timeMs: (t += 10) }));

    let binding: MidiBinding | null = null;
    for (let v = 0; v <= 127 && !binding; v += 4) {
      binding = l.observe(cc(7, v, { timeMs: (t += 20) }));
    }

    expect(binding).not.toBeNull();
    expect(binding!.number).toBe(7);
    expect(binding!.target).toBe("uWarp");
  });

  it("still binds a knob swept up and brought back", () => {
    // The case summed travel was meant to handle. Range catches it too,
    // because the range is the extent of the sweep, not the net
    // displacement.
    const l = start();
    let t = 0;
    let binding: MidiBinding | null = null;
    for (const v of [64, 70, 76, 82, 76, 70, 64, 64, 64]) {
      binding = l.observe(cc(7, v, { timeMs: (t += 40) })) ?? binding;
    }
    expect(binding).not.toBeNull();
    expect(binding!.number).toBe(7);
  });

  it("waits when two controls move together rather than flipping a coin", () => {
    // A crossfader and its LED ring echo should not resolve differently
    // between attempts.
    const l = start();
    let t = 0;
    let binding: MidiBinding | null = null;
    for (let v = 0; v <= 127; v += 8) {
      t += 10;
      binding = l.observe(cc(7, v, { timeMs: t })) ?? binding;
      binding = l.observe(cc(8, v, { timeMs: t })) ?? binding;
    }
    expect(binding).toBeNull();
    expect(l.isLearning).toBe(true);
  });

  it("settles before deciding, so an interleaved rival is not missed", () => {
    // Messages interleave. Deciding on the first message to cross the
    // threshold binds whichever control happened to report first, which is
    // a coin flip rather than a measurement.
    const l = start();
    // One message each, CC 7 first, both having moved the same amount.
    l.observe(cc(7, 0, { timeMs: 0 }));
    l.observe(cc(8, 0, { timeMs: 1 }));
    expect(l.observe(cc(7, 40, { timeMs: 10 }))).toBeNull();
    expect(l.observe(cc(8, 40, { timeMs: 11 }))).toBeNull();
    // And once the window closes, the tie is still a tie.
    expect(l.observe(cc(7, 41, { timeMs: 300 }))).toBeNull();
    expect(l.isLearning).toBe(true);
  });

  it("binds a note on a single press", () => {
    // Asking someone to "move" a button to bind it makes no sense.
    const l = start();
    const b = l.observe({ channel: 0, kind: "noteon", number: 36, value: 100, portId: "p1", timeMs: 0 });
    expect(b).toMatchObject({ kind: "note", number: 36, target: "uWarp" });
    expect(l.isLearning).toBe(false);
  });

  it("ignores everything when not learning", () => {
    const l = new MidiLearn();
    for (let v = 0; v <= 127; v += 4) expect(l.observe(cc(7, v))).toBeNull();
  });

  it("times out instead of staying armed forever", () => {
    const l = start();
    expect(l.checkTimeout(5000)).toBe(false);
    expect(l.checkTimeout(9000)).toBe(true);
    expect(l.isLearning).toBe(false);
  });

  it("can be cancelled", () => {
    const l = start();
    l.observe(cc(7, 0));
    l.cancel();
    expect(l.isLearning).toBe(false);
    expect(l.ranked()).toHaveLength(0);
  });

  it("keeps candidates on separate channels and ports apart", () => {
    const l = start();
    let t = 0;
    let binding: MidiBinding | null = null;
    for (let v = 0; v <= 127; v += 8) {
      binding = l.observe(cc(7, v, { portId: "p2", channel: 3, timeMs: (t += 30) })) ?? binding;
    }
    expect(binding).toMatchObject({ portId: "p2", channel: 3, number: 7 });
  });
});

describe("decodeRelative", () => {
  it("decodes two's-complement encoders", () => {
    expect(decodeRelative(1)).toBe(1);
    expect(decodeRelative(127)).toBe(-1);
    expect(decodeRelative(3)).toBe(3);
    expect(decodeRelative(64)).toBe(0);
  });

  it("decodes signed-bit encoders, which are the inverse", () => {
    expect(decodeRelative(65, "signed-bit")).toBe(1);
    expect(decodeRelative(1, "signed-bit")).toBe(-1);
  });
});

describe("binding lookup", () => {
  const bindings: MidiBinding[] = [
    { target: "uWarp", portId: "p1", channel: 0, number: 7, kind: "cc" },
    { target: "uGain", portId: "p1", channel: 1, number: 7, kind: "cc" },
    { target: "uFlash", portId: "p1", channel: 0, number: 36, kind: "note" },
  ];

  it("distinguishes the same CC number on different channels", () => {
    expect(findBinding(bindings, cc(7, 10))!.target).toBe("uWarp");
    expect(findBinding(bindings, cc(7, 10, { channel: 1 }))!.target).toBe("uGain");
  });

  it("does not match across ports", () => {
    expect(findBinding(bindings, cc(7, 10, { portId: "other" }))).toBeNull();
  });

  it("matches both note-on and note-off for a note binding", () => {
    const on = { channel: 0, kind: "noteon" as const, number: 36, value: 1, portId: "p1", timeMs: 0 };
    const off = { ...on, kind: "noteoff" as const };
    expect(matches(bindings[2], on)).toBe(true);
    expect(matches(bindings[2], off)).toBe(true);
  });

  it("matches the LSB controller of a 14-bit pair", () => {
    const hires: MidiBinding = { target: "u", portId: "p1", channel: 0, number: 7, lsbNumber: 39, kind: "cc" };
    expect(matches(hires, cc(39, 1))).toBe(true);
  });
});

describe("takeover: jump", () => {
  it("snaps to the knob immediately", () => {
    const r = applyTakeover("jump", { value: 0.9, knob: null, engaged: false }, 0.1);
    expect(r.value).toBe(0.1);
    expect(r.engaged).toBe(true);
  });
});

describe("takeover: pickup", () => {
  it("does nothing until the knob reaches the value", () => {
    // The default for live use: nothing moves until the performer means
    // it.
    const t = new TakeoverTracker("pickup");
    const r = t.receive("uWarp", 0.9, 0.1);
    expect(r.value).toBe(0.9);
    expect(r.engaged).toBe(false);
    expect(r.distance).toBeCloseTo(0.8, 6);
  });

  it("engages when the knob arrives at the value", () => {
    const t = new TakeoverTracker("pickup");
    t.receive("uWarp", 0.5, 0.1);
    const r = t.receive("uWarp", 0.5, 0.5);
    expect(r.engaged).toBe(true);
    expect(r.value).toBeCloseTo(0.5, 6);
  });

  it("engages when a fast turn steps straight past the value", () => {
    // Turning a knob quickly sends sparse CC values, so it can jump from
    // below the parameter to above it without ever landing inside the
    // tolerance window — and the performer, who watched the knob pass the
    // marker, would be left with a dead control.
    const t = new TakeoverTracker("pickup");
    t.receive("uWarp", 0.5, 0.2);
    const r = t.receive("uWarp", 0.5, 0.8);
    expect(r.engaged).toBe(true);
    expect(r.value).toBeCloseTo(0.8, 6);
  });

  it("follows the knob once engaged", () => {
    const t = new TakeoverTracker("pickup");
    t.receive("uWarp", 0.5, 0.5);
    expect(t.receive("uWarp", 0.5, 0.9).value).toBeCloseTo(0.9, 6);
  });

  it("re-arms when the parameter is changed by something else", () => {
    // The bug this prevents: the knob stays engaged from a previous
    // session and jumps the parameter on first touch, which is exactly
    // what pickup exists to stop.
    const t = new TakeoverTracker("pickup");
    t.receive("uWarp", 0.5, 0.5);
    expect(t.isEngaged("uWarp")).toBe(true);

    t.disengage("uWarp"); // a preset load
    const r = t.receive("uWarp", 0.2, 0.9);
    expect(r.engaged).toBe(false);
    expect(r.value).toBe(0.2);
  });

  it("reports the distance so the UI can show which way to turn", () => {
    const t = new TakeoverTracker("pickup");
    const r = t.receive("uWarp", 0.8, 0.2);
    expect(r.distance).toBeCloseTo(0.6, 6);
    expect(t.knobPosition("uWarp")).toBeCloseTo(0.2, 6);
  });

  it("tolerates a couple of CC steps rather than demanding an exact hit", () => {
    // One step is too tight: a slightly noisy controller can step over a
    // single-value window without ever landing in it.
    const t = new TakeoverTracker("pickup");
    t.receive("uWarp", 0.5, 0.3);
    const r = t.receive("uWarp", 0.5, 0.5 + 1 / 127);
    expect(r.engaged).toBe(true);
  });
});

describe("takeover: scale", () => {
  it("moves the parameter proportionally on the first real movement", () => {
    const t = new TakeoverTracker("scale");
    t.receive("uWarp", 0.9, 0.1); // first message only records the position
    const r = t.receive("uWarp", 0.9, 0.2);
    expect(r.value).toBeGreaterThan(0.9);
    expect(r.value).toBeLessThanOrEqual(1);
  });

  it("never jumps and never sits dead", () => {
    // The compromise the mode exists for.
    const t = new TakeoverTracker("scale");
    let value = 0.9;
    t.receive("uWarp", value, 0.1);

    const steps: number[] = [];
    for (let knob = 0.1; knob <= 1.0001; knob += 0.1) {
      const r = t.receive("uWarp", value, knob);
      steps.push(Math.abs(r.value - value));
      value = r.value;
    }

    expect(Math.max(...steps)).toBeLessThan(0.3); // no jump
    expect(steps.filter((s) => s > 1e-6).length).toBeGreaterThan(5); // never dead
  });

  it("converges so the knob and the value reach the top together", () => {
    const t = new TakeoverTracker("scale");
    let value = 0.4;
    t.receive("uWarp", value, 0.2);
    for (let knob = 0.2; knob <= 1.0001; knob += 0.05) {
      value = t.receive("uWarp", value, Math.min(1, knob)).value;
    }
    expect(value).toBeCloseTo(1, 2);
  });

  it("does not move on the very first message", () => {
    // There is no previous position to measure movement from.
    const t = new TakeoverTracker("scale");
    expect(t.receive("uWarp", 0.7, 0.1).value).toBe(0.7);
  });
});

describe("TakeoverTracker", () => {
  it("re-arms everything when the mode changes", () => {
    // Carrying an engaged flag from pickup into scale would skip the
    // convergence the new mode is for.
    const t = new TakeoverTracker("pickup");
    t.receive("uWarp", 0.5, 0.5);
    expect(t.isEngaged("uWarp")).toBe(true);
    t.setMode("scale");
    expect(t.isEngaged("uWarp")).toBe(false);
  });

  it("keeps separate state per binding", () => {
    const t = new TakeoverTracker("pickup");
    t.receive("a", 0.5, 0.5);
    t.receive("b", 0.5, 0.1);
    expect(t.isEngaged("a")).toBe(true);
    expect(t.isEngaged("b")).toBe(false);
  });

  it("forgets a binding on request", () => {
    const t = new TakeoverTracker("pickup");
    t.receive("a", 0.5, 0.5);
    t.forget("a");
    expect(t.knobPosition("a")).toBeNull();
  });
});
