#version 300 es
// ---------------------------------------------------------------------------
// Audio-Reactive Shader Playground — fragment prelude
//
// Everything above the user's code. Changing the number of lines here changes
// the offset compiler errors are mapped by, so PRELUDE_LINES in
// src/shaders/index.ts is derived from this file rather than hard-coded.
//
// Uniform naming follows Shadertoy (iResolution, iTime, iMouse) so that the
// enormous body of existing shaders pastes in and works. The audio uniforms
// use a `u` prefix because they have no Shadertoy equivalent, and mixing the
// conventions is clearer than inventing an `iBass` that looks like it should
// be standard and is not.
// ---------------------------------------------------------------------------

precision highp float;
precision highp int;

// --- Shadertoy-compatible ---------------------------------------------------

/** Viewport size in pixels. z is the aspect ratio, as Shadertoy defines it. */
uniform vec3  iResolution;
/** Seconds since start, on the AudioContext clock. */
uniform float iTime;
/** Seconds since the previous frame, clamped to 1/20 to survive a hidden tab. */
uniform float iTimeDelta;
/** Frame counter. */
uniform int   iFrame;
/** xy: current position. zw: click position, negative while the button is up. */
uniform vec4  iMouse;
/** Previous frame, for feedback effects. */
uniform sampler2D iChannel0;

// --- Audio ------------------------------------------------------------------
// All 0–1 unless noted. A shader author should never need to know the sample
// rate to use one of these.

/** 20–60 Hz. Kick fundamentals and sub-bass. */
uniform float uSub;
/** 60–250 Hz. Bass notes; the band most people mean by "the bass". */
uniform float uBass;
/** 250–500 Hz. */
uniform float uLowMid;
/** 500–2000 Hz. Most of the vocal range. */
uniform float uMid;
/** 2000–4000 Hz. Presence and attack. */
uniform float uHighMid;
/** 4000–16000 Hz. Cymbals, air, sibilance. */
uniform float uTreble;

/** Overall loudness (RMS). */
uniform float uLevel;
/** Peak sample magnitude this frame. 1.0 means the input is clipping. */
uniform float uPeak;

/**
 * Spectral centroid, normalised on a log scale between 100 Hz and 8 kHz.
 * Tracks *timbre*, not volume: it rises when a sound gets brighter even if it
 * gets quieter. Excellent for driving colour, poor for driving scale.
 */
uniform float uCentroid;

/** Spectral flux, energy-normalised. How much the spectrum is changing. */
uniform float uFlux;

/**
 * Onset envelope: snaps to 1 on a detected transient and decays smoothly.
 *
 * Deliberately not a boolean. A boolean would be true for one frame — 16 ms,
 * below the threshold at which anyone perceives it — so every shader author
 * would write their own decay, and most would write a frame-rate dependent
 * one. Doing it once here means every shader gets a usable envelope free.
 */
uniform float uOnset;

/** Detected tempo, or 0 while the tracker has not locked. */
uniform float uBpm;
/** 0–1 within the current beat. Wraps; use fract-friendly maths. */
uniform float uBeatPhase;
/** How much to trust uBpm and uBeatPhase, 0–1. */
uniform float uBeatConfidence;

/**
 * Log-banded spectrum, 0–1 per band, low to high.
 *
 * Log-spaced, not the raw linear FFT bins. At fftSize 2048 and 48 kHz the
 * linear bins give 20–250 Hz about 1% of the array and 6–24 kHz about 75% —
 * the exact inverse of how hearing works, and the reason a naive spectrum
 * visualiser looks dead at the left and frantic at the right.
 */
uniform float uSpectrum[SPECTRUM_BANDS];

// --- Output -----------------------------------------------------------------

in  vec2 vUv;
out vec4 fragColor;

// --- Helpers ----------------------------------------------------------------

#define PI  3.14159265359
#define TAU 6.28318530718

/** Read the banded spectrum at a normalised position, with interpolation. */
float spectrum(float x) {
  float f = clamp(x, 0.0, 1.0) * float(SPECTRUM_BANDS - 1);
  int   i = int(floor(f));
  int   j = min(i + 1, SPECTRUM_BANDS - 1);
  return mix(uSpectrum[i], uSpectrum[j], fract(f));
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

/**
 * HSV to RGB. Included because the alternative is every shader pasting its
 * own copy, and half of them get the sector arithmetic subtly wrong.
 */
vec3 hsv(float h, float s, float v) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return v - v * s * clamp(min(k, 4.0 - k), 0.0, 1.0);
}

/** Cheap hash. Not for cryptography, and not stable across drivers. */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0, 0)), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

/** Pixel coordinates, as Shadertoy's fragCoord. */
vec2 fragCoord() { return vUv * iResolution.xy; }

/** Aspect-corrected coordinates centred on the screen, y in [-1, 1]. */
vec2 uvCentered() {
  vec2 p = vUv * 2.0 - 1.0;
  p.x *= iResolution.z;
  return p;
}
