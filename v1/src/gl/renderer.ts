/**
 * The renderer: one frame, end to end.
 *
 * Owns the offscreen targets, the crossfade pass and the uniform uploads.
 * The order of operations here matters more than it looks — in particular
 * the audio features are read exactly once per frame (see features.ts), and
 * every uniform is uploaded from that one snapshot, so two uniforms can
 * never disagree about what the music was doing.
 */

import { GLContext, type GL, type ResourceHandle } from "./context.js";
import { FULLSCREEN_VERTEX_SHADER, PingPong, RenderTarget, drawFullscreen } from "./fbo.js";
import { ShaderProgram } from "./program.js";
import { ResolutionScaler } from "./scaler.js";
import { assembleFragment, SPECTRUM_BANDS } from "../shaders/index.js";
import type { AudioFeatures } from "../audio/features.js";
import type { ParamDecl, ParamValues } from "../params/schema.js";
import type { RGB } from "../params/interpolate.js";
import type { FrameTiming } from "../clock/loop.js";

/**
 * The pass that puts an offscreen target on the screen, and crossfades two
 * of them during a shader change.
 */
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;
void main() {
  vec3 a = texture(uFrom, vUv).rgb;
  vec3 b = texture(uTo, vUv).rgb;
  fragColor = vec4(mix(a, b, uMix), 1.0);
}
`;

export interface RenderInputs {
  timing: FrameTiming;
  features: AudioFeatures;
  values: ParamValues;
  declarations: readonly ParamDecl[];
  mouse: { x: number; y: number; downX: number; downY: number };
  /** 0 = show only the outgoing shader, 1 = only the incoming one. */
  crossfade?: number;
  /** Extra resolution multiplier, e.g. while a crossfade is running. */
  scaleHint?: number;
}

export class Renderer {
  readonly scaler = new ResolutionScaler();
  readonly main: ShaderProgram;
  /** The outgoing shader during a crossfade. */
  readonly previous: ShaderProgram;
  private readonly composite: ShaderProgram;

  private readonly vao: ResourceHandle<WebGLVertexArrayObject>;
  private feedback: PingPong | null = null;
  private mainTarget: RenderTarget | null = null;
  private prevTarget: RenderTarget | null = null;

  private spectrumScratch = new Float32Array(SPECTRUM_BANDS);
  private lastFrameEndMs = 0;

  constructor(
    private readonly ctx: GLContext,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const gl = ctx.gl;
    this.main = new ShaderProgram(gl);
    this.previous = new ShaderProgram(gl);
    this.composite = new ShaderProgram(gl);

    // WebGL2 requires *some* VAO bound even when the vertex shader reads
    // nothing but gl_VertexID.
    this.vao = ctx.register({
      label: "empty-vao",
      create: (g) => {
        const v = g.createVertexArray();
        if (!v) throw new Error("could not create a vertex array");
        return v;
      },
      dispose: (g, v) => g.deleteVertexArray(v),
    });

    void this.composite.compile({
      vertex: FULLSCREEN_VERTEX_SHADER,
      fragment: COMPOSITE_FRAGMENT,
      preludeLines: 0,
    });
  }

  /** Compile a user shader into the main program. */
  compileMain(userSource: string) {
    const { source, preludeLines } = assembleFragment(userSource, SPECTRUM_BANDS);
    return this.main.compile({ vertex: FULLSCREEN_VERTEX_SHADER, fragment: source, preludeLines });
  }

  /** Compile into the outgoing slot, for a crossfade. */
  compilePrevious(userSource: string) {
    const { source, preludeLines } = assembleFragment(userSource, SPECTRUM_BANDS);
    return this.previous.compile({
      vertex: FULLSCREEN_VERTEX_SHADER,
      fragment: source,
      preludeLines,
    });
  }

  render(inputs: RenderInputs): void {
    const gl = this.ctx.gl;
    if (this.ctx.isLost) return;

    // Poll the parallel compile before anything else: a shader that
    // finished linking should take effect on this frame rather than the
    // next one.
    this.main.poll();
    this.previous.poll();
    this.composite.poll();

    this.resize(inputs.scaleHint ?? 1);
    if (!this.mainTarget || !this.feedback) return;

    gl.bindVertexArray(this.vao.value);

    // --- the user's shader, into an offscreen target ---------------------
    if (this.main.hasProgram) {
      this.feedback.write.bind();
      this.main.use();
      this.uploadUniforms(this.main, inputs);
      // The previous frame, for feedback shaders.
      this.main.setTexture("iChannel0", 0, this.feedback.read.texture);
      drawFullscreen(gl);
    }

    // --- the outgoing shader, only while crossfading ----------------------
    const mix = inputs.crossfade ?? 1;
    const crossfading = mix < 1 && this.previous.hasProgram && this.prevTarget !== null;
    if (crossfading) {
      this.prevTarget!.bind();
      this.previous.use();
      this.uploadUniforms(this.previous, inputs);
      this.previous.setTexture("iChannel0", 0, this.feedback.read.texture);
      drawFullscreen(gl);
    }

    // --- composite to the canvas -----------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    if (this.composite.hasProgram) {
      this.composite.use();
      this.composite.setTexture("uFrom", 0, crossfading ? this.prevTarget!.texture : this.feedback.write.texture);
      this.composite.setTexture("uTo", 1, this.feedback.write.texture);
      this.composite.setFloat("uMix", crossfading ? mix : 1);
      drawFullscreen(gl);
    }

    // Swap after compositing, not before: the composite reads `write`, and
    // swapping first would show last frame's image.
    this.feedback.swap();

    this.measureFrame();
  }

  /**
   * Upload every uniform from one feature snapshot.
   *
   * Taking the snapshot once per frame rather than reading the analyser per
   * uniform is what stops `uBass` and `uSpectrum` describing different
   * moments in the same image.
   */
  private uploadUniforms(program: ShaderProgram, inputs: RenderInputs): void {
    const { timing, features, values, declarations, mouse } = inputs;
    const target = this.feedback!.write;

    program.setVec("iResolution", [target.width, target.height, target.width / target.height]);
    program.setFloat("iTime", timing.audioTime);
    program.setFloat("iTimeDelta", timing.dt);
    program.setInt("iFrame", timing.frame);
    program.setVec("iMouse", [mouse.x, mouse.y, mouse.downX, mouse.downY]);

    program.setFloat("uSub", features.sub);
    program.setFloat("uBass", features.bass);
    program.setFloat("uLowMid", features.lowMid);
    program.setFloat("uMid", features.mid);
    program.setFloat("uHighMid", features.highMid);
    program.setFloat("uTreble", features.treble);
    program.setFloat("uLevel", features.rms);
    program.setFloat("uPeak", features.peak);
    program.setFloat("uCentroid", features.centroid);
    program.setFloat("uFlux", features.flux);
    program.setFloat("uOnset", features.onsetEnvelope);
    program.setFloat("uBpm", features.bpm ?? 0);
    program.setFloat("uBeatPhase", features.beatPhase);
    program.setFloat("uBeatConfidence", features.beatConfidence);

    // Copy rather than upload the analyser's array directly: its length
    // must match the shader's declared size exactly, and a source with a
    // different band count would otherwise silently upload garbage.
    const n = Math.min(this.spectrumScratch.length, features.logSpectrum.length);
    this.spectrumScratch.fill(0);
    this.spectrumScratch.set(features.logSpectrum.subarray(0, n));
    program.setFloatArray("uSpectrum", this.spectrumScratch);

    for (const decl of declarations) {
      const v = values[decl.name];
      if (v === undefined) continue;
      switch (decl.type) {
        case "int":
          program.setInt(decl.name, v as number);
          break;
        case "bool":
          program.setBool(decl.name, v as boolean);
          break;
        case "color": {
          const c = v as RGB;
          program.setVec(decl.name, [c.r, c.g, c.b]);
          break;
        }
        case "vec2":
        case "vec3":
          program.setVec(decl.name, v as number[]);
          break;
        case "enum":
          // Enums reach the shader as an int index. A string cannot be a
          // uniform, and the index is stable because the option list lives
          // in the declaration rather than in the preset.
          program.setInt(decl.name, indexOfEnum(decl, v as string));
          break;
        default:
          program.setFloat(decl.name, v as number);
      }
    }
  }

  private resize(scaleHint: number): void {
    const gl = this.ctx.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || 640;
    const cssH = this.canvas.clientHeight || 360;

    const canvasW = Math.max(2, Math.round(cssW * dpr));
    const canvasH = Math.max(2, Math.round(cssH * dpr));
    if (this.canvas.width !== canvasW || this.canvas.height !== canvasH) {
      this.canvas.width = canvasW;
      this.canvas.height = canvasH;
    }

    const size = this.scaler.sizeFor(cssW * scaleHint, cssH * scaleHint, dpr);

    if (!this.feedback) {
      this.feedback = new PingPong(gl, { width: size.width, height: size.height });
      this.mainTarget = this.feedback.write;
    } else {
      this.feedback.resize(size.width, size.height);
      this.mainTarget = this.feedback.write;
    }

    if (!this.prevTarget || this.prevTarget.width !== size.width || this.prevTarget.height !== size.height) {
      this.prevTarget?.dispose();
      this.prevTarget = new RenderTarget(gl, { width: size.width, height: size.height });
    }
  }

  private measureFrame(): void {
    const now = performance.now();
    if (this.lastFrameEndMs > 0) this.scaler.push(now - this.lastFrameEndMs);
    this.lastFrameEndMs = now;
  }

  dispose(): void {
    this.main.dispose();
    this.previous.dispose();
    this.composite.dispose();
    this.feedback?.dispose();
    this.prevTarget?.dispose();
  }

  /** After a context loss, the GL objects are gone but the sources are not. */
  invalidate(): void {
    this.main.invalidate();
    this.previous.invalidate();
    this.composite.invalidate();
    this.feedback = null;
    this.mainTarget = null;
    this.prevTarget = null;
  }
}

function indexOfEnum(decl: ParamDecl, value: string): number {
  if (decl.type !== "enum") return 0;
  const i = decl.options.indexOf(value);
  return i < 0 ? 0 : i;
}

export type { GL };
