/**
 * Web MIDI access, designed around its absence.
 *
 * Web MIDI does not exist in Safari — not disabled, not behind a flag,
 * absent. It is also unavailable in any non-secure context and in most
 * embedded webviews. That is a large fraction of the people who will open
 * this page.
 *
 * The consequence is a design rule rather than a code detail: **MIDI is an
 * enhancement, never a requirement.** Every parameter is reachable from the
 * UI, and the MIDI panel explains what is missing and why rather than
 * showing a dead "connect" button. A user on Safari should see a tool that
 * works, not a tool that is broken.
 */

export type MidiStatus = "unavailable" | "denied" | "ready" | "pending" | "error";

export interface MidiAvailability {
  status: MidiStatus;
  /** One sentence the UI can show verbatim. */
  reason: string;
  /** Whether trying again could plausibly work. */
  retryable: boolean;
}

export interface MidiMessage {
  /** 0–15. */
  channel: number;
  /** "cc", "noteon", "noteoff", "pitchbend", "clock", "start", "stop", "other". */
  kind: "cc" | "noteon" | "noteoff" | "pitchbend" | "clock" | "start" | "stop" | "other";
  /** Controller number, note number, or 0. */
  number: number;
  /** 0–127, or 0–16383 for pitch bend. */
  value: number;
  /** The port the message arrived on. */
  portId: string;
  /** `performance.now()`-based timestamp from the MIDI event. */
  timeMs: number;
}

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
}

/**
 * Why MIDI is not available, in terms a user can act on.
 *
 * Checked before requesting access, so the UI can explain the situation
 * without provoking a permission prompt that cannot succeed.
 */
export function checkMidiAvailability(): MidiAvailability {
  if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
    // Distinguish the common causes, because the remedies differ entirely.
    const insecure =
      typeof window !== "undefined" &&
      typeof location !== "undefined" &&
      location.protocol !== "https:" &&
      location.hostname !== "localhost" &&
      location.hostname !== "127.0.0.1";

    if (insecure) {
      return {
        status: "unavailable",
        reason:
          "Web MIDI needs a secure context. Open this page over https:// or on localhost and MIDI controllers will appear.",
        retryable: true,
      };
    }

    return {
      status: "unavailable",
      reason:
        "This browser does not support Web MIDI. Safari has never implemented it; Chrome, Edge and Opera do. Every control is still available in the panel on the left.",
      retryable: false,
    };
  }

  return { status: "pending", reason: "Ready to request access.", retryable: true };
}

type Listener = (m: MidiMessage) => void;

export class MidiAccess {
  private access: MIDIAccess | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly portListeners = new Set<(ports: MidiPortInfo[]) => void>();
  private availability: MidiAvailability = checkMidiAvailability();

  get status(): MidiAvailability {
    return this.availability;
  }

  /**
   * Request access.
   *
   * `sysex: false` deliberately. Sysex triggers a more alarming permission
   * prompt and is needed only for controller-specific feature sets that
   * this does not use; asking for it would cost real users who decline.
   */
  async request(): Promise<MidiAvailability> {
    const pre = checkMidiAvailability();
    if (pre.status === "unavailable") {
      this.availability = pre;
      return pre;
    }

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.attach();
      this.availability = {
        status: "ready",
        reason: `${this.ports().length} input(s) connected.`,
        retryable: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A denied permission and a failed one look the same to the caller
      // but not to the user: one is recoverable by clicking the lock icon,
      // the other is not recoverable at all.
      const denied = /denied|NotAllowed/i.test(message);
      this.availability = {
        status: denied ? "denied" : "error",
        reason: denied
          ? "MIDI access was denied. Allow it from the site permissions in the address bar to use a controller."
          : `MIDI could not be started: ${message}`,
        retryable: true,
      };
    }

    return this.availability;
  }

  private attach(): void {
    const access = this.access;
    if (!access) return;

    for (const input of access.inputs.values()) {
      input.onmidimessage = (e: MIDIMessageEvent) => this.dispatch(input.id, e);
    }

    // Controllers are plugged in and unplugged mid-session constantly, and
    // a USB hub can drop and re-enumerate a device on its own. Without
    // this, a controller unplugged and replugged is silently dead.
    access.onstatechange = () => {
      for (const input of access.inputs.values()) {
        if (!input.onmidimessage) {
          input.onmidimessage = (e: MIDIMessageEvent) => this.dispatch(input.id, e);
        }
      }
      const ports = this.ports();
      for (const fn of this.portListeners) fn(ports);
    };
  }

  private dispatch(portId: string, e: MIDIMessageEvent): void {
    const parsed = parseMidi(e.data, portId, e.timeStamp);
    if (!parsed) return;
    for (const fn of this.listeners) fn(parsed);
  }

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onPortsChanged(fn: (ports: MidiPortInfo[]) => void): () => void {
    this.portListeners.add(fn);
    return () => this.portListeners.delete(fn);
  }

  ports(): MidiPortInfo[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((i) => ({
      id: i.id,
      name: i.name ?? "Unnamed",
      manufacturer: i.manufacturer ?? "",
    }));
  }

  dispose(): void {
    if (this.access) {
      for (const input of this.access.inputs.values()) input.onmidimessage = null;
      this.access.onstatechange = null;
    }
    this.listeners.clear();
    this.portListeners.clear();
    this.access = null;
  }
}

/**
 * Parse a raw MIDI byte triple.
 *
 * Exported because it is the part worth testing without a browser, and
 * because the note-on-with-velocity-0 rule below is the kind of thing that
 * is easy to get wrong and hard to notice.
 */
export function parseMidi(
  data: Uint8Array | number[] | null,
  portId: string,
  timeMs: number,
): MidiMessage | null {
  if (!data || data.length === 0) return null;

  const statusByte = data[0];

  // System real-time messages (0xF8–0xFF) carry no channel and can appear
  // *between* the bytes of another message.
  if (statusByte >= 0xf8) {
    const kind = statusByte === 0xf8 ? "clock" : statusByte === 0xfa ? "start" : statusByte === 0xfc ? "stop" : "other";
    return { channel: 0, kind, number: 0, value: 0, portId, timeMs };
  }

  const type = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  switch (type) {
    case 0xb0:
      return { channel, kind: "cc", number: d1, value: d2, portId, timeMs };

    case 0x90:
      // A note-on with velocity 0 *is* a note-off. Most controllers send
      // it that way because it allows running status, and treating it as a
      // note-on means every key appears permanently held down.
      return {
        channel,
        kind: d2 === 0 ? "noteoff" : "noteon",
        number: d1,
        value: d2,
        portId,
        timeMs,
      };

    case 0x80:
      return { channel, kind: "noteoff", number: d1, value: d2, portId, timeMs };

    case 0xe0:
      return { channel, kind: "pitchbend", number: 0, value: (d2 << 7) | d1, portId, timeMs };

    default:
      return { channel, kind: "other", number: d1, value: d2, portId, timeMs };
  }
}

/**
 * MIDI clock: 24 pulses per quarter note.
 *
 * Averaged over a bar rather than taken from consecutive pulses. USB MIDI
 * jitter between individual clocks is tens of milliseconds, which taken
 * pairwise implies tempos swinging by 30 bpm; over 24 pulses it averages
 * out to something stable enough to drive a synced LFO.
 */
export class MidiClock {
  private times: number[] = [];
  private pulse = 0;

  /** @returns the tempo in bpm once enough pulses have arrived. */
  tick(timeMs: number): number | null {
    this.pulse++;
    this.times.push(timeMs);
    if (this.times.length > 25) this.times.shift();
    if (this.times.length < 25) return null;

    const span = this.times[this.times.length - 1] - this.times[0];
    if (span <= 0) return null;
    // 24 pulses = one quarter note.
    return 60000 / span;
  }

  reset(): void {
    this.times = [];
    this.pulse = 0;
  }

  /** 0–1 within the current quarter note. */
  get phase(): number {
    return (this.pulse % 24) / 24;
  }
}
