/**
 * The built-in presets.
 *
 * Chosen to demonstrate different *analysis* features rather than different
 * visual styles — each one exists because it shows something about the
 * audio layer that the others do not. A library of five tunnel shaders
 * would look more impressive and teach nothing.
 */

import type { Preset } from "../morph.ts";

/**
 * Spectrum bars.
 *
 * The reference implementation, and the one that makes the log-banding
 * visible: the bars are evenly spaced across the screen but cover
 * exponentially wider frequency ranges, which is why the left end moves at
 * all. Rendered with the raw linear FFT bins, the left fifth of this
 * display would be almost static.
 */
const SPECTRUM_BARS = `
void main() {
  vec2 uv = vUv;

  float bands = float(SPECTRUM_BANDS);
  float band  = floor(uv.x * bands);
  float level = uSpectrum[int(band)];

  // Gap between bars, in screen space rather than band space so the gap is
  // the same width everywhere.
  float inBar = step(0.08, fract(uv.x * bands));
  float lit   = step(uv.y, level) * inBar;

  // Colour by frequency, brightness by level.
  vec3 col = hsv(0.6 - band / bands * 0.6, 0.85, 1.0) * lit;

  // A line at the spectral centroid: it tracks timbre, so it slides right
  // as a sound gets brighter even when nothing gets louder.
  col += vec3(1.0) * smoothstep(0.004, 0.0, abs(uv.x - uCentroid)) * 0.5;

  fragColor = vec4(col, 1.0);
}
`.trim();

/**
 * Onset pulse.
 *
 * Exists to show why `uOnset` is an envelope and not a boolean. The rings
 * are emitted on transients and decay smoothly; if the uniform were a
 * boolean the effect would be a single 16 ms flash that nobody would see.
 */
const ONSET_PULSE = `
void main() {
  vec2 p = uvCentered();
  float r = length(p);

  // Three rings at different rates, so a fast passage layers rather than
  // retriggering one ring.
  float rings = 0.0;
  for (int i = 0; i < 3; i++) {
    float phase = fract(iTime * (0.35 + float(i) * 0.18));
    float edge  = phase * 1.6;
    rings += smoothstep(0.06, 0.0, abs(r - edge)) * (1.0 - phase);
  }

  // The onset envelope drives brightness and a slight expansion.
  float hit = uOnset;
  vec3 col = hsv(0.55 + uCentroid * 0.35, 0.8, 1.0) * rings * (0.25 + hit * 2.0);

  // Centre flash on the transient itself.
  col += vec3(1.0, 0.95, 0.9) * smoothstep(0.35, 0.0, r) * hit * hit;

  fragColor = vec4(col, 1.0);
}
`.trim();

/**
 * Beat grid.
 *
 * The only preset that uses `uBeatPhase`, and it is deliberately honest
 * about confidence: the grid is faint until the tracker has locked, so a
 * wrong tempo reads as uncertainty rather than as the visualiser being out
 * of time.
 */
const BEAT_GRID = `
void main() {
  vec2 p = uvCentered();

  // Rotate a quarter turn per beat.
  p = rot(uBeatPhase * PI * 0.5) * p;

  vec2 g = abs(fract(p * 3.0) - 0.5);
  float line = smoothstep(0.03, 0.0, min(g.x, g.y));

  // Pulse on the beat, scaled by how much the tracker trusts itself.
  float pulse = pow(1.0 - uBeatPhase, 3.0) * uBeatConfidence;

  vec3 col = hsv(0.08 + uBass * 0.1, 0.7, 1.0) * line * (0.2 + pulse);
  col += vec3(0.9, 0.4, 0.2) * pulse * 0.3;

  // Dim the whole thing while unlocked, rather than showing a confident
  // grid at the wrong tempo.
  col *= mix(0.25, 1.0, uBeatConfidence);

  fragColor = vec4(col, 1.0);
}
`.trim();

/**
 * Band tunnel.
 *
 * Shows the separation between bands: bass drives the tunnel's width, mid
 * its twist, treble the sparkle. With a single amplitude value all three
 * would move together and the whole thing would just throb.
 */
const BAND_TUNNEL = `
void main() {
  vec2 p = uvCentered();
  float r = length(p);
  float a = atan(p.y, p.x);

  // Bass opens the tunnel; mid twists it.
  float radius = 0.35 + uBass * 0.45;
  float z = 1.0 / max(r, 1e-3) + iTime * 0.6;
  a += sin(z * 0.5 + iTime) * uMid * 1.5;

  float rings  = smoothstep(0.4, 0.6, fract(z * 0.5));
  float spokes = smoothstep(0.3, 0.7, fract(a / TAU * 12.0));

  vec3 col = hsv(fract(z * 0.05 + uCentroid * 0.3), 0.75, 1.0);
  col *= rings * spokes;
  col *= smoothstep(0.0, radius, r);

  // Treble as sparkle rather than as brightness, so cymbals read as
  // texture and not as the whole image getting louder.
  col += vec3(1.0) * uTreble * step(0.995, hash(floor(p * 220.0) + floor(iTime * 20.0)));

  fragColor = vec4(col * (0.3 + uLevel * 1.2), 1.0);
}
`.trim();

/**
 * Feedback trails.
 *
 * The only preset that reads `iChannel0`, and therefore the one that
 * justifies the ping-pong buffers and the half-float targets. At 8 bits
 * per channel the trail visibly bands after about thirty frames of decay.
 */
const FEEDBACK_TRAILS = `
void main() {
  vec2 uv = vUv;

  // Zoom and rotate what was there last frame.
  vec2 c = uv - 0.5;
  c = rot(0.004 + uMid * 0.02) * c * (0.995 - uBass * 0.01);
  vec3 prev = texture(iChannel0, c + 0.5).rgb;

  // Decay. Onsets briefly hold the trail rather than clearing it.
  prev *= 0.955 + uOnset * 0.035;

  // New material: a ring whose radius follows the bass.
  vec2 p = uvCentered();
  float r = length(p);
  float ring = smoothstep(0.02, 0.0, abs(r - (0.2 + uBass * 0.5)));

  vec3 add = hsv(fract(iTime * 0.05 + uCentroid * 0.5), 0.8, 1.0) * ring * (0.3 + uOnset);

  fragColor = vec4(prev + add, 1.0);
}
`.trim();

function preset(id: string, name: string, description: string, shader: string): Preset {
  return { id, name, description, shader, values: {}, author: "built-in" };
}

export const BUILT_IN_PRESETS: Preset[] = [
  preset(
    "spectrum-bars",
    "Spectrum Bars",
    "The reference display. Shows why bands are log-spaced: the left end moves at all.",
    SPECTRUM_BARS,
  ),
  preset(
    "onset-pulse",
    "Onset Pulse",
    "Why uOnset is a decaying envelope rather than a boolean.",
    ONSET_PULSE,
  ),
  preset(
    "beat-grid",
    "Beat Grid",
    "Beat phase, dimmed by tracker confidence so a wrong tempo reads as uncertainty.",
    BEAT_GRID,
  ),
  preset(
    "band-tunnel",
    "Band Tunnel",
    "Three bands driving three different properties, which a single level cannot do.",
    BAND_TUNNEL,
  ),
  preset(
    "feedback-trails",
    "Feedback Trails",
    "Reads the previous frame. Needs half-float targets or the decay bands visibly.",
    FEEDBACK_TRAILS,
  ),
];

export const DEFAULT_PRESET = BUILT_IN_PRESETS[0];
