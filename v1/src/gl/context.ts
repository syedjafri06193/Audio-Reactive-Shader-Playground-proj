/**
 * Context creation, loss and restore.
 *
 * WebGL contexts are lost routinely — a laptop switching between integrated
 * and discrete GPUs, a driver update, the OS reclaiming GPU memory, a tab
 * backgrounded for long enough. On a page someone leaves running on a
 * projector all evening it is not an edge case.
 *
 * Two things make recovery work:
 *
 * 1. **`e.preventDefault()` on `webglcontextlost` is mandatory.** Without
 *    it the browser never fires `webglcontextrestored`, and the canvas is
 *    dead until reload. This single line is the difference between a
 *    two-second blink and a broken page.
 *
 * 2. **Resources are registered declaratively.** After a loss, *every* GL
 *    object is invalid — textures, buffers, programs, framebuffers, and the
 *    uniform locations that were looked up from them. Rebuilding by hand
 *    means remembering every allocation site; registering a factory at
 *    creation time means restore is a loop.
 */

export type GL = WebGL2RenderingContext;

/**
 * A resource that can be rebuilt from nothing.
 *
 * `create` is called on first build and again after every restore. It must
 * not close over any GL object created outside itself — that is exactly the
 * stale handle the loss invalidated.
 */
export interface ResourceSpec<T> {
  label: string;
  create(gl: GL): T;
  dispose?(gl: GL, value: T): void;
}

export interface ResourceHandle<T> {
  readonly label: string;
  /** Throws if read before the first build or during a loss. */
  readonly value: T;
  readonly alive: boolean;
}

export interface ContextOptions {
  /** Called after the context is restored and all resources rebuilt. */
  onRestored?: () => void;
  /** Called when the context is lost, before resources are marked dead. */
  onLost?: () => void;
  attributes?: WebGLContextAttributes;
}

/**
 * Attributes chosen for a shader playground specifically.
 *
 * `alpha: false` — a transparent canvas forces the compositor to blend
 * every frame against the page, which costs real time at full screen.
 *
 * `antialias: false` — the shader renders to an offscreen framebuffer that
 * the scaler resizes; MSAA on the default framebuffer would be paid for and
 * then thrown away.
 *
 * `powerPreference: "high-performance"` — asks a dual-GPU laptop for the
 * discrete chip. It is a hint, and requesting it is itself one of the
 * things that can trigger a context loss as the system switches GPUs, which
 * is another reason restore has to work.
 *
 * `preserveDrawingBuffer: false` — keeping it costs a full-screen copy per
 * frame. Screenshots are taken by reading back inside the same frame as the
 * draw instead.
 */
export const DEFAULT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  desynchronized: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: false,
  premultipliedAlpha: false,
};

class Resource<T> implements ResourceHandle<T> {
  current: T | null = null;

  constructor(readonly spec: ResourceSpec<T>) {}

  get label(): string {
    return this.spec.label;
  }

  get alive(): boolean {
    return this.current !== null;
  }

  get value(): T {
    if (this.current === null) {
      // Deliberately an exception rather than a null return. A caller that
      // silently skips a missing resource draws a black frame and reports
      // nothing; one that throws is caught by the render loop, which can
      // say "context lost, rebuilding" instead.
      throw new Error(`GL resource "${this.spec.label}" is not available (context lost?)`);
    }
    return this.current;
  }
}

export class GLContext {
  readonly gl: GL;
  private readonly resources: Array<Resource<unknown>> = [];
  private lost = false;
  private disposed = false;
  private readonly onLostHandler: (e: Event) => void;
  private readonly onRestoredHandler: () => void;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly options: ContextOptions = {},
  ) {
    const gl = canvas.getContext("webgl2", {
      ...DEFAULT_ATTRIBUTES,
      ...options.attributes,
    }) as GL | null;

    if (!gl) {
      // WebGL2 has no useful fallback for this project: the prelude uses
      // GLSL ES 3.00, and a WebGL1 path would mean maintaining a second
      // shader dialect for a shrinking set of devices.
      throw new Error(
        "WebGL2 is not available. This requires a browser from 2021 or later with hardware acceleration enabled.",
      );
    }
    this.gl = gl;

    this.onLostHandler = (e: Event) => {
      // Without this the browser will never fire `webglcontextrestored`.
      // It is the whole recovery path, in one line.
      e.preventDefault();
      this.handleLost();
    };
    this.onRestoredHandler = () => this.handleRestored();

    canvas.addEventListener("webglcontextlost", this.onLostHandler, false);
    canvas.addEventListener("webglcontextrestored", this.onRestoredHandler, false);
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /**
   * Register a resource and build it now.
   *
   * The returned handle stays valid across a loss/restore cycle; only the
   * object inside it is replaced. Callers hold the handle, never the raw GL
   * object, which is what makes restore invisible to them.
   */
  register<T>(spec: ResourceSpec<T>): ResourceHandle<T> {
    const res = new Resource(spec);
    this.resources.push(res as Resource<unknown>);
    if (!this.isLost) res.current = spec.create(this.gl);
    return res;
  }

  private handleLost(): void {
    this.lost = true;
    // Do NOT call dispose here. Every GL object is already invalid, and
    // calling deleteTexture on an invalid handle during a loss is at best
    // a no-op and at worst a driver crash.
    for (const r of this.resources) r.current = null;
    this.options.onLost?.();
  }

  private handleRestored(): void {
    this.lost = false;
    const failed: string[] = [];

    for (const r of this.resources) {
      try {
        r.current = r.spec.create(this.gl);
      } catch (err) {
        // One resource failing to rebuild should not abort the rest. A
        // playground that comes back with three of four passes working is
        // far better than one that comes back blank.
        failed.push(`${r.spec.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failed.length > 0) {
      console.error(`GL restore: ${failed.length} resource(s) failed to rebuild`, failed);
    }
    this.options.onRestored?.();
  }

  /**
   * Force a loss/restore cycle, for testing recovery.
   *
   * Exposed in the UI as a "simulate context loss" button. Almost nobody
   * tests this path otherwise, because it is untriggerable by hand, and so
   * almost every WebGL page is broken in exactly this way.
   */
  simulateLoss(restoreAfterMs = 1200): void {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    if (!ext) {
      console.warn("WEBGL_lose_context is unavailable; cannot simulate a loss.");
      return;
    }
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), restoreAfterMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.canvas.removeEventListener("webglcontextlost", this.onLostHandler);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestoredHandler);

    if (!this.isLost) {
      for (const r of this.resources) {
        if (r.current !== null) r.spec.dispose?.(this.gl, r.current);
      }
    }
    this.resources.length = 0;
  }

  /** For diagnostics and the platform-support panel. */
  describe(): { vendor: string; renderer: string; version: string; extensions: string[] } {
    const gl = this.gl;
    // WEBGL_debug_renderer_info is restricted or removed in several
    // browsers as a fingerprinting surface, so the unmasked strings are
    // best-effort and the masked ones are the fallback.
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: String(
        (dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR),
      ),
      renderer: String(
        (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER),
      ),
      version: String(gl.getParameter(gl.VERSION)),
      extensions: gl.getSupportedExtensions() ?? [],
    };
  }
}
