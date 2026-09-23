/**
 * Application entry point: wires the audio, GL, params, MIDI and editor
 * layers together and runs the frame loop.
 *
 * Deliberately thin. Everything with a decision in it lives in the module
 * that owns that decision; this file's job is order of operations, and the
 * order that matters is: read the audio once, derive everything from that
 * one snapshot, render, then measure.
 */

import { FeatureExtractor } from "./audio/features.js";
import { measureLatency, summarizeLatency } from "./audio/latency.js";
import {
  canAnalyzeAhead,
  openDisplayAudio,
  openFile,
  openMicrophone,
  type AudioSource,
} from "./audio/source.js";
import type { AudioFeatures } from "./audio/features.js";
import { RenderLoop, type FrameTiming } from "./clock/loop.js";
import { GLContext } from "./gl/context.js";
import { Renderer } from "./gl/renderer.js";
import { summarize } from "./gl/errors.js";
import { ShaderEditor } from "./editor/editor.js";
import { MidiAccess, checkMidiAvailability } from "./midi/access.js";
import { MidiLearn, findBinding, type MidiBinding } from "./midi/learn.js";
import { ccToUnit } from "./midi/slew.js";
import { TakeoverTracker } from "./midi/takeover.js";
import { ModulationEngine, emptyModulation, sampleSources, type ModulationState } from "./params/modulation.js";
import { ParamSchema, denormalize, normalize, type ParamDecl } from "./params/schema.js";
import { BUILT_IN_PRESETS, DEFAULT_PRESET } from "./presets/library/index.js";
import { Morph, type Preset } from "./presets/morph.js";
import { SPECTRUM_BANDS } from "./shaders/index.js";

/**
 * The parameters every built-in shader can use.
 *
 * A real playground would parse these out of the user's source with a
 * comment convention. That is a separate feature; declaring a fixed set
 * keeps the wiring honest and testable in the meantime.
 */
const DECLARATIONS: ParamDecl[] = [
  { name: "uWarp", label: "Warp", type: "float", min: 0, max: 2, default: 0.5, group: "Shape" },
  { name: "uScale", label: "Scale", type: "float", min: 0.1, max: 10, default: 1, curve: "log", group: "Shape" },
  { name: "uSpin", label: "Spin", type: "angle", min: 0, max: 360, default: 0, group: "Shape" },
  { name: "uIters", label: "Iterations", type: "int", min: 1, max: 32, default: 8, group: "Shape" },
  { name: "uTint", label: "Tint", type: "color", default: { r: 0.2, g: 0.6, b: 1 }, group: "Colour" },
  { name: "uGain", label: "Gain", type: "float", min: 0, max: 4, default: 1, group: "Colour" },
];

const schema = new ParamSchema(DECLARATIONS);

/**
 * What the shader sees before any audio is connected.
 *
 * All zeros rather than anything decorative. A playground that fakes
 * movement with no input teaches its user that the analysis works when it
 * has not been tested at all.
 */
const SILENCE: AudioFeatures = {
  sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
  rms: 0, peak: 0,
  centroidHz: 0, centroid: 0,
  flux: 0, onset: false, onsetEnvelope: 0,
  bpm: null, beatPhase: 0, beatConfidence: 0,
  logSpectrum: new Float32Array(SPECTRUM_BANDS),
};

class App {
  private readonly canvas = document.getElementById("stage") as HTMLCanvasElement;
  private readonly ctx = new GLContext(this.canvas, {
    onLost: () => this.onContextLost(),
    onRestored: () => this.onContextRestored(),
  });
  private readonly renderer = new Renderer(this.ctx, this.canvas);

  /**
   * Created only once there is audio to analyse.
   *
   * An AnalyserNode needs a source node and a context, and constructing an
   * AudioContext before a user gesture leaves it suspended on every
   * browser. Until then the shader runs against `SILENCE` — which is a
   * genuine state, not a placeholder: the playground is usable for writing
   * shaders with no audio connected at all.
   */
  private features: FeatureExtractor | null = null;
  private audio: AudioContext | null = null;

  private readonly modulation: ModulationState = emptyModulation();
  private readonly modEngine = new ModulationEngine(schema);
  private baseValues = schema.defaults();

  private readonly midi = new MidiAccess();
  private readonly learn = new MidiLearn();
  private readonly takeover = new TakeoverTracker("pickup");
  private bindings: MidiBinding[] = [];

  private editor!: ShaderEditor;
  private morph: Morph | null = null;
  private currentPreset: Preset = DEFAULT_PRESET;
  private source: AudioSource | null = null;

  private readonly mouse = { x: 0, y: 0, downX: -1, downY: -1 };
  private readonly loop = new RenderLoop({
    // The musical clock. Before any audio exists there is no audio clock,
    // so the UI clock stands in — the two only need to agree once there is
    // something to be in time with.
    audioTime: () => this.audio?.currentTime ?? performance.now() / 1000,
    render: (t) => this.frame(t),
  });

  async start(): Promise<void> {
    this.editor = new ShaderEditor({
      parent: document.getElementById("editor")!,
      initial: DEFAULT_PRESET.shader,
      onCompile: (src) => void this.compile(src),
    });

    this.buildParameterPanel();
    this.buildPresetList();
    this.wireMouse();
    this.wireAudioButtons();
    await this.setupMidi();

    await this.compile(DEFAULT_PRESET.shader);
    this.loop.start();
  }

  // ------------------------------------------------------------- the frame

  private frame(timing: FrameTiming): void {
    // One read per frame. Everything below derives from this snapshot, so
    // two uniforms can never describe different moments in one image.
    const features = this.features?.read(timing.audioTime, timing.dt) ?? SILENCE;

    const sources = sampleSources(features, this.modulation, timing.audioTime);
    const { values } = this.modEngine.apply(this.baseValues, this.modulation, sources, timing.dt);

    let crossfade = 1;
    let scaleHint = 1;
    let renderValues = values;

    if (this.morph) {
      const f = this.morph.advance(timing.dt);
      scaleHint = f.scaleHint;
      if (f.kind === "crossfade") crossfade = f.t;
      else renderValues = { ...values, ...f.values };
      if (f.done) this.morph = null;
    }

    this.renderer.render({
      timing,
      features,
      values: renderValues,
      declarations: DECLARATIONS,
      mouse: this.mouse,
      crossfade,
      scaleHint,
    });

    this.updateStatus(features, timing);
  }

  // ----------------------------------------------------------- compilation

  private async compile(source: string): Promise<void> {
    const result = await this.renderer.compileMain(source);
    this.editor.showDiagnostics(result.diagnostics);

    const status = document.getElementById("compile-status")!;
    status.textContent = summarize(result.diagnostics);
    status.className = result.ok ? "ok" : "error";

    // Deliberately no "shader failed, showing black". A failed compile
    // leaves the working program running, which is the whole point.
  }

  // --------------------------------------------------------------- presets

  private loadPreset(preset: Preset): void {
    const previousSource = this.currentPreset.shader;
    const changingShader = previousSource !== preset.shader;

    if (changingShader) {
      // Put the outgoing shader in the second slot so it can keep
      // rendering through the crossfade.
      void this.renderer.compilePrevious(previousSource);
      void this.compile(preset.shader);
      this.editor.setSource(preset.shader);
    }

    const { values } = schema.coerce(preset.values);
    this.morph = this.morph
      ? this.morph.redirect({ ...preset, values })
      : new Morph(schema, { ...this.currentPreset, values: this.baseValues }, { ...preset, values });

    this.baseValues = values;
    this.currentPreset = preset;

    // Every knob must catch up again: the parameters moved without the
    // controller's involvement.
    this.takeover.disengageAll();
    this.refreshParameterPanel();
  }

  // ------------------------------------------------------------------ midi

  private async setupMidi(): Promise<void> {
    const panel = document.getElementById("midi-status")!;
    const pre = checkMidiAvailability();

    if (pre.status === "unavailable") {
      // Not an error state. Say what is missing, say everything still
      // works, and move on.
      panel.textContent = pre.reason;
      panel.className = "note";
      return;
    }

    const result = await this.midi.request();
    panel.textContent = result.reason;
    panel.className = result.status === "ready" ? "ok" : "note";

    this.midi.onMessage((m) => {
      if (this.learn.isLearning) {
        const binding = this.learn.observe(m);
        if (binding) {
          this.bindings = this.bindings.filter((b) => b.target !== binding.target);
          this.bindings.push(binding);
          this.refreshParameterPanel();
        }
        return;
      }

      const binding = findBinding(this.bindings, m);
      if (!binding || m.kind !== "cc") return;

      const decl = schema.get(binding.target);
      if (!decl) return;

      const incoming = ccToUnit(m.value);
      const current = normalize(decl, this.baseValues[binding.target]);
      const r = this.takeover.receive(binding.target, current, incoming);
      if (!r.engaged) return;

      this.baseValues = { ...this.baseValues, [binding.target]: denormalize(decl, r.value) };
      this.refreshParameterPanel();
    });
  }

  // -------------------------------------------------------------- the DOM

  private buildParameterPanel(): void {
    const host = document.getElementById("params")!;
    host.innerHTML = "";

    for (const decl of DECLARATIONS) {
      const row = document.createElement("div");
      row.className = "param";
      row.dataset.name = decl.name;

      const label = document.createElement("label");
      label.textContent = decl.label;

      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1000";
      input.value = String(Math.round(normalize(decl, this.baseValues[decl.name]) * 1000));
      input.addEventListener("input", () => {
        this.baseValues = {
          ...this.baseValues,
          [decl.name]: denormalize(decl, Number(input.value) / 1000),
        };
        // The parameter moved by other means; the knob must catch up.
        this.takeover.disengage(decl.name);
        this.refreshParameterPanel();
      });

      const learnBtn = document.createElement("button");
      learnBtn.textContent = "learn";
      learnBtn.addEventListener("click", () => {
        this.learn.start(decl.name, performance.now());
        learnBtn.classList.add("learning");
      });

      const readout = document.createElement("span");
      readout.className = "readout";

      row.append(label, input, readout, learnBtn);
      host.append(row);
    }
    this.refreshParameterPanel();
  }

  private refreshParameterPanel(): void {
    for (const decl of DECLARATIONS) {
      const row = document.querySelector<HTMLElement>(`.param[data-name="${decl.name}"]`);
      if (!row) continue;
      const input = row.querySelector("input")!;
      const readout = row.querySelector(".readout")!;
      const n = normalize(decl, this.baseValues[decl.name]);
      if (document.activeElement !== input) input.value = String(Math.round(n * 1000));
      readout.textContent = formatValue(this.baseValues[decl.name]);

      // The ghost marker: without it, pickup mode feels like a dead knob.
      const knob = this.takeover.knobPosition(decl.name);
      row.style.setProperty("--knob", knob === null ? "" : String(knob));
      row.classList.toggle("waiting", knob !== null && !this.takeover.isEngaged(decl.name));
    }
  }

  private buildPresetList(): void {
    const host = document.getElementById("presets")!;
    for (const p of BUILT_IN_PRESETS) {
      const b = document.createElement("button");
      b.textContent = p.name;
      b.title = p.description ?? "";
      b.addEventListener("click", () => this.loadPreset(p));
      host.append(b);
    }
  }

  private wireMouse(): void {
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - r.left) * (this.canvas.width / r.width);
      this.mouse.y = (r.bottom - e.clientY) * (this.canvas.height / r.height);
    });
    this.canvas.addEventListener("pointerdown", () => {
      this.mouse.downX = this.mouse.x;
      this.mouse.downY = this.mouse.y;
    });
    // Shadertoy's convention: negative zw while the button is up.
    this.canvas.addEventListener("pointerup", () => {
      this.mouse.downX = -Math.abs(this.mouse.downX);
      this.mouse.downY = -Math.abs(this.mouse.downY);
    });
  }

  private wireAudioButtons(): void {
    const warn = document.getElementById("audio-warnings")!;

    const fail = (what: string, err: unknown) => {
      warn.textContent = `${what}: ${err instanceof Error ? err.message : String(err)}`;
      warn.className = "error";
    };

    document.getElementById("use-mic")!.addEventListener("click", async () => {
      try {
        this.attachSource(await openMicrophone(this.ensureAudio()));
      } catch (err) {
        fail("Microphone unavailable", err);
      }
    });

    document.getElementById("use-tab")!.addEventListener("click", async () => {
      try {
        this.attachSource(await openDisplayAudio(this.ensureAudio()));
      } catch (err) {
        fail("Tab audio unavailable", err);
      }
    });

    const file = document.getElementById("use-file") as HTMLInputElement;
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        this.attachSource(openFile(this.ensureAudio(), f));
      } catch (err) {
        fail("Could not open that file", err);
      }
    });
  }

  /**
   * Create the AudioContext on demand.
   *
   * Constructing one before a user gesture leaves it suspended on every
   * browser, and a suspended context produces an analyser full of zeros —
   * which looks exactly like a broken analyser. Creating it inside the
   * click handler is what makes the difference, and `resume()` covers the
   * case where it starts suspended anyway.
   */
  private ensureAudio(): AudioContext {
    if (!this.audio) this.audio = new AudioContext({ latencyHint: "interactive" });
    if (this.audio.state === "suspended") void this.audio.resume();
    return this.audio;
  }

  private attachSource(source: AudioSource): void {
    this.source?.stop();
    this.features?.dispose();

    this.source = source;
    const context = this.ensureAudio();
    this.features = new FeatureExtractor(context, source.node, { logBandCount: SPECTRUM_BANDS });

    // getUserMedia's defaults destroy music: AGC flattens exactly the
    // dynamics being visualised. The constraints are requests rather than
    // guarantees, so the source reports what the device actually did.
    const warn = document.getElementById("audio-warnings")!;
    const warnings = source.constraints?.warnings ?? [];
    warn.textContent = warnings.join(" ");
    warn.className = warnings.length ? "note" : "";

    const report = measureLatency({
      sampleRate: context.sampleRate,
      fftSize: this.features.spectral.fftSize,
      outputLatency: context.outputLatency,
      baseLatency: context.baseLatency,
      canAnalyzeAhead: canAnalyzeAhead(source),
    });
    document.getElementById("latency")!.textContent = summarizeLatency(report);
    document.getElementById("latency-notes")!.textContent = report.notes.join(" ");
  }

  private updateStatus(features: AudioFeatures, timing: FrameTiming): void {
    if (timing.frame % 15 !== 0) return; // the DOM does not need 60 Hz
    const el = document.getElementById("stats")!;
    el.textContent =
      `${features.bpm ? `${features.bpm.toFixed(0)} bpm` : "no tempo"} · ` +
      `scale ${(this.renderer.scaler.current * 100).toFixed(0)}% · ` +
      `${this.renderer.main.usesParallelCompile ? "parallel compile" : "blocking compile"}`;
  }

  // ------------------------------------------------------------ gl context

  private onContextLost(): void {
    document.getElementById("compile-status")!.textContent = "GPU context lost — rebuilding…";
    this.renderer.invalidate();
  }

  private onContextRestored(): void {
    // The sources survived; only the GL objects died.
    void this.compile(this.editor.source);
  }
}

function formatValue(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((n) => n.toFixed(2)).join(", ");
  if (v && typeof v === "object" && "r" in v) {
    const c = v as { r: number; g: number; b: number };
    return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  }
  return String(v);
}

new App().start().catch((err) => {
  // The last resort. A thrown error during startup would otherwise leave a
  // blank page with the explanation only in the console.
  const el = document.getElementById("compile-status");
  if (el) {
    el.textContent = err instanceof Error ? err.message : String(err);
    el.className = "error";
  }
  console.error(err);
});
