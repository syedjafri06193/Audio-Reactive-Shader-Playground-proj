/**
 * A WebGL2 mock, enough to exercise the program and context modules.
 *
 * Not a GL implementation — it does not rasterise anything. What it does
 * model is the part the code under test actually depends on and the part
 * that is hard to get right: object lifetimes (so a use-after-delete is
 * detectable), link status driven by scripted compiler output, the
 * `KHR_parallel_shader_compile` completion flag, and the fact that uniform
 * locations belong to one program and are invalidated by a relink.
 */

export interface MockShader {
  id: number;
  type: number;
  source: string;
  deleted: boolean;
}

export interface MockProgram {
  id: number;
  shaders: MockShader[];
  linked: boolean;
  deleted: boolean;
  /** Set by the test to control whether this link succeeds. */
  completionStatus: boolean;
  infoLog: string;
}

export interface MockLocation {
  program: number;
  name: string;
}

export interface MockGLOptions {
  /** Pretend KHR_parallel_shader_compile exists. */
  parallel?: boolean;
  /**
   * Decide the outcome of a compile from its fragment source. Returning a
   * non-empty log makes the link fail, which is how a real driver behaves
   * for a syntax error.
   */
  compile?: (fragmentSource: string) => { infoLog: string };
}

export class MockGL {
  // Real GL enum values, so code that compares against them works.
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly LINK_STATUS = 0x8b82;
  readonly COMPILE_STATUS = 0x8b81;
  readonly ACTIVE_UNIFORMS = 0x8b86;
  readonly TEXTURE0 = 0x84c0;
  readonly TEXTURE_2D = 0x0de1;
  readonly VENDOR = 0x1f00;
  readonly RENDERER = 0x1f01;
  readonly VERSION = 0x1f02;

  private nextId = 1;
  readonly shaders = new Map<number, MockShader>();
  readonly programs = new Map<number, MockProgram>();
  private locations = new Map<string, MockLocation>();

  /** Every uniform write, in order, for assertions. */
  readonly uniformWrites: Array<{ program: number; name: string; value: unknown }> = [];
  currentProgram: MockProgram | null = null;
  contextLost = false;

  /** Uniform names the "linked" program declares. */
  declaredUniforms = new Set<string>(["uTime", "uBass", "uWarp", "uRes"]);

  constructor(private readonly options: MockGLOptions = {}) {}

  // -------------------------------------------------------------- shaders

  createShader(type: number): MockShader | null {
    const s = { id: this.nextId++, type, source: "", deleted: false };
    this.shaders.set(s.id, s);
    return s;
  }

  shaderSource(shader: MockShader, source: string): void {
    shader.source = source;
  }

  compileShader(_shader: MockShader): void {
    /* deferred to linkProgram, as real drivers effectively do */
  }

  getShaderInfoLog(shader: MockShader): string {
    if (shader.type !== this.FRAGMENT_SHADER) return "";
    return this.options.compile?.(shader.source).infoLog ?? "";
  }

  deleteShader(shader: MockShader): void {
    shader.deleted = true;
  }

  // ------------------------------------------------------------- programs

  createProgram(): MockProgram | null {
    const p: MockProgram = {
      id: this.nextId++,
      shaders: [],
      linked: false,
      deleted: false,
      completionStatus: true,
      infoLog: "",
    };
    this.programs.set(p.id, p);
    return p;
  }

  attachShader(program: MockProgram, shader: MockShader): void {
    program.shaders.push(shader);
  }

  linkProgram(program: MockProgram): void {
    const fs = program.shaders.find((s) => s.type === this.FRAGMENT_SHADER);
    const log = fs ? (this.options.compile?.(fs.source).infoLog ?? "") : "";
    program.linked = log === "";
    program.infoLog = program.linked ? "" : log;
  }

  getProgramParameter(program: MockProgram, pname: number): unknown {
    if (pname === this.LINK_STATUS) return program.linked;
    if (pname === 0x91b1) return program.completionStatus; // COMPLETION_STATUS_KHR
    if (pname === this.ACTIVE_UNIFORMS) return this.declaredUniforms.size;
    return null;
  }

  getActiveUniform(_program: MockProgram, index: number): { name: string } | null {
    const names = [...this.declaredUniforms];
    return index < names.length ? { name: names[index] } : null;
  }

  getProgramInfoLog(program: MockProgram): string {
    return program.infoLog;
  }

  deleteProgram(program: MockProgram): void {
    program.deleted = true;
    // Locations belong to the program and die with it, which is exactly
    // the lifetime bug this mock exists to catch.
    for (const [key, loc] of this.locations) {
      if (loc.program === program.id) this.locations.delete(key);
    }
  }

  useProgram(program: MockProgram | null): void {
    if (program?.deleted) throw new Error("useProgram on a deleted program");
    this.currentProgram = program;
  }

  // ------------------------------------------------------------- uniforms

  getUniformLocation(program: MockProgram, name: string): MockLocation | null {
    if (program.deleted) throw new Error("getUniformLocation on a deleted program");
    if (!this.declaredUniforms.has(name)) return null;
    const key = `${program.id}:${name}`;
    let loc = this.locations.get(key);
    if (!loc) {
      loc = { program: program.id, name };
      this.locations.set(key, loc);
    }
    return loc;
  }

  private write(loc: MockLocation, value: unknown): void {
    // A location from a deleted or different program is the classic
    // stale-handle bug after a relink.
    if (!this.locations.has(`${loc.program}:${loc.name}`)) {
      throw new Error(`stale uniform location for "${loc.name}"`);
    }
    if (this.currentProgram?.id !== loc.program) {
      throw new Error(`uniform "${loc.name}" written while a different program is bound`);
    }
    this.uniformWrites.push({ program: loc.program, name: loc.name, value });
  }

  uniform1f(loc: MockLocation, v: number): void {
    this.write(loc, v);
  }
  uniform1i(loc: MockLocation, v: number): void {
    this.write(loc, v);
  }
  uniform2f(loc: MockLocation, a: number, b: number): void {
    this.write(loc, [a, b]);
  }
  uniform3f(loc: MockLocation, a: number, b: number, c: number): void {
    this.write(loc, [a, b, c]);
  }
  uniform4f(loc: MockLocation, a: number, b: number, c: number, d: number): void {
    this.write(loc, [a, b, c, d]);
  }
  uniform1fv(loc: MockLocation, v: ArrayLike<number>): void {
    this.write(loc, Array.from(v));
  }

  activeTexture(_unit: number): void {}
  bindTexture(_target: number, _tex: unknown): void {}

  // ----------------------------------------------------------- extensions

  getExtension(name: string): unknown {
    if (name === "KHR_parallel_shader_compile") {
      return this.options.parallel ? {} : null;
    }
    return null;
  }

  getSupportedExtensions(): string[] {
    return this.options.parallel ? ["KHR_parallel_shader_compile"] : [];
  }

  getParameter(pname: number): unknown {
    if (pname === this.VENDOR) return "Mock";
    if (pname === this.RENDERER) return "Mock Renderer";
    if (pname === this.VERSION) return "WebGL 2.0 (Mock)";
    return null;
  }

  isContextLost(): boolean {
    return this.contextLost;
  }

  /** Every uniform write for one name, newest last. */
  writesFor(name: string): unknown[] {
    return this.uniformWrites.filter((w) => w.name === name).map((w) => w.value);
  }

  get liveProgramCount(): number {
    return [...this.programs.values()].filter((p) => !p.deleted).length;
  }

  get liveShaderCount(): number {
    return [...this.shaders.values()].filter((s) => !s.deleted).length;
  }
}

/** A mock canvas that records listeners and can fire the loss events. */
export class MockCanvas {
  private listeners = new Map<string, Set<(e: Event) => void>>();
  readonly gl: MockGL;
  /** Set to null to make getContext fail, as on a machine with no WebGL2. */
  contextResult: MockGL | null;

  constructor(gl = new MockGL()) {
    this.gl = gl;
    this.contextResult = gl;
  }

  getContext(type: string): MockGL | null {
    return type === "webgl2" ? this.contextResult : null;
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Fire an event and report whether anything called preventDefault. */
  fire(type: string): { defaultPrevented: boolean } {
    let prevented = false;
    const e = {
      type,
      preventDefault() {
        prevented = true;
      },
    } as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    return { defaultPrevented: prevented };
  }
}
