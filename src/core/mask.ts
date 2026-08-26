import { createTarget } from "./gl.js";

/* the mask is a soft field, not an image: display resolution is wasted on it.
   Its 8 bits are exact for what runs over it: the feedback pass writes
   max(prev - whole 1/255 steps, brush), so a value either keeps the level it
   already had or is replaced by the brush profile. Nothing is ever multiplied
   or re-quantised in place, which is why a persistent reveal (`brush.persist`,
   decay pinned to 0) can be left painted for a whole session without the flats
   drifting apart into bands. */
export const MASK_MAX = 1024;
export const MASK_MIN = 64;

/* Hard cap on capsule draws per frame. One capsule is already a continuous
   stroke; the extras only follow curvature inside a frame (pointer) or belong
   to a concurrent idle stroke. Worst case is MAX_CAPSULES mask passes plus the
   single display pass, whatever the pointer and the idle pool are doing. */
export const MAX_CAPSULES = 7;
/* Pointer polyline capsules, capped independently so a pointer sweeping over an
   idle-free field costs no more than it would with no pool at all. Four idle
   strokes owe one capsule each, and 4 + MAX_POLY is exactly MAX_CAPSULES, so a
   full pool never eats into the pointer's share. */
export const MAX_POLY = 3;

export interface MaskPair {
  tex: [WebGLTexture, WebGLTexture];
  fbo: [WebGLFramebuffer, WebGLFramebuffer];
  w: number;
  h: number;
}

/** The ping-pong pair the feedback pass reads from and writes to. */
export function createMaskPair(
  gl: WebGLRenderingContext,
  w: number,
  h: number
): MaskPair | null {
  const a = createTarget(gl, w, h, gl.LINEAR);
  const b = a ? createTarget(gl, w, h, gl.LINEAR) : null;
  if (!a || !b) {
    if (a) {
      gl.deleteTexture(a.tex);
      gl.deleteFramebuffer(a.fbo);
    }
    return null;
  }
  const pair: MaskPair = {
    tex: [a.tex, b.tex],
    fbo: [a.fbo, b.fbo],
    w,
    h,
  };
  /* WebGL zero-fills a null upload, but clear anyway: the first frame must
     never show a reveal, and it costs two calls once */
  fillMaskPair(gl, pair, 0);
  return pair;
}

/** Flood both halves of the pair with a constant mask value. Both, because
 *  either can be the one the next pass reads - which is what makes `clear()`
 *  authoritative even with `brush.persist` on, where it is the only way back.
 *
 *  G and B go to 128/255, NOT 0: they hold a velocity biased so that 128 is
 *  zero. A pair flooded with 0 there reads as velocity (-1, -1) everywhere and
 *  the whole field leaves the plate at full speed on the first frame - which
 *  looks like a driver fault rather than a logic error, so it is worth being
 *  loud about. Every fill site goes through here for exactly that reason. */
export const VEL_ZERO = 128 / 255;

export function fillMaskPair(
  gl: WebGLRenderingContext,
  pair: MaskPair,
  value: number
): void {
  gl.clearColor(value, VEL_ZERO, VEL_ZERO, 1);
  for (let i = 0; i < 2; i++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, pair.fbo[i]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(0, 0, 0, 0);
}

export function freeMaskPair(
  gl: WebGLRenderingContext,
  pair: MaskPair | null
): void {
  if (!pair) return;
  for (let i = 0; i < 2; i++) {
    gl.deleteTexture(pair.tex[i]);
    gl.deleteFramebuffer(pair.fbo[i]);
  }
}

/** Per-frame capsule queue. Fixed-size typed arrays: the loop never allocates. */
export class CapsuleQueue {
  /** ax, ay, bx, by per capsule, in plate uv */
  readonly seg = new Float32Array(MAX_CAPSULES * 4);
  readonly amp = new Float32Array(MAX_CAPSULES);
  readonly rad = new Float32Array(MAX_CAPSULES);
  n = 0;

  reset(): void {
    this.n = 0;
  }

  push(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    amp: number,
    rad: number
  ): void {
    if (this.n >= MAX_CAPSULES) return;
    const o = this.n * 4;
    this.seg[o] = ax;
    this.seg[o + 1] = ay;
    this.seg[o + 2] = bx;
    this.seg[o + 3] = by;
    this.amp[this.n] = amp;
    this.rad[this.n] = rad;
    this.n++;
  }
}
