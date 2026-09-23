/**
 * Audio sources, and the getUserMedia constraints that decide whether this
 * project works at all.
 */

/**
 * The constraints. All three defaults are actively harmful for music, and
 * almost nobody sets them.
 *
 * | Constraint         | Default | Effect on music                          |
 * |--------------------|---------|------------------------------------------|
 * | echoCancellation   | on      | adaptive filtering; cancels real signal  |
 * | noiseSuppression   | on      | treats sustained tones as noise          |
 * | autoGainControl    | on      | **flattens the dynamics you visualize**  |
 *
 * AGC is the worst of the three. It exists to make quiet speech audible and
 * loud speech bearable, which means it compresses exactly the loud/quiet
 * contrast that makes a visualizer feel alive. With AGC on, a track's
 * breakdown and its drop produce nearly the same numbers.
 */
export const MUSIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  // Ideal rather than exact: an `exact` constraint that a device cannot
  // satisfy fails the whole request with OverconstrainedError, and a user
  // whose interface runs at 44.1 kHz would simply get nothing.
  sampleRate: { ideal: 48_000 },
  channelCount: { ideal: 2 },
};

/** What actually applied, versus what was asked for. */
export interface ConstraintReport {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate?: number;
  channelCount?: number;
  /** Human-readable warnings for anything that could not be turned off. */
  warnings: string[];
}

/**
 * Check what the device actually did.
 *
 * Constraints are requests, not guarantees. Some devices and platforms —
 * notably several Android phones and some USB interfaces in communications
 * mode — force AGC on regardless. A user on such a device should be told
 * why their visuals feel flat rather than concluding the app is bad.
 */
export function inspectConstraints(track: MediaStreamTrack): ConstraintReport {
  const s = track.getSettings();
  const warnings: string[] = [];

  if (s.autoGainControl) {
    warnings.push(
      "Automatic gain control could not be disabled on this device. Dynamics " +
        "will be compressed, so quiet and loud passages will look more alike " +
        "than they sound.",
    );
  }
  if (s.noiseSuppression) {
    warnings.push(
      "Noise suppression could not be disabled. Sustained tones — pads, " +
        "drones, held notes — may be attenuated as if they were noise.",
    );
  }
  if (s.echoCancellation) {
    warnings.push(
      "Echo cancellation could not be disabled. Parts of the signal may be " +
        "filtered out.",
    );
  }

  return {
    echoCancellation: Boolean(s.echoCancellation),
    noiseSuppression: Boolean(s.noiseSuppression),
    autoGainControl: Boolean(s.autoGainControl),
    sampleRate: s.sampleRate,
    channelCount: s.channelCount,
    warnings,
  };
}

export type SourceKind = "microphone" | "file" | "display";

export interface AudioSource {
  kind: SourceKind;
  node: AudioNode;
  /** Non-null for microphone and display capture. */
  stream: MediaStream | null;
  /** Non-null when the app controls playback — see canAnalyzeAhead. */
  element: HTMLMediaElement | null;
  constraints: ConstraintReport | null;
  stop(): void;
}

/** Live input, with the constraints that matter. */
export async function openMicrophone(context: AudioContext): Promise<AudioSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: MUSIC_AUDIO_CONSTRAINTS,
    video: false,
  });

  const track = stream.getAudioTracks()[0];
  const constraints = track ? inspectConstraints(track) : null;

  const node = context.createMediaStreamSource(stream);

  return {
    kind: "microphone",
    node,
    stream,
    element: null,
    constraints,
    stop() {
      node.disconnect();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/**
 * A local file, played through an element.
 *
 * This path is worth having for more than convenience: because the app
 * controls the playhead, the analysis latency can in principle be
 * eliminated entirely by analysing ahead of playback (see canAnalyzeAhead).
 */
export function openFile(context: AudioContext, file: File | Blob): AudioSource {
  const element = new Audio();
  element.src = URL.createObjectURL(file);
  element.crossOrigin = "anonymous";
  element.loop = true;

  const node = context.createMediaElementSource(element);
  // Connect to the destination as well, or the file analyses silently: a
  // MediaElementSource routed only into an analyser produces no sound.
  node.connect(context.destination);

  return {
    kind: "file",
    node,
    stream: null,
    element,
    constraints: null,
    stop() {
      element.pause();
      node.disconnect();
      URL.revokeObjectURL(element.src);
    },
  };
}

/**
 * Tab or system audio via `getDisplayMedia`.
 *
 * Chromium only in practice, and only for tab or window capture with the
 * "share audio" checkbox ticked. The video track is requested because most
 * implementations refuse an audio-only display capture, and is stopped
 * immediately.
 */
export async function openDisplayAudio(context: AudioContext): Promise<AudioSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  for (const v of stream.getVideoTracks()) v.stop();

  const track = stream.getAudioTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error(
      "No audio track was shared. Tick “Share tab audio” in the picker — " +
        "and note that only tab and window capture can carry audio.",
    );
  }

  const node = context.createMediaStreamSource(stream);

  return {
    kind: "display",
    node,
    stream,
    element: null,
    constraints: inspectConstraints(track),
    stop() {
      node.disconnect();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/**
 * Whether this source could be analysed ahead of the playhead.
 *
 * The one case where the latency budget can actually be beaten: when the app
 * owns playback, the audio is known in advance, so the analysis can run
 * ahead and the visuals can be scheduled to land *with* the sound rather
 * than 60–150 ms behind it. Live input cannot benefit — there is no future
 * to read.
 */
export function canAnalyzeAhead(source: AudioSource): boolean {
  return source.kind === "file";
}
