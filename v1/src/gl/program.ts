/**
 * Shader compilation, hot reload and uniform binding.
 *
 * The single most important property of a live-coding playground: **a
 * broken edit must never take the picture away.** Someone typing during a
 * performance will pass through dozens of syntactically invalid states on
 * the way to a working one, and if each of those blanks the screen the tool
 * is unusable in the situation it exists for.
 *
 * So the working program is never unbound until a replacement has linked
 * successfully. The obvious implementation — delete, compile, bind — is
 * wrong on both counts: it loses the picture, and it loses it for the
 * entire duration of the compile, which on a large shader is hundreds of
 * milliseconds.
 */

import { hasErrors, mapDiagnostics, type ShaderDiagnostic } from "./errors.js";
import type { GL } from "./context.js";

export interface CompileResult {
  ok: boolean;
  diagnostics: ShaderDiagnostic[];
  /** Milliseconds from submission to link completion. */
  durationMs: number;
}

export interface ProgramSources {
  vertex: string;
  fragment: string;
  /** Lines injected above the user's fragment source, for error mapping. */
  preludeLines: number;
}

type UniformMap = Map<string, WebGLUniformLocation | null>;

interface Built {
  program: WebGLProgram;
  uniforms: UniformMap;
}

/**
 * `KHR_parallel_shader_compile` lets the driver compile off the main
 * thread; without it, `linkProgram` blocks. It exists in Chrome 76+ and
 * Safari 14.1+, and **has never shipped in Firefox**. That is not a gap to
 * work around with a polyfill — there is nothing to polyfill — so there are
 * genuinely two code paths, and the Firefox one is the blocking one.
 */
const COMPLETION_STATUS_KHR = 0x91b1;

export class ShaderProgram {
  /** The program currently being drawn with. Survives a failed edit. */
  private live: Built | null = null;
  /** A link in flight, polled for completion. */
  private pending: {
    program: WebGLProgram;
    vs: WebGLShader;
    fs: WebGLShader;
    sources: ProgramSources;
    startedAt: number;
    resolve: (r: CompileResult) => void;
  } | null = null;

  private readonly parallel: boolean;
  /** Uniform values, kept so a relink does not reset the patch. */
  private readonly cache = new Map<string, number | number[] | boolean>();

  constructor(private readonly gl: GL) {
    this.parallel = gl.getExtension("KHR_parallel_shader_compile") !== null;
  }

  get hasProgram(): boolean {
    return this.live !== null;
  }

  get isCompiling(): boolean {
    return this.pending !== null;
  }

  get usesParallelCompile(): boolean {
    return this.parallel;
  }

  /**
   * Compile and link a new program.
   *
   * Resolves when the link completes. The live program is replaced only on
   * success; on failure it is left exactly as it was and the diagnostics
   * are returned for the editor's gutter.
   */
  compile(sources: ProgramSources): Promise<CompileResult> {
    const gl = this.gl;

    // Abandon any in-flight compile. Someone typing produces a new one
    // every keystroke, and finishing the stale ones wastes GPU time and
    // can deliver an older result after a newer one.
    this.abandonPending();

    const startedAt = now();
    const vs = this.createShader(gl.VERTEX_SHADER, sources.vertex);
    const fs = this.createShader(gl.FRAGMENT_SHADER, sources.fragment);

    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return Promise.resolve({
        ok: false,
        diagnostics: [
          {
            severity: "error",
            line: null,
            column: null,
            message: "could not allocate a shader object",
            raw: "",
          },
        ],
        durationMs: now() - startedAt,
      });
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return Promise.resolve({
        ok: false,
        diagnostics: [
          { severity: "error", line: null, column: null, message: "could not allocate a program", raw: "" },
        ],
        durationMs: now() - startedAt,
      });
    }

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!this.parallel) {
      // Firefox. linkProgram has already blocked until done, so polling
      // would only add latency.
      return Promise.resolve(this.finish(program, vs, fs, sources, startedAt));
    }

    return new Promise<CompileResult>((resolve) => {
      this.pending = { program, vs, fs, sources, startedAt, resolve };
    });
  }

  /**
   * Poll an in-flight parallel compile. Call once per frame.
   *
   * Polling from the render loop rather than from a timer keeps the check
   * off the critical path: querying COMPLETION_STATUS before the driver is
   * done is cheap, but `getProgramParameter(LINK_STATUS)` is a synchronous
   * flush that discards the whole point of compiling in parallel.
   */
  poll(): CompileResult | null {
    const p = this.pending;
    if (!p) return null;

    const done = this.gl.getProgramParameter(p.program, COMPLETION_STATUS_KHR);
    if (!done) return null;

    this.pending = null;
    const result = this.finish(p.program, p.vs, p.fs, p.sources, p.startedAt);
    p.resolve(result);
    return result;
  }

  private finish(
    program: WebGLProgram,
    vs: WebGLShader,
    fs: WebGLShader,
    sources: ProgramSources,
    startedAt: number,
  ): CompileResult {
    const gl = this.gl;
    const durationMs = now() - startedAt;

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
    const diagnostics: ShaderDiagnostic[] = [];

    // Collect per-shader logs regardless of link status: a program can link
    // while a shader emitted warnings, and those belong in the gutter too.
    for (const [shader, isFragment] of [
      [vs, false],
      [fs, true],
    ] as const) {
      const log = gl.getShaderInfoLog(shader);
      if (log) {
        // Only the fragment shader carries the prelude offset; the vertex
        // shader is ours entirely, so its line numbers are already
        // absolute and shifting them would point at nothing.
        diagnostics.push(...mapDiagnostics(log, isFragment ? sources.preludeLines : 0));
      }
    }

    if (!linked) {
      const log = gl.getProgramInfoLog(program);
      // A link error has no line number at all — it is about two shaders
      // disagreeing (a varying declared in one and not the other), so the
      // prelude offset is meaningless here.
      if (log) diagnostics.push(...mapDiagnostics(log, 0));
    }

    // Shader objects are reference-counted by the program; deleting them
    // now is correct and standard, and frees the source strings.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!linked || hasErrors(diagnostics)) {
      gl.deleteProgram(program);
      // The live program is untouched. This is the whole point: the
      // picture stays up while the user fixes their typo.
      return { ok: false, diagnostics, durationMs };
    }

    const previous = this.live;
    this.live = { program, uniforms: new Map() };

    // Uniform locations are invalidated by a relink and are not
    // transferable between programs. Clearing rather than copying is
    // essential; a stale WebGLUniformLocation applied to a new program is
    // undefined behaviour, and in practice writes to the wrong uniform.
    gl.useProgram(program);
    this.replayUniforms();

    if (previous) gl.deleteProgram(previous.program);

    return { ok: true, diagnostics, durationMs };
  }

  private createShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  private abandonPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.gl.deleteShader(p.vs);
    this.gl.deleteShader(p.fs);
    this.gl.deleteProgram(p.program);
    p.resolve({
      ok: false,
      diagnostics: [
        {
          severity: "warning",
          line: null,
          column: null,
          message: "superseded by a newer edit",
          raw: "",
        },
      ],
      durationMs: now() - p.startedAt,
    });
  }

  use(): void {
    if (this.live) this.gl.useProgram(this.live.program);
  }

  get program(): WebGLProgram | null {
    return this.live?.program ?? null;
  }

  /**
   * Look up a uniform location, memoised per program.
   *
   * `getUniformLocation` is a synchronous driver call; doing it per uniform
   * per frame is a measurable cost with thirty uniforms at 60 fps. The
   * cache is keyed on the built program, so a relink starts an empty one.
   */
  private location(name: string): WebGLUniformLocation | null {
    const live = this.live;
    if (!live) return null;

    let loc = live.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(live.program, name);
      live.uniforms.set(name, loc);
    }
    return loc;
  }

  /**
   * Set a uniform, remembering the value.
   *
   * The memory is what makes hot reload feel continuous: after an edit,
   * every uniform the new shader still declares is restored to what the
   * user had it at. Without this, every keystroke resets the whole patch
   * to defaults — technically a reload, but useless to perform with.
   *
   * A uniform the new shader dropped is kept in the cache rather than
   * discarded, so that undoing the edit brings its value back too.
   */
  setFloat(name: string, v: number): void {
    this.cache.set(name, v);
    const loc = this.location(name);
    if (loc) this.gl.uniform1f(loc, v);
  }

  setInt(name: string, v: number): void {
    this.cache.set(name, Math.round(v));
    const loc = this.location(name);
    if (loc) this.gl.uniform1i(loc, Math.round(v));
  }

  setBool(name: string, v: boolean): void {
    this.cache.set(name, v);
    const loc = this.location(name);
    if (loc) this.gl.uniform1i(loc, v ? 1 : 0);
  }

  setVec(name: string, v: number[]): void {
    this.cache.set(name, [...v]);
    const loc = this.location(name);
    if (!loc) return;
    const gl = this.gl;
    switch (v.length) {
      case 2:
        gl.uniform2f(loc, v[0], v[1]);
        break;
      case 3:
        gl.uniform3f(loc, v[0], v[1], v[2]);
        break;
      case 4:
        gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
        break;
      default:
        gl.uniform1fv(loc, v);
    }
  }

  /** Not cached: replaying a whole spectrum array would cost more than it saves. */
  setFloatArray(name: string, v: Float32Array): void {
    const loc = this.location(name);
    if (loc) this.gl.uniform1fv(loc, v);
  }

  setTexture(name: string, unit: number, texture: WebGLTexture, target = 0x0de1): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
    const loc = this.location(name);
    if (loc) gl.uniform1i(loc, unit);
  }

  private replayUniforms(): void {
    for (const [name, v] of this.cache) {
      const loc = this.location(name);
      if (!loc) continue;
      if (typeof v === "number") this.gl.uniform1f(loc, v);
      else if (typeof v === "boolean") this.gl.uniform1i(loc, v ? 1 : 0);
      else this.setVec(name, v);
    }
  }

  /** Which uniforms the live program actually declares. */
  activeUniforms(): string[] {
    const live = this.live;
    if (!live) return [];
    const gl = this.gl;
    const n = gl.getProgramParameter(live.program, gl.ACTIVE_UNIFORMS) as number;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(live.program, i);
      // Array uniforms are reported as "uFoo[0]"; the base name is what a
      // caller asked for.
      if (info) out.push(info.name.replace(/\[0\]$/, ""));
    }
    return out;
  }

  dispose(): void {
    this.abandonPending();
    if (this.live) {
      this.gl.deleteProgram(this.live.program);
      this.live = null;
    }
    this.cache.clear();
  }

  /** Drop program state after a context loss; the cache is kept deliberately. */
  invalidate(): void {
    this.live = null;
    this.pending = null;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
