/**
 * Assembling the fragment shader the compiler actually sees.
 *
 * The prelude is injected above the user's source, which means the
 * compiler's line numbers no longer match the editor's. The offset must be
 * *derived* from the prelude, never written down as a constant: someone
 * adding a uniform to prelude.glsl and forgetting to update a hard-coded 47
 * breaks every error message in the application, silently, and the symptom
 * — errors pointing a few lines off — looks like a driver quirk rather than
 * a bug.
 */

import preludeSource from "../../shaders/prelude.glsl?raw";

/**
 * How many log-spaced bands `uSpectrum` carries.
 *
 * 64 is a deliberate compromise. Fewer and a spectrum visualiser looks
 * chunky; more and the per-band mean is taken over so few bins at the low
 * end that it becomes noisy. It is substituted into the prelude at build
 * time because GLSL ES 3.00 requires a constant array size.
 */
export const SPECTRUM_BANDS = 64;

/** The prelude with its compile-time constants filled in. */
export function buildPrelude(bands = SPECTRUM_BANDS): string {
  return preludeSource.replace(/SPECTRUM_BANDS/g, String(bands));
}

/**
 * The number of lines the prelude occupies, counted rather than declared.
 *
 * The `+ 1` accounts for the newline joining the prelude to the user's
 * source: with `prelude + "\n" + user`, the user's line 1 is at absolute
 * line `preludeLineCount + 1`, so an error reported at absolute line N
 * belongs at user line `N - preludeLineCount`.
 */
export function preludeLineCount(prelude = buildPrelude()): number {
  return prelude.split("\n").length;
}

export interface AssembledShader {
  source: string;
  preludeLines: number;
}

export function assembleFragment(userSource: string, bands = SPECTRUM_BANDS): AssembledShader {
  const prelude = buildPrelude(bands);
  return {
    source: `${prelude}\n${userSource}`,
    preludeLines: preludeLineCount(prelude),
  };
}

/**
 * The uniforms the prelude declares, for the UI's reference panel and for
 * checking that a preset does not bind something that does not exist.
 */
export const AUDIO_UNIFORMS = [
  "uSub",
  "uBass",
  "uLowMid",
  "uMid",
  "uHighMid",
  "uTreble",
  "uLevel",
  "uPeak",
  "uCentroid",
  "uFlux",
  "uOnset",
  "uBpm",
  "uBeatPhase",
  "uBeatConfidence",
  "uSpectrum",
] as const;

export const SYSTEM_UNIFORMS = [
  "iResolution",
  "iTime",
  "iTimeDelta",
  "iFrame",
  "iMouse",
  "iChannel0",
] as const;

/** Names the prelude owns; a preset parameter may not shadow one. */
export const RESERVED_UNIFORMS = new Set<string>([...AUDIO_UNIFORMS, ...SYSTEM_UNIFORMS]);
