/**
 * Offscreen render targets and ping-pong buffers.
 *
 * The shader renders into a framebuffer rather than to the canvas, because
 * the resolution scaler needs to change the render size independently of
 * the display size, and because preset morphing crossfades two renders.
 *
 * Feedback effects — trails, reaction-diffusion, anything that reads last
 * frame — need two buffers, not one. Reading and writing the same texture
 * in one draw is undefined in WebGL and produces different garbage on every
 * driver, which is exactly the kind of bug that looks like an artistic
 * choice until someone opens it on another machine.
 */

import type { GL } from "./context.js";

export interface TargetOptions {
  width: number;
  height: number;
  /**
   * Half-float by default. 8-bit targets band visibly in feedback loops —
   * each pass quantises, and after thirty frames of a trail the gradient is
   * stepped. Half-float costs twice the bandwidth and is worth it; full
   * float is not, and on many mobile GPUs is not filterable anyway.
   */
  float?: boolean;
  /** Linear filtering. Off for anything read by exact texel. */
  linear?: boolean;
  /**
   * Clamp by default. Repeat wrapping in a feedback buffer smears the
   * right edge into the left, which reads as a bug rather than an effect.
   */
  wrap?: number;
}

export class RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;

  constructor(
    private readonly gl: GL,
    options: TargetOptions,
  ) {
    const { width, height } = options;
    this.width = width;
    this.height = height;

    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("RenderTarget: allocation failed");

    this.texture = texture;
    this.framebuffer = framebuffer;

    const float = options.float ?? true;
    const filter = (options.linear ?? true) ? gl.LINEAR : gl.NEAREST;
    const wrap = options.wrap ?? gl.CLAMP_TO_EDGE;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      float ? gl.RGBA16F : gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Almost always an unsupported format — half-float colour buffers
      // need EXT_color_buffer_float, which some mobile GPUs lack. Saying
      // which format failed turns an opaque hex code into something
      // actionable.
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw new Error(
        `Framebuffer incomplete (0x${status.toString(16)}) for ${width}×${height} ` +
          `${float ? "RGBA16F" : "RGBA8"}. Half-float targets require EXT_color_buffer_float.`,
      );
    }
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
  }
}

/**
 * Two targets, swapped each frame.
 *
 * `read` is last frame's result, `write` is where this frame goes. Calling
 * `swap()` after the draw is what makes feedback work; forgetting it is a
 * frozen image, which is at least an obvious symptom.
 */
export class PingPong {
  private a: RenderTarget;
  private b: RenderTarget;

  constructor(
    private readonly gl: GL,
    private options: TargetOptions,
  ) {
    this.a = new RenderTarget(gl, options);
    this.b = new RenderTarget(gl, options);
  }

  get read(): RenderTarget {
    return this.a;
  }

  get write(): RenderTarget {
    return this.b;
  }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  /**
   * Reallocate at a new size.
   *
   * The contents are *not* preserved. A feedback buffer resized mid-trail
   * loses its history, which is a visible one-frame flash — but the
   * alternative, blitting between different-sized float targets every time
   * the scaler moves, costs more than the flash does. The scaler's settle
   * period exists partly so this does not happen often.
   */
  resize(width: number, height: number): void {
    if (width === this.a.width && height === this.a.height) return;
    this.options = { ...this.options, width, height };
    this.a.dispose();
    this.b.dispose();
    this.a = new RenderTarget(this.gl, this.options);
    this.b = new RenderTarget(this.gl, this.options);
  }

  get width(): number {
    return this.a.width;
  }

  get height(): number {
    return this.a.height;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }
}

/**
 * The fullscreen triangle.
 *
 * A triangle rather than two triangles forming a quad. The quad's diagonal
 * makes the GPU shade the pixels along it twice, because fragments are
 * rasterised in 2×2 quads that straddle the seam. On a full-screen pass at
 * 4K that is a measurable waste for no benefit — a single oversized
 * triangle clipped to the viewport covers the same pixels exactly once.
 */
export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Draw the fullscreen triangle.
 *
 * No vertex buffer: positions come from `gl_VertexID` in the shader above.
 * WebGL2 still requires *some* VAO to be bound, so callers bind an empty
 * one once at startup.
 */
export function drawFullscreen(gl: GL): void {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
