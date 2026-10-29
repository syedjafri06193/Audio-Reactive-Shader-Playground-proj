# Audio-Reactive Shader Playground — Design & Build Guide

**Project:** WebGL visualizer driven by live FFT analysis, with preset morphing, MIDI controller bindings, and hot-reloading GLSL editing
**Language:** TypeScript
**Status of this document:** planning + reference

---

## Table of contents

1. [Executive summary and scope](#1-executive-summary-and-scope)
2. [Reality check](#2-reality-check)
3. [The latency budget](#3-the-latency-budget)
4. [Audio analysis](#4-audio-analysis)
5. [Clocks and the render loop](#5-clocks-and-the-render-loop)
6. [Shader hot reload](#6-shader-hot-reload)
7. [Preset morphing](#7-preset-morphing)
8. [MIDI](#8-midi)
9. [Performance](#9-performance)
10. [Architecture](#10-architecture)
11. [Tech stack and setup](#11-tech-stack-and-setup)
12. [Repository layout](#12-repository-layout)
13. [Milestone ladder](#13-milestone-ladder)
14. [Reference implementations](#14-reference-implementations)
15. [Testing](#15-testing)
16. [Stretch goals](#16-stretch-goals)
17. [References](#17-references)

---

## 1. Executive summary and scope

### The original statement

> WebGL visualizer driven by live FFT analysis, with preset morphing, MIDI controller bindings, and hot-reloading GLSL editing.

Five findings reshape this:

1. **The reason most shader visualizers look dead is the FFT binning, not the shader.** `AnalyserNode` gives linear frequency bins, but hearing is logarithmic. At `fftSize: 2048` and 48 kHz, roughly **92% of the array covers 2–24 kHz**, where almost no musical energy lives, while bass — 20–250 Hz, where the kick and bass carry the groove — occupies about **10 bins out of 1024**. A naive bar visualizer spends nearly all its visual bandwidth on content nobody hears. See section 4.2.
2. **`getUserMedia` defaults are tuned for speech and will destroy music.** Echo cancellation, noise suppression, and automatic gain control are all on by default. AGC in particular flattens exactly the dynamics you're trying to visualize. Three constraint flags fix it, and almost nobody sets them. See section 4.1.
3. **Web MIDI does not exist on Safari and Apple has said it won't.** WebKit declined to implement it over fingerprinting concerns; it remains unsupported through Safari 26.5. Firefox has it on desktop (108+) but not on Android. So one of the four headline features is Chromium-and-Firefox-desktop only, and that has to be a designed-for degradation rather than a runtime surprise. See section 8.1.
4. **You cannot optimize your way out of the analysis latency.** A 2048-sample FFT window at 48 kHz *is* 42.7 ms of past audio, before any smoothing, rendering, or display latency. The realistic audio-to-photon budget is 60–150 ms against a perceptual tolerance that's asymmetric — video lagging audio is far more forgiving than leading. See section 3.
5. **Shader compilation blocks, and the async extension is missing in Firefox.** `KHR_parallel_shader_compile` has been available in Chrome since 76 and Safari since 14.1, but Firefox has never shipped it — blocking Baseline since April 2021. So hot reload needs two code paths: poll-for-completion where available, and hitch-mitigation where not. See section 6.3.

### Revised project statement

> A GLSL playground with musically-meaningful audio analysis: logarithmically-banded FFT with separate smoothed and transient feature streams, an explicit and measured latency budget, audio-clock-driven animation, last-good-program hot reload with source-mapped errors and async compilation where available, FBO-crossfade preset morphing with perceptual color interpolation, and MIDI with takeover modes that degrades cleanly where the API doesn't exist.

### WebGL2 or WebGPU?

WebGPU reached Baseline in January 2026 — Chrome and Edge 113+, Firefox 141+ on Windows and 145+ on macOS Tahoe ARM64, Safari 26+ across macOS, iOS, iPadOS, and visionOS. It's genuinely available now.

**Build on WebGL2 anyway**, for one reason that's specific to this project: the content ecosystem is GLSL. Shadertoy, glslsandbox, The Book of Shaders, and the entire body of knowledge your users already have are GLSL. WGSL is a different language. For a *playground*, compatibility with the corpus people want to paste in matters more than API modernity.

Keep the renderer behind an interface so a WebGPU backend is possible later, and note that Firefox on Linux and Intel Macs is still in progress for WebGPU regardless.

### Explicit non-goals

- **Not a DAW or audio effects host.** You analyze audio; you don't process it.
- **Not a video encoder.** Recording is a stretch goal (§16).
- **Not a node-graph shader editor.** Text GLSL is the interface.
- **Not Shadertoy-compatible out of the box.** Supporting `iChannel` textures, multipass buffers, and cubemaps is a project of its own. Adopt the uniform *naming* so shaders paste in with minimal edits.
- **Not mobile-first.** Fragment-heavy shaders and mobile GPUs are a poor match, and Web MIDI doesn't exist there at all.

---

## 2. Reality check

### 2.1 Platform support

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| WebGL2 | ✅ | ✅ | ✅ |
| WebGPU | ✅ 113+ | ✅ 141+ (Win), 145+ (macOS ARM) | ✅ 26+ |
| Web Audio / AnalyserNode | ✅ | ✅ | ✅ |
| AudioWorklet | ✅ | ✅ | ✅ |
| **Web MIDI** | ✅ 43+ | ✅ 108+ desktop, ❌ Android | **❌ and not planned** |
| **KHR_parallel_shader_compile** | ✅ 76+ | **❌ never shipped** | ✅ 14.1+ |
| EXT_disjoint_timer_query_webgl2 | ⚠️ often disabled | ⚠️ | ⚠️ |

Two of these shape the build directly. **Safari has no MIDI at all**, so the app must be fully usable without it. **Firefox has no async shader compile**, so hot reload hitches there unless you mitigate.

The timer query is worth its own note: it's widely restricted or unavailable because high-resolution GPU timing is a side-channel risk. Assume you won't have it and design measurement accordingly (§9.3).

### 2.2 The failure modes

| Symptom | Cause |
|---|---|
| **Visuals barely move to music** | Linear FFT bins; all the energy is in 10 of 1024 (§4.2) |
| Everything pumps uniformly, no detail | Reacting to overall amplitude only, no band separation |
| Dynamics feel flattened | `getUserMedia` AGC left on (§4.1) |
| Motion feels mushy, misses hits | `smoothingTimeConstant` 0.8 on the transient path (§4.3) |
| Visuals noticeably behind the music | Latency budget not measured (§3) |
| Animation stutters after tab switch | Unclamped `dt` after rAF throttling (§5.2) |
| Tempo-locked effects drift | Frame counting instead of `AudioContext.currentTime` (§5.1) |
| Black screen after a while, never recovers | Unhandled WebGL context loss (§6.5) |
| Typo in the editor kills the visual | No last-good-program fallback (§6.2) |
| Error says line 47, editor line 12 is wrong | Injected prelude offsets compiler line numbers (§6.4) |
| Preset transitions look muddy | Color lerped in sRGB instead of a linear/perceptual space (§7.3) |
| Hue sweeps the long way round | Linear interpolation on an angle (§7.3) |
| Knob jumps the parameter on preset change | No takeover mode (§8.4) |
| MIDI knob produces visible stepping | 7-bit CC, 128 values, no slew (§8.3) |

Most of these are cheap to fix and expensive to retrofit.

---

## 3. The latency budget ★

### 3.1 Audio to photon

| Stage | Contribution |
|---|---|
| Input device + driver (mic/line) | 5–40 ms |
| `AudioContext.baseLatency` | 3–25 ms |
| **FFT window** (`fftSize / sampleRate`) | **42.7 ms at 2048/48 kHz** |
| `smoothingTimeConstant` | effective 3–5 frames at 0.8 |
| Wait for next `requestAnimationFrame` | 0–16.7 ms |
| Render + compositor | 1–2 frames |
| Display | 0–16.7 ms at 60 Hz |
| **Total, realistic** | **60–150 ms** |

### 3.2 The window is the floor

**The FFT window is not overhead you can optimize — it *is* the measurement.** A 2048-sample analysis at 48 kHz describes the preceding 42.7 milliseconds. There is no ordering of operations that makes it describe the present.

| `fftSize` | Window | Frequency resolution |
|---|---|---|
| 512 | 10.7 ms | 93.8 Hz |
| 1024 | 21.3 ms | 46.9 Hz |
| **2048** | **42.7 ms** | **23.4 Hz** |
| 4096 | 85.3 ms | 11.7 Hz |
| 8192 | 170.7 ms | 5.9 Hz |

The tradeoff is unavoidable: bass discrimination needs fine frequency resolution (musical notes at 40–80 Hz are only a few Hz apart), and transient response needs a short window. **Run two analysers** — a large one for spectral content and a small one for onsets (§4.4).

### 3.3 Perceptual tolerance is asymmetric

Audio-visual sync tolerance is not symmetric. Video **lagging** audio is tolerated far more than video **leading** it — broadly, something like 100+ ms of lag passes unnoticed while a few tens of milliseconds of lead reads as wrong. This is intuitive: in the physical world, light arrives before sound, so the brain expects visuals slightly ahead, never behind.

That's fortunate, because everything in §3.1 makes you late, not early. But it also means you're operating near the edge of the acceptable range, and it's worth measuring rather than assuming.

**One case where you can win:** if the app controls playback (a loaded file rather than live input), you can analyze *ahead* of the playhead and schedule visuals to match, eliminating the analysis latency entirely. Worth building for the file-playback path even though live input can't benefit.

### 3.4 Measure it

Don't estimate. Put a measurement in the app:

```ts
// Play a click track through the analysis path, detect the onset,
// timestamp the frame that renders the response.
interface LatencyReport {
  baseLatency: number;       // AudioContext.baseLatency
  outputLatency: number;     // AudioContext.outputLatency
  windowMs: number;          // fftSize / sampleRate * 1000
  smoothingFrames: number;
  measuredOnsetToFrame: number;
  total: number;
}
```

Show it in the debug panel. When someone says "it feels laggy," you want a number, not a discussion.

---

## 4. Audio analysis ★

### 4.1 getUserMedia defaults destroy music ★

The browser's default audio constraints are tuned for voice calls, and all three defaults are actively harmful here:

| Constraint | Default | Effect on music |
|---|---|---|
| `echoCancellation` | on | Applies adaptive filtering; can cancel parts of the signal |
| `noiseSuppression` | on | Treats sustained tones as noise and attenuates them |
| **`autoGainControl`** | **on** | **Flattens dynamics — the exact thing you're visualizing** |

AGC is the worst of them. It exists to make quiet speech audible and loud speech bearable, which means it actively compresses the loud/quiet contrast that makes a visualizer feel alive.

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // Ask for the highest rate available; music benefits from it.
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 2 },
  },
});
```

**Verify they actually applied.** Constraints are requests, not guarantees:

```ts
const settings = stream.getAudioTracks()[0].getSettings();
if (settings.autoGainControl) {
  warn("AGC could not be disabled on this device — dynamics will be compressed");
}
```

Surface that warning in the UI. A user on a device that forces AGC should know why their visuals feel flat rather than assuming the app is bad.

### 4.2 Linear bins versus logarithmic hearing ★

This is the finding that matters most.

`AnalyserNode.getByteFrequencyData()` returns `frequencyBinCount` bins spanning 0 to `sampleRate / 2`, **linearly**. At `fftSize: 2048` and 48 kHz that's 1024 bins of 23.4 Hz each.

Now map that onto where music actually lives:

| Range | Content | Bins | Share of array |
|---|---|---|---|
| 20–250 Hz | Kick, bass, low toms — the groove | ~10 | **1%** |
| 250–2000 Hz | Body, vocals, most harmonic content | ~75 | 7% |
| 2000–6000 Hz | Presence, attack, clarity | ~170 | 17% |
| 6000–24000 Hz | Air, cymbals, mostly nothing | ~770 | **75%** |

**Three-quarters of the data array describes the top octave and a half, where very little perceptual energy lives.** Meanwhile the entire bass register — the part that makes people move — is ten bins.

Plot that array directly as bars and you get the classic dead visualizer: a small cluster of activity on the far left and a vast field of nearly-static noise everywhere else.

**The fix: logarithmic band mapping.**

```ts
/** Map linear FFT bins onto perceptually-spaced bands. */
function buildLogBands(
  binCount: number, sampleRate: number, bandCount: number,
  fMin = 30, fMax = 16000
): Band[] {
  const nyquist = sampleRate / 2;
  const binHz = nyquist / binCount;
  const logMin = Math.log2(fMin);
  const logMax = Math.log2(fMax);

  return Array.from({ length: bandCount }, (_, i) => {
    const lo = Math.pow(2, logMin + (logMax - logMin) * (i / bandCount));
    const hi = Math.pow(2, logMin + (logMax - logMin) * ((i + 1) / bandCount));
    return {
      loBin: Math.max(1, Math.floor(lo / binHz)),
      hiBin: Math.min(binCount - 1, Math.ceil(hi / binHz)),
      centerHz: Math.sqrt(lo * hi),
    };
  });
}
```

Note `Math.max(1, ...)` on the low bin — bin 0 is DC offset and carries no musical information, but it can be large and will swamp your bass band if included.

For the lowest bands, one band may map to a single bin, and that's a real resolution limit. If bass detail matters, raise `fftSize` for the spectral analyser specifically (§4.4).

### 4.3 Named bands beat raw spectra

Most shaders don't want 1024 numbers. They want four or five meaningful scalars:

```ts
interface AudioFeatures {
  // Musically-defined bands, each 0–1
  sub: number;        // 20–60 Hz    — the physical thump
  bass: number;       // 60–250 Hz   — kick and bass line
  lowMid: number;     // 250–500 Hz  — body, warmth
  mid: number;        // 500–2000 Hz — vocals, melody
  highMid: number;    // 2–4 kHz     — presence and attack
  treble: number;     // 4–16 kHz    — air, cymbals

  rms: number;            // overall loudness
  peak: number;
  spectralCentroid: number;  // "brightness" — a genuinely useful single number
  spectralFlux: number;      // change rate — drives onset detection
  onset: boolean;            // transient this frame
  beatPhase: number;         // 0–1 within the estimated beat
  bpm: number | null;
}
```

**Spectral centroid** is the underrated one. It's the amplitude-weighted mean frequency — a single scalar that tracks perceived brightness. Mapping it to hue or sharpness gives a visual that responds to timbre, not just volume, and timbre is where the musical interest is.

```ts
function spectralCentroid(spectrum: Uint8Array, binHz: number): number {
  let num = 0, den = 0;
  for (let i = 1; i < spectrum.length; i++) {
    const mag = spectrum[i] / 255;
    num += i * binHz * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}
```

### 4.4 Two analysers, two purposes ★

A single `smoothingTimeConstant` cannot serve both sustained motion and transient response.

```ts
// Spectral: large window for frequency resolution, heavy smoothing for stability.
const spectral = ctx.createAnalyser();
spectral.fftSize = 4096;
spectral.smoothingTimeConstant = 0.75;

// Transient: small window, no smoothing, for onsets and hits.
const transient = ctx.createAnalyser();
transient.fftSize = 512;
transient.smoothingTimeConstant = 0;   // smoothing destroys onsets
```

Feed both from the same source node. The spectral analyser drives colors, shapes, and sustained motion; the transient analyser drives flashes, kicks, and anything that should snap.

Setting `smoothingTimeConstant = 0` on the transient path is essential. The default 0.8 is an exponential moving average that deliberately smears exactly the sharp changes onset detection depends on.

### 4.5 Onset detection via spectral flux

Amplitude thresholding misses onsets in dense music. **Spectral flux** — the sum of positive frame-to-frame changes across bins — is the standard approach and is cheap.

```ts
class OnsetDetector {
  private prev: Float32Array;
  private history: number[] = [];

  detect(spectrum: Uint8Array): { flux: number; onset: boolean } {
    let flux = 0;
    for (let i = 1; i < spectrum.length; i++) {
      const v = spectrum[i] / 255;
      const d = v - this.prev[i];
      if (d > 0) flux += d;          // half-wave rectify: only increases count
      this.prev[i] = v;
    }

    // Adaptive threshold from a local median — robust to sustained loudness.
    this.history.push(flux);
    if (this.history.length > 43) this.history.shift();   // ~1s at 43 fps
    const sorted = [...this.history].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    const onset = flux > median * 1.6 && flux > 0.02;
    return { flux, onset };
  }
}
```

Two details matter. **Half-wave rectification** — counting only increases — is what makes flux detect attacks rather than general change. And an **adaptive threshold from a local median** rather than a fixed one is what keeps the detector working across a quiet intro and a loud drop.

Add a refractory period (~80 ms) so a single hit doesn't register three times.

### 4.6 Do heavy analysis in an AudioWorklet

`ScriptProcessorNode` is deprecated and runs on the main thread — it will jank your render loop. `AudioWorklet` runs on the audio thread at audio priority.

Use `AnalyserNode` on the main thread for simple spectrum reads, and an `AudioWorklet` for anything stateful: onset detection, beat tracking, loudness integration. Post features to the main thread rather than raw samples.

Note that `AudioWorkletProcessor` gets 128-sample quanta, so buffering is your responsibility if you need larger windows.

---

## 5. Clocks and the render loop

### 5.1 Two clocks that drift ★

`performance.now()` (and rAF timestamps) come from the system clock. `AudioContext.currentTime` comes from the audio hardware clock. **They drift.** Over minutes, tempo-locked visuals driven by frame counting will slide out of phase with the music.

**Anything musical uses the audio clock.**

```ts
interface FrameContext {
  audioTime: number;   // AudioContext.currentTime — for musical timing
  wallTime: number;    // performance.now()/1000 — for UI and transitions
  dt: number;          // clamped delta
  frame: number;
}
```

Route beat phase, tempo-synced LFOs, and anything that should stay locked through `audioTime`. Route UI transitions and non-musical animation through `wallTime`.

### 5.2 Clamp dt

Hidden tabs throttle `requestAnimationFrame` to roughly once per second — but audio keeps running. Return to the tab and your first `dt` is ~1000 ms. Every integrator in the system takes a single enormous step, and the visual explodes.

```ts
const MAX_DT = 1 / 20;   // never integrate more than 50ms in one step

function tick(now: number) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > MAX_DT) dt = MAX_DT;   // drop time rather than jump state
  render(dt);
  requestAnimationFrame(tick);
}
```

And make every animation `dt`-driven, never frame-driven. `rotation += 0.01` behaves differently at 60 Hz, 120 Hz, and 144 Hz; `rotation += speed * dt` doesn't.

High-refresh displays are common enough now that frame-driven animation is a visible bug, not a theoretical one.

### 5.3 Read audio once per frame

Call `getByteFrequencyData` once per frame and pass the result down. Calling it multiple times per frame gives you the same data at extra cost, and — worse — calling it from multiple places makes the smoothing state's behavior confusing to reason about.

---

## 6. Shader hot reload ★

### 6.1 The requirement

Editing GLSL should update the visual without: killing the running shader on a syntax error, resetting uniform state, stalling the frame, or losing the user's place.

### 6.2 Last-good-program

**Never unbind the working program until a new one links successfully.**

```ts
class ShaderHotReload {
  private current: WebGLProgram | null = null;
  private currentUniforms: Map<string, WebGLUniformLocation> = new Map();

  async tryCompile(src: string): Promise<CompileResult> {
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fs = this.compile(gl.FRAGMENT_SHADER, PRELUDE + src);

    if (!fs.ok) {
      // Keep rendering the old program. Show errors in the gutter.
      return { ok: false, errors: mapErrors(fs.log, PRELUDE_LINES) };
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);
    gl.linkProgram(prog);

    await this.waitForLink(prog);   // §6.3

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return { ok: false, errors: mapErrors(gl.getProgramInfoLog(prog)!, PRELUDE_LINES) };
    }

    // Only now do we swap.
    const old = this.current;
    this.current = prog;
    this.currentUniforms = this.queryUniforms(prog);  // locations are invalid after relink
    if (old) gl.deleteProgram(old);
    return { ok: true };
  }
}
```

Two things people get wrong here: deleting the old program before the new one links (leaving nothing to render), and reusing cached uniform locations after a relink (they're invalidated).

**Preserve uniform values across reload.** Keep values in a plain object keyed by name, and reapply after the swap. Recompiling shouldn't reset every slider.

### 6.3 Async compilation, where it exists ★

Shader compilation and linking are synchronous and can take tens to hundreds of milliseconds for a complex shader. Done on the main thread mid-frame, that's a visible hitch.

`KHR_parallel_shader_compile` lets you poll instead of blocking. It's been in Chrome since 76 and Safari since 14.1 — but **Firefox has never shipped it**, and has been blocking its Baseline status since April 2021.

So: two paths.

```ts
const parallel = gl.getExtension("KHR_parallel_shader_compile");

async function waitForLink(prog: WebGLProgram): Promise<void> {
  if (parallel) {
    // Poll without stalling. Cheap and smooth.
    while (!gl.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR)) {
      await new Promise(r => requestAnimationFrame(r));
    }
    return;
  }
  // Firefox: the first getProgramParameter forces a synchronous wait.
  // Mitigate by compiling at a moment where a hitch is least visible.
  await new Promise(r => setTimeout(r, 0));
}
```

Mitigations for the no-extension path: debounce compilation (don't compile on every keystroke — 300 ms after typing stops), compile during an explicit user action rather than continuously, and show a "compiling" indicator so the hitch reads as expected rather than broken.

### 6.4 Map error line numbers back to the editor ★

You inject a prelude — `#version`, precision qualifiers, uniform declarations, helper functions. The GLSL compiler reports line numbers relative to the *full* source. The user's editor shows their own source. An error on prelude-adjusted line 47 might be their line 12, and reporting 47 makes the error message worse than useless.

```ts
const PRELUDE_LINES = PRELUDE.split("\n").length;

/** GLSL errors look like: ERROR: 0:47: 'foo' : undeclared identifier */
function mapErrors(log: string, offset: number): ShaderError[] {
  return log.split("\n").filter(Boolean).map(line => {
    const m = /^(ERROR|WARNING):\s*(\d+):(\d+):\s*(.*)$/.exec(line);
    if (!m) return { line: null, message: line, severity: "error" as const };
    const reported = parseInt(m[3], 10);
    return {
      severity: m[1].toLowerCase() as "error" | "warning",
      line: Math.max(1, reported - offset),   // back to the user's coordinates
      message: m[4],
    };
  });
}
```

Test this against every driver you can — error formats differ subtly between ANGLE, Mesa, and Apple's compiler, and a regex that works on one may not on another. Fall back to showing the raw log rather than a wrong line number.

### 6.5 Handle context loss ★

WebGL contexts are lost on GPU reset, driver update, too many live contexts, or backgrounding on mobile. Most playgrounds don't handle it, and the symptom is a black canvas that never recovers — a bug report that reads as "it just stopped working."

```ts
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();          // REQUIRED, or restoration never fires
  cancelAnimationFrame(rafId);
  ui.showOverlay("Graphics context lost — restoring…");
});

canvas.addEventListener("webglcontextrestored", () => {
  gl = canvas.getContext("webgl2")!;
  rebuildAllResources();       // programs, textures, FBOs, buffers — everything
  reapplyUniformState();
  ui.hideOverlay();
  rafId = requestAnimationFrame(tick);
});
```

`e.preventDefault()` on the lost event is mandatory — without it the browser will not attempt restoration.

This means every GPU resource needs a rebuild path, which is an architectural constraint: keep resource creation in one place, driven from declarative descriptions, so `rebuildAllResources()` is a real function and not a scattered rewrite.

Test it: `gl.getExtension("WEBGL_lose_context").loseContext()` and `.restoreContext()`.

---

## 7. Preset morphing

### 7.1 Two kinds of morph

| Case | Approach | Cost |
|---|---|---|
| Presets share a shader, differ only in uniforms | **Interpolate uniforms** | Free |
| Presets use different shaders | **Crossfade via FBOs** | 2× fragment work during the transition |

Uniform interpolation is the good case and should be the default — design the grammar so related presets share a shader. But you need crossfade for arbitrary pairs, and it's what makes "morph between any two presets" actually work.

### 7.2 FBO crossfade

```ts
function renderTransition(from: Preset, to: Preset, t: number): void {
  renderToFBO(fboA, from);
  renderToFBO(fboB, to);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(blendProgram);
  gl.uniform1f(u_mix, easeInOutCubic(t));
  bindTexture(0, fboA.texture);
  bindTexture(1, fboB.texture);
  drawFullscreenQuad();
}
```

**Halve the resolution during a transition.** You're paying for two full renders; dropping to 0.7× scale for the duration keeps the frame rate steady and nobody notices during a crossfade.

Easing matters. Linear `t` reads as mechanical; `easeInOutCubic` or a smoothstep reads as designed.

### 7.3 Interpolating values correctly ★

Three types need special handling, and all three are commonly done wrong.

**Colors: not in sRGB.** Lerping sRGB values gives dark, desaturated midpoints — a red-to-green blend passes through mud rather than through yellow. Interpolate in linear RGB at minimum, OKLab for perceptual smoothness.

```ts
function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const la = srgbToOklab(a);
  const lb = srgbToOklab(b);
  return oklabToSrgb({
    L: la.L + (lb.L - la.L) * t,
    a: la.a + (lb.a - la.a) * t,
    b: la.b + (lb.b - la.b) * t,
  });
}
```

**Angles and hues: shortest path.** Linear interpolation from 350° to 10° sweeps 340° the wrong way around the wheel. What you want is a 20° step forward.

```ts
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;   // wrap into [-180, 180]
  return a + d * t;
}
```

**Integers and enums: don't interpolate.** An iteration count of 7.3 is meaningless. Snap at the midpoint, or crossfade the whole preset rather than the parameter.

```ts
const INTERPOLATORS: Record<ParamType, Interp> = {
  float:   (a, b, t) => a + (b - a) * t,
  color:   lerpColor,
  angle:   lerpAngle,
  int:     (a, b, t) => (t < 0.5 ? a : b),     // snap
  bool:    (a, b, t) => (t < 0.5 ? a : b),
  enum:    (a, b, t) => (t < 0.5 ? a : b),
};
```

Declare the type with each parameter and dispatch on it. A single generic lerp across all uniforms is the source of most "why does this transition look wrong" bugs.

### 7.4 Audio-triggered morphing

Presets that switch on musical events feel alive in a way timed ones don't:

- Advance on a detected onset
- Advance every N beats, using the beat phase from §4.3
- Morph amount driven by a band's energy

Snapping a transition to a beat boundary rather than starting it mid-bar is a small detail with a disproportionate effect on how intentional the result feels.

---

## 8. MIDI

### 8.1 Safari has no Web MIDI ★

WebKit declined to implement the Web MIDI API over fingerprinting concerns, and it remains unsupported through Safari 26.5 on both macOS and iOS. Firefox has had it on desktop since 108 but not on Android. Chrome and Edge have had it since 43 and 79.

So MIDI is available to Chromium and desktop Firefox users only, and roughly a fifth of your potential audience simply cannot use one of the four headline features.

**Design for absence, not as a fallback.** Every parameter must be fully controllable from the UI, MIDI must be additive, and the absence message should be informative rather than an error:

```ts
async function initMidi(): Promise<MidiState> {
  if (!navigator.requestMIDIAccess) {
    return { available: false,
      reason: "This browser doesn't support Web MIDI. Chrome, Edge, or " +
              "desktop Firefox support MIDI controllers; Safari does not." };
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    return { available: true, access };
  } catch {
    return { available: false, reason: "MIDI access was denied." };
  }
}
```

Request `sysex: false` unless you genuinely need it — sysex triggers a stronger permission prompt and more user hesitation.

### 8.2 MIDI learn

The standard interaction: click a parameter, move a control, bind.

```ts
class MidiLearn {
  private target: string | null = null;
  private candidates = new Map<string, number>();   // key → move count

  begin(paramId: string): void {
    this.target = paramId;
    this.candidates.clear();
  }

  onMessage(msg: MIDIMessageEvent): void {
    if (!this.target) return;
    const [status, data1] = msg.data;
    const key = `${status & 0xF0}:${status & 0x0F}:${data1}`;

    // Controllers often emit several CCs while you wiggle one knob.
    // Bind the one that moved the most, not the first one seen.
    const n = (this.candidates.get(key) ?? 0) + 1;
    this.candidates.set(key, n);

    if (n >= 5) {
      this.commit(this.target, key);
      this.target = null;
    }
  }
}
```

The "moved the most" heuristic matters. Many controllers send touch or LED-feedback messages alongside the actual CC, and binding the first message seen picks the wrong one often enough to be annoying.

### 8.3 7-bit resolution and slew ★

Standard MIDI CC is 7 bits — 128 discrete values. Mapped to a smooth visual parameter, that's visible stepping, especially on anything driving position or scale.

14-bit CC (paired MSB/LSB controllers) exists but few controllers implement it.

**Slew-limit incoming CC values:**

```ts
class SlewFilter {
  private value: number;
  constructor(initial: number, private rate = 12) { this.value = initial; }

  update(target: number, dt: number): number {
    // Exponential approach — time-constant based, so it's frame-rate independent.
    const k = 1 - Math.exp(-this.rate * dt);
    this.value += (target - this.value) * k;
    return this.value;
  }
}
```

The `1 - exp(-rate * dt)` form rather than a fixed lerp factor is what makes this behave identically at 60 and 144 Hz.

Higher `rate` for parameters that should feel immediate (a filter cutoff), lower for ones that should feel smooth (a camera position).

### 8.4 Takeover modes ★

When a preset changes, the parameter value moves but the physical knob doesn't. The next touch jumps the value discontinuously — jarring during a performance.

```ts
type TakeoverMode = "jump" | "pickup" | "scale";

class Takeover {
  private engaged = false;

  apply(mode: TakeoverMode, incoming: number, current: number,
        lastPhysical: number | null): { value: number; engaged: boolean } {
    switch (mode) {
      case "jump":
        return { value: incoming, engaged: true };

      case "pickup":
        // Ignore until the knob crosses the current value.
        if (this.engaged) return { value: incoming, engaged: true };
        if (lastPhysical !== null &&
            Math.sign(current - lastPhysical) !== Math.sign(current - incoming)) {
          this.engaged = true;
          return { value: incoming, engaged: true };
        }
        return { value: current, engaged: false };

      case "scale":
        // Move proportionally toward the endpoint the knob is heading for.
        const room = incoming > lastPhysical! ? 1 - current : current;
        const travel = Math.abs(incoming - lastPhysical!) /
                       (incoming > lastPhysical! ? 1 - lastPhysical! : lastPhysical!);
        return { value: current + Math.sign(incoming - lastPhysical!) * room * travel,
                 engaged: true };
    }
  }
}
```

**Pickup is the right default for live performance**; jump is right for studio work where you want immediate response. Make it a per-binding setting, and show a visual indicator when a control is not yet engaged — otherwise pickup mode looks like a broken knob.

### 8.5 Beyond CC

- **Note on/off** for triggering — preset changes, flashes, one-shots. Velocity is a free intensity parameter.
- **MIDI clock** (0xF8, 24 per quarter note) for tempo sync from a DAW or drum machine. Far more reliable than beat detection when available, and worth preferring whenever a clock is present.
- **Program change** for preset selection.
- **Endless encoders** send relative values, but the encoding is not standardized — two's complement, sign-magnitude, and binary-offset are all in use. Requires per-device configuration; detect and let the user pick.

---

## 9. Performance

### 9.1 Fragment shaders scale with pixels

| Resolution | Pixels | Relative |
|---|---|---|
| 1280×720 | 0.92 M | 1× |
| 1920×1080 | 2.07 M | 2.3× |
| 2560×1440 | 3.69 M | 4× |
| 3840×2160 | 8.29 M | 9× |
| 1920×1080 @ dpr 2 | 8.29 M | 9× |

That last row is the one that surprises people. **A "1080p" canvas on a retina display is rendering 4K.** `devicePixelRatio` defaults into the backing store size and quadruples your fragment work silently.

### 9.2 Adaptive resolution scaling

The main lever, and it should be automatic:

```ts
class ResolutionScaler {
  private scale = 1.0;
  private frameTimes: number[] = [];

  update(dt: number): number {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 30) return this.scale;
    this.frameTimes.shift();

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    if (p90 > 1 / 55) {
      this.scale = Math.max(0.4, this.scale - 0.05);        // struggling
    } else if (p90 < 1 / 90 && this.scale < 1.0) {
      this.scale = Math.min(1.0, this.scale + 0.02);        // headroom — climb slowly
    }
    return this.scale;
  }
}
```

Asymmetric rates are deliberate: drop fast when frames are late, recover slowly. Symmetric adjustment oscillates visibly.

Use p90 rather than mean so a single hitch doesn't trigger a drop.

### 9.3 Measuring is harder than it looks ★

**Vsync quantizes `rAF` deltas.** At 60 Hz with vsync, you see 16.7 ms whether the GPU took 2 ms or 16 ms. You cannot tell "comfortable" from "one pixel away from dropping" by timing frames.

`EXT_disjoint_timer_query_webgl2` gives real GPU timings but is frequently disabled or unavailable — high-resolution GPU timing is a side-channel risk, and browsers restrict it.

Practical approaches:

1. **Use the timer query where available**, and say so in the debug panel.
2. **Probe for headroom**: briefly raise resolution and see whether frames drop. Intrusive, but it's the only way to find the actual margin without the extension.
3. **Watch the shape of the distribution.** A p99 well above p50 means you're near the edge even if p50 looks fine.

Report honestly in the UI — "60 fps (GPU timing unavailable)" is more useful than a confident number you can't actually measure.

### 9.4 Cheap wins

- **Render at a fraction, upscale.** Already covered; it's the biggest lever by far.
- **Cap `devicePixelRatio`** at 1.5 or 2 rather than accepting 3 on phones.
- **Avoid `readPixels` in the loop** — it forces a full pipeline stall.
- **Avoid dynamic loops with data-dependent bounds** in the fragment shader; some drivers handle them very badly.
- **`mediump` where precision permits** — meaningful on mobile GPUs, mostly free on desktop.
- **Don't allocate per frame.** Reuse typed arrays for FFT reads; a new `Uint8Array` every frame is 60 collections per second of pressure.

---

## 10. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Audio graph                                              │
│   source (mic | file | tab capture)                      │
│     ├─▶ AnalyserNode  fftSize 4096, smooth 0.75  ← spectral
│     ├─▶ AnalyserNode  fftSize 512,  smooth 0     ← transient
│     └─▶ AudioWorklet  onset · beat · loudness            │
└────────────────────────┬─────────────────────────────────┘
                         │ AudioFeatures (once per frame)
┌────────────────────────▼─────────────────────────────────┐
│ Parameter system                                         │
│   base preset values                                     │
│     + morph interpolation (typed, §7.3)                  │
│     + MIDI bindings (slewed, takeover, §8)               │
│     + audio modulation routing                           │
│     = resolved uniform set                               │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│ Renderer                                                 │
│   program manager (last-good, async link, rebuild)       │
│   FBO pool (crossfade, feedback, post)                   │
│   resolution scaler                                      │
└──────────────────────────────────────────────────────────┘
       ▲                                    ▲
       │                                    │
┌──────┴───────┐                  ┌─────────┴────────┐
│ GLSL editor  │                  │ MIDI + UI        │
│ (CodeMirror) │                  │                  │
└──────────────┘                  └──────────────────┘
```

**The modulation routing is where the expressiveness lives.** Rather than hardcoding "bass drives scale," let any audio feature route to any parameter with a configurable amount and curve:

```ts
interface ModRoute {
  source: keyof AudioFeatures;
  target: string;              // parameter id
  amount: number;              // -1 to 1
  curve: "linear" | "exp" | "log" | "sqrt";
  smoothing: number;
}
```

This turns the app from a visualizer into an instrument, and it's a small amount of code on top of what's already there.

### Uniform naming

Adopt Shadertoy's names where they overlap so pasted shaders mostly work:

```glsl
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;

// Project-specific audio uniforms
uniform float uBass, uMid, uTreble, uRms, uCentroid;
uniform float uOnset;        // decaying envelope, not a boolean — smoother
uniform float uBeatPhase;    // 0–1
uniform sampler2D uSpectrum; // log-banded, 1D texture
```

Making `uOnset` a decaying envelope rather than a boolean is a small choice that saves every shader author from writing their own decay.

---

## 11. Tech stack and setup

| Layer | Choice | Why |
|---|---|---|
| **Language** | TypeScript | |
| **Graphics** | **WebGL2**, behind an interface | GLSL is the content ecosystem (§1) |
| **Audio** | Web Audio + AudioWorklet | |
| **Editor** | **CodeMirror 6** | Lighter than Monaco, good GLSL mode, gutter diagnostics |
| **MIDI** | Web MIDI directly, or `webmidi.js` | The raw API is small enough to use directly |
| **Color** | `culori` | OKLab interpolation (§7.3) |
| **State** | Plain objects + a small event bus | A framework in the render loop is overhead you don't need |
| **UI** | React or Svelte for panels only | Never inside the render loop |
| **Build** | Vite | Fast HMR, and GLSL-as-string imports |

Two setup notes:

**Keep React out of the render loop entirely.** Reconciliation per frame is exactly the overhead you're trying to avoid. UI panels in a framework, canvas driven imperatively.

**Get a real MIDI controller early.** A cheap 8-knob USB controller is inexpensive and the takeover, slew, and learn logic in §8 cannot be meaningfully developed or tested without one.

---

## 12. Repository layout

```
Audio-Reactive-Shader-Playground/
├── README.md
├── docs/
│   ├── design.md               ← this document
│   ├── audio-analysis.md       ← ★ the §4 reasoning, for contributors
│   ├── uniforms.md             ← the shader-author reference
│   └── platform-support.md     ← ★ what works where
├── src/
│   ├── audio/
│   │   ├── source.ts           ← ★ getUserMedia constraints (§4.1)
│   │   ├── bands.ts            ← ★ log mapping (§4.2)
│   │   ├── features.ts
│   │   ├── onset.ts            ← spectral flux
│   │   ├── beat.ts
│   │   ├── worklets/
│   │   └── latency.ts          ← ★ the measurement (§3.4)
│   ├── gl/
│   │   ├── context.ts          ← ★ loss and restore (§6.5)
│   │   ├── program.ts          ← last-good + async link (§6.2, §6.3)
│   │   ├── errors.ts           ← ★ line mapping (§6.4)
│   │   ├── fbo.ts
│   │   └── scaler.ts
│   ├── params/
│   │   ├── schema.ts
│   │   ├── interpolate.ts      ← ★ typed interpolators (§7.3)
│   │   └── modulation.ts       ← the routing matrix
│   ├── presets/
│   │   ├── morph.ts
│   │   └── library/
│   ├── midi/
│   │   ├── access.ts           ← ★ graceful absence (§8.1)
│   │   ├── learn.ts
│   │   ├── slew.ts
│   │   └── takeover.ts
│   ├── editor/
│   └── ui/
├── shaders/
│   ├── prelude.glsl            ← injected; its line count drives §6.4
│   └── presets/
└── tests/
    ├── audio/                  ← band mapping, onset detection on fixtures
    ├── interpolate/            ← angle wrapping, color space
    └── errors/                 ← GLSL log parsing across driver formats
```

---

## 13. Milestone ladder

### M0 — Platform and latency spec
**Est. 3–4 days**

Write `docs/platform-support.md` with the §2.1 matrix. Decide the MIDI degradation story. Write the latency budget for your chosen `fftSize`.

**Done when:** you can state what a Safari user gets and what a Firefox user gets, before anyone asks.

---

### M1 — Audio analysis ★ **this is the project**
**Est. 2 weeks**

Source selection with correct constraints and verification, dual analysers, log band mapping, named bands, spectral centroid, spectral flux onset detection, latency measurement.

**Build this before any shader work.** Good analysis with a mediocre shader looks alive; a beautiful shader on linear bins looks dead. The order matters and it's the opposite of what's tempting.

**Done when:** a debug view of the bands visibly tracks kick, snare, and hi-hat as distinct events on real music.

---

### M2 — Render loop and context handling
**Est. 1 week**

WebGL2 setup, dt-clamped loop, audio-clock separation, context loss and restore with full resource rebuild, resolution scaling.

**Done when:** `loseContext()` followed by `restoreContext()` returns to a working visual with state intact.

---

### M3 — Shader hot reload ★
**Est. 1.5 weeks**

Last-good-program, async link where available with a debounced fallback, error line mapping, uniform state preservation.

**Done when:** typing a syntax error leaves the visual running with an error in the gutter on the correct line, in Chrome, Firefox, and Safari.

---

### M4 — Parameter and modulation system
**Est. 1.5 weeks**

Typed parameter schema, the modulation routing matrix, curves and smoothing.

**Done when:** any audio feature can be routed to any parameter from the UI.

---

### M5 — Presets and morphing
**Est. 1.5 weeks**

Preset format, uniform interpolation with typed interpolators, FBO crossfade with resolution reduction, beat-snapped transitions.

**Done when:** a red-to-green morph passes through yellow, and a 350°→10° hue morph takes the short way.

---

### M6 — MIDI ★
**Est. 1.5 weeks**

Access with graceful absence, learn with the move-count heuristic, slew, takeover modes with engagement indicator, note triggers, MIDI clock.

**Done when:** a physical controller drives parameters smoothly with no stepping, pickup mode works, and Safari shows a clear explanation rather than a broken panel.

---

### M7 — Editor
**Est. 1.5 weeks**

CodeMirror with GLSL mode, gutter diagnostics, uniform autocomplete, preset save/load, shareable URLs.

---

### M8 — Performance
**Est. 1 week**

Adaptive scaling, timer query where available with honest reporting, allocation audit, dpr capping.

---

### M9 — Polish
**Est. 2 weeks**

Preset library, fullscreen and performance mode, keyboard shortcuts, tab audio capture, onboarding.

---

## 14. Reference implementations

### 14.1 Band extraction

```ts
const MUSICAL_BANDS = {
  sub:     [20, 60],
  bass:    [60, 250],
  lowMid:  [250, 500],
  mid:     [500, 2000],
  highMid: [2000, 4000],
  treble:  [4000, 16000],
} as const;

export function extractBands(
  spectrum: Uint8Array, sampleRate: number, fftSize: number
): Record<keyof typeof MUSICAL_BANDS, number> {
  const binHz = sampleRate / fftSize;
  const out = {} as Record<keyof typeof MUSICAL_BANDS, number>;

  for (const [name, [lo, hi]] of Object.entries(MUSICAL_BANDS)) {
    const loBin = Math.max(1, Math.floor(lo / binHz));   // skip DC
    const hiBin = Math.min(spectrum.length - 1, Math.ceil(hi / binHz));

    let sum = 0;
    for (let i = loBin; i <= hiBin; i++) sum += spectrum[i];
    // Mean, not sum: wide bands would otherwise dominate purely by bin count.
    out[name as keyof typeof MUSICAL_BANDS] =
      (sum / Math.max(1, hiBin - loBin + 1)) / 255;
  }
  return out;
}
```

Mean rather than sum is the detail that matters. Treble spans ~500 bins and bass spans ~8; summing makes treble dominate by construction regardless of what's in the music.

### 14.2 Onset as a decaying envelope

```ts
class OnsetEnvelope {
  private value = 0;
  constructor(private decayPerSecond = 4) {}

  update(onset: boolean, intensity: number, dt: number): number {
    if (onset) this.value = Math.max(this.value, intensity);
    this.value *= Math.exp(-this.decayPerSecond * dt);
    return this.value;
  }
}
```

Shaders want a smooth envelope, not a one-frame boolean they'd have to smooth themselves. Doing it once here means every shader author gets it free.

### 14.3 The GL context wrapper

```ts
export class GLContext {
  private resources: ResourceDescriptor[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.acquire();
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();            // required for restoration
      this.onLost();
    });
    canvas.addEventListener("webglcontextrestored", () => this.onRestored());
  }

  /** All resources are registered declaratively so they can be rebuilt. */
  register(desc: ResourceDescriptor): Resource {
    this.resources.push(desc);
    return this.build(desc);
  }

  private onRestored(): void {
    this.acquire();
    for (const d of this.resources) this.build(d);
    this.emit("restored");
  }
}
```

The declarative registration is the architectural constraint §6.5 implies: you cannot rebuild resources you created ad hoc across the codebase.

---

## 15. Testing

### 15.1 Audio fixtures

Generate synthetic audio with known content and assert the analysis finds it:

```ts
test("bass band responds to a 60 Hz sine, treble does not", async () => {
  const features = await analyzeOffline(sine(60, 2.0));
  expect(features.bass).toBeGreaterThan(0.5);
  expect(features.treble).toBeLessThan(0.1);
});

test("onset detector finds every click in a click track", async () => {
  const onsets = await detectOnsets(clickTrack({ bpm: 120, bars: 8 }));
  expect(onsets.length).toBe(32);
  for (const t of onsets) {
    expect(nearestBeat(t, 120)).toBeLessThan(0.03);   // within 30ms
  }
});
```

Use `OfflineAudioContext` so tests run headless and deterministically at faster than real time.

### 15.2 Interpolation

```ts
test("hue interpolation takes the short way", () => {
  expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0);      // not 180
});

test("red to green passes through yellow, not mud", () => {
  const mid = lerpColor({r:255,g:0,b:0}, {r:0,g:255,b:0}, 0.5);
  expect(luminance(mid)).toBeGreaterThan(0.35);        // sRGB lerp gives ~0.25
});
```

### 15.3 Error parsing

Collect real compiler logs from ANGLE (Windows), Mesa (Linux), and Apple's compiler, and test the parser against all of them. Formats differ subtly and a regex tuned on one driver silently fails on another — producing wrong line numbers, which is worse than none.

### 15.4 Context loss

```ts
test("survives context loss and restore", async () => {
  const ext = gl.getExtension("WEBGL_lose_context")!;
  setUniform("uScale", 2.5);
  ext.loseContext();
  await waitFor("contextlost");
  ext.restoreContext();
  await waitFor("contextrestored");
  expect(getUniform("uScale")).toBe(2.5);              // state preserved
  expect(renderOneFrame()).not.toBeAllBlack();
});
```

### 15.5 Performance regression

Render a fixture shader for 300 frames at fixed resolution and record the frame-time distribution. Track p50 and p99 in CI. Vsync limits what this tells you (§9.3), but a regression that pushes p99 past the frame budget still shows up.

---

## 16. Stretch goals

| Feature | Effort | Value |
|---|---|---|
| **Beat tracking with tempo estimation** | Medium | Autocorrelation on the onset envelope. Enables real musical structure. |
| **MIDI clock sync** | Small | When a DAW is present, far more reliable than detection. High value, low effort. |
| **Video recording** | Medium | `MediaRecorder` on `canvas.captureStream()`, with audio muxed |
| **Multipass / feedback buffers** | Medium | Ping-pong FBOs. Unlocks a whole class of effects. |
| **Shadertoy import** | Medium | `iChannel` textures and multipass — mostly a compatibility shim |
| **NDI or Syphon/Spout output** | Large | Feed into VJ software. Needs a native bridge. |
| **Timeline automation** | Medium | Keyframed parameters for a composed set rather than live improvisation |
| **WebGPU backend** | Large | Now Baseline (§1); compute shaders enable particle systems |
| **Preset sharing** | Medium | URL-encoded or a gallery |
| **OSC bridge** | Medium | TouchOSC and Lemur via a small WebSocket relay — and it works on Safari, where MIDI doesn't |

That last one is worth noting: an OSC-over-WebSocket bridge sidesteps the Safari MIDI gap entirely, at the cost of running a small local relay. For anyone doing this seriously on a Mac, it may be the more useful path.

---

## 17. References

### Audio

- **Web Audio API specification** — `AnalyserNode`, `smoothingTimeConstant` semantics, `AudioWorklet`
- **MediaTrackConstraints** — the §4.1 flags and why they default on
- **Bello et al.**, "A Tutorial on Onset Detection in Music Signals" — the spectral flux method in §4.5
- **Dixon**, "Evaluation of the Audio Beat Tracking System BeatRoot" — beat tracking approaches
- **Lerch**, *An Introduction to Audio Content Analysis* — spectral centroid, flux, and the rest of the feature vocabulary
- ITU-R BT.1359 — audio-visual sync tolerance, and why it's asymmetric

### Graphics

| Source | For |
|---|---|
| WebGL2 specification and `WEBGL_lose_context` | §6.5 |
| `KHR_parallel_shader_compile` specification | §6.3 — and note Firefox has never shipped it |
| `EXT_disjoint_timer_query_webgl2` | §9.3, where available |
| **The Book of Shaders** | The canonical GLSL introduction; your users will have read it |
| **Inigo Quilez's articles** | SDFs, raymarching, noise — the techniques presets will use |
| WebGPU specification | For the §16 backend |

### MIDI

- **Web MIDI API specification** (W3C) — and the WebKit position (webkit.org/b/107250)
- MIDI 1.0 Detailed Specification — CC, clock, and the fact that relative encoder encodings are unstandardized
- `webmidi.js` — a reasonable wrapper if you'd rather not use the raw API

### Color

- **Björn Ottosson**, "A perceptual color space for image processing" — OKLab, for §7.3
- `culori` documentation — conversions and interpolation

---

## Appendix A — Decision record

| Decision | Rationale |
|---|---|
| **WebGL2, not WebGPU** | WebGPU is Baseline as of Jan 2026, but GLSL is the content ecosystem. For a playground, compatibility with the shader corpus beats API modernity. |
| **Build audio analysis before any shader work** | Good analysis with a mediocre shader looks alive; a beautiful shader on linear bins looks dead |
| **Log-mapped bands, never raw linear bins** | At 2048/48 kHz, ~75% of the array covers 6–24 kHz while bass gets ~10 bins. Linear plotting is why visualizers look dead. |
| Skip bin 0 in every band | DC offset carries no music and can swamp the bass band |
| Mean per band, not sum | Treble spans ~500 bins, bass ~8; summing makes treble dominate by construction |
| **Disable echoCancellation, noiseSuppression, autoGainControl** | Defaults are tuned for speech; AGC flattens the exact dynamics being visualized |
| Verify constraints applied, warn if not | Constraints are requests; some devices force AGC |
| **Two analysers: large+smoothed, small+unsmoothed** | Frequency resolution and transient response are opposed; one `smoothingTimeConstant` can't serve both |
| `smoothingTimeConstant = 0` on the transient path | The default 0.8 deliberately smears the sharp changes onsets depend on |
| Spectral flux with half-wave rectification and adaptive median threshold | Detects attacks rather than general change, and works across quiet intros and loud drops |
| Spectral centroid exposed as a uniform | One scalar that tracks timbre, not just volume — where the musical interest is |
| Heavy analysis in AudioWorklet, not ScriptProcessorNode | The latter is deprecated and janks the render loop |
| **The FFT window is a floor, not overhead** | 2048 samples at 48 kHz *is* 42.7 ms of past audio; no optimization changes that |
| Latency measured and shown in the debug panel | "It feels laggy" should be answerable with a number |
| **Audio clock for musical timing, wall clock for UI** | `AudioContext.currentTime` and `performance.now()` drift; tempo-locked visuals must use the former |
| Clamp `dt` to 50 ms | Hidden-tab rAF throttling produces ~1000 ms deltas that make integrators explode |
| All animation `dt`-driven, never frame-driven | High-refresh displays make frame-driven animation a visible bug |
| **Last-good-program: never unbind until a new one links** | A syntax error must not kill the running visual |
| Re-query uniform locations after every relink | They're invalidated, and cached ones silently fail |
| Uniform values preserved across reload | Recompiling shouldn't reset every slider |
| **Two compile paths: poll where available, debounce where not** | `KHR_parallel_shader_compile` is in Chrome and Safari but has never shipped in Firefox |
| **Map compiler line numbers back through the prelude offset** | Reporting the wrong line is worse than reporting none |
| **Handle context loss with `preventDefault()` and a full rebuild** | Without the preventDefault, restoration never fires; without the rebuild path, the canvas stays black forever |
| Resources registered declaratively | You cannot rebuild what was created ad hoc |
| FBO crossfade for cross-shader morphs, uniform lerp within a shader | Uniform lerp is free; crossfade handles arbitrary pairs |
| Reduce resolution during a transition | Two renders at once; nobody notices 0.7× during a crossfade |
| **Typed interpolators: OKLab for color, shortest-path for angles, snap for ints** | A single generic lerp produces muddy colors, long-way hue sweeps, and meaningless fractional counts |
| **Design for MIDI's absence, not as a fallback** | Safari has no Web MIDI and WebKit declined to implement it; Firefox Android has none either |
| Request `sysex: false` | Stronger permission prompt for a capability most users don't need |
| MIDI learn binds the most-moved control, not the first seen | Controllers emit touch and feedback messages alongside the real CC |
| Slew-limit CC with an exponential time constant | 7-bit CC is 128 steps; and `1-exp(-rate·dt)` is frame-rate independent |
| **Pickup takeover as the default, with an engagement indicator** | Preset changes desync knob and value; without the indicator, pickup looks broken |
| Onset exposed as a decaying envelope, not a boolean | Every shader author would otherwise write the same decay |
| Modulation routing matrix rather than hardcoded mappings | Turns a visualizer into an instrument for very little code |
| Adaptive resolution with asymmetric rates | Drop fast, recover slowly; symmetric adjustment oscillates visibly |
| **Report GPU timing honestly, including when unavailable** | Vsync quantizes rAF deltas; the timer query is often restricted. A confident fake number is worse than a caveat. |
| Cap `devicePixelRatio` | A "1080p" canvas at dpr 2 is rendering 4K |
| No framework inside the render loop | Reconciliation per frame is the overhead being avoided |

---

## Appendix B — Quick reference card

```
PLATFORM
  WebGL2      everywhere
  WebGPU      Baseline Jan 2026 (Chrome/Edge 113, FF 141/145, Safari 26)
  Web MIDI    Chrome 43 · Edge 79 · Firefox 108 desktop
              ❌ SAFARI — declined, fingerprinting. ❌ Firefox Android.
  KHR_parallel_shader_compile   Chrome 76 · Safari 14.1 · ❌ FIREFOX
  timer query                   often restricted — assume absent

THE FFT TRAP (fftSize 2048 @ 48 kHz → 1024 bins × 23.4 Hz)
    20–250 Hz  bass/kick        ~10 bins    1%
   250–2000    vocals/melody    ~75 bins    7%
  2000–6000    presence        ~170 bins   17%
  6000–24000   mostly air      ~770 bins   75%   ← where naive bars live
  → log-map to musical bands; skip bin 0 (DC); MEAN per band, not sum

getUserMedia — ALL THREE OR THE MUSIC IS RUINED
  echoCancellation: false
  noiseSuppression: false
  autoGainControl:  false     ← AGC flattens the dynamics you're visualizing
  then verify via track.getSettings() and warn if forced on

TWO ANALYSERS
  spectral   fftSize 4096, smoothing 0.75   → color, shape, sustained motion
  transient  fftSize 512,  smoothing 0      → onsets, hits, flashes

LATENCY (audio → photon)
  window = fftSize/sampleRate   2048/48k = 42.7 ms of PAST audio
  + smoothing + rAF + render + compositor + display
  = 60–150 ms realistic
  tolerance is ASYMMETRIC: lag forgiven (~100 ms+), lead is not (~45 ms)
  file playback can analyze AHEAD; live input cannot

CLOCKS
  AudioContext.currentTime → musical timing (beat, tempo LFOs)
  performance.now()        → UI transitions
  they DRIFT. never frame-count for tempo.
  clamp dt ≤ 50 ms (hidden tabs throttle rAF to ~1 Hz)

HOT RELOAD
  keep last-good program; swap only after successful link
  re-query uniform locations after EVERY relink
  preserve uniform values across reload
  map error lines: reported − PRELUDE_LINES
  context loss: preventDefault() is REQUIRED or restore never fires

INTERPOLATION
  color  → OKLab (sRGB lerp gives mud)
  angle  → ((b−a+540) % 360) − 180   (350°→10° is +20°, not −340°)
  int/enum → snap at t=0.5, never fractional

MIDI
  7-bit = 128 steps → slew with 1−exp(−rate·dt)
  learn: bind the most-moved control, not the first seen
  takeover: pickup for live, jump for studio — show engagement state
  MIDI clock = 24 ppqn; prefer it over detection when present

PERFORMANCE
  1080p @ dpr 2 = 8.3 M px = 4K. cap devicePixelRatio.
  adaptive scale: drop fast (−0.05), recover slow (+0.02), use p90
  vsync quantizes rAF — you can't tell 2 ms from 16 ms of GPU work
```
