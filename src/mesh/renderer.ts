/* The wireframe pass. Renders an edge list into an offscreen RGBA8 texture
   that the display pass binds as `uSkel` — so the display shader is unchanged,
   the skeleton is still stamped onto the front plate before the reveal mix, and
   `draw`/`hold`/`pulse`/`reactive` all keep working on the sampled texture.

   Nothing here imports from ../core. The one shared assumption is that the host
   samples the skeleton with the plate's y-DOWN uv, which `perspectiveFlipY`
   accounts for. */

import { mat4, modelView, multiply, perspectiveFlipY, type Mat4 } from "./mat4.js";
import type {
  MeshData,
  MeshPointer,
  MeshSkeletonHandle,
  MeshSkeletonOptions,
} from "./types.js";

const PRECISION = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const FOV = 0.6108652381980153; // 35 degrees
const HALF_TAN = Math.tan(FOV / 2);
/** pitch is desktop-only on the reference, and a phone has no hover for the
 *  yaw either, so both are gated on the same width */
const TILT_MIN_WIDTH = 768;
/** expanded quads cost 4 vertices per edge, so Uint16 bites four times sooner */
const MAX_THICK_EDGES = 16384;

/** Frame-rate-independent exponential approach. Identical in form to the
 *  core's `fri` helper; duplicated rather than imported because this module is
 *  a leaf and must not depend on core internals. */
const fri = (k: number, dt: number): number => 1 - Math.pow(1 - k, dt * 60);

function vertexSrc(thick: boolean): string {
  return thick
    ? `${PRECISION}
attribute vec3 aPos;
attribute vec3 aOther;
attribute float aSide;
uniform mat4 uMvp;
uniform vec2 uOffset;
uniform vec2 uPxToNdc;  // 2/width, 2/height of the target
uniform float uHalf;    // half line width, in target pixels
varying float vY;
void main(){
  vY = aPos.y;
  vec4 p = uMvp * vec4(aPos, 1.0);
  vec4 q = uMvp * vec4(aOther, 1.0);
  p.xy += uOffset * p.w;
  q.xy += uOffset * q.w;
  vec2 d = (q.xy / q.w - p.xy / p.w) / uPxToNdc;
  float l = length(d);
  /* a zero-length edge cannot have a perpendicular; any direction will do,
     the quad collapses either way */
  vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
  p.xy += vec2(-dir.y, dir.x) * (uHalf * aSide) * uPxToNdc * p.w;
  gl_Position = p;
}
`
    : `${PRECISION}
attribute vec3 aPos;
uniform mat4 uMvp;
uniform vec2 uOffset;
varying float vY;
void main(){
  vec4 p = uMvp * vec4(aPos, 1.0);
  p.xy += uOffset * p.w;
  vY = aPos.y;
  gl_Position = p;
}
`;
}

/* Alpha only, premultiplied black — so the target is valid for the display
   pass's "alpha" branch (which reads `.a` and tints with `uSkelColor`) and also
   for "image" (which expects premultiplied rgb). `uScan` is (bands, phase,
   amount); phase is wrapped on the CPU so no unbounded time reaches a mediump
   float. The 4th power gives a sharp leading edge and a long tail, as the
   reference does. */
const FRAGMENT_SRC = `${PRECISION}
varying float vY;
uniform vec3 uScan;
uniform float uAlpha;
void main(){
  float band = fract(-vY * uScan.x - uScan.y);
  band *= band; band *= band;
  float a = uAlpha * mix(1.0, band, uScan.z);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

interface GlState {
  fbo: WebGLFramebuffer | null;
  viewport: Int32Array;
  clear: Float32Array;
  program: WebGLProgram | null;
  array: WebGLBuffer | null;
  element: WebGLBuffer | null;
  blend: boolean;
  blendSrcRgb: number;
  blendDstRgb: number;
  blendSrcA: number;
  blendDstA: number;
  depth: boolean;
  /** only read when this pass has a depth attachment of its own */
  depthMask: boolean;
  depthFunc: number;
  scissor: boolean;
  attribs: Array<{
    enabled: boolean;
    buffer: WebGLBuffer | null;
    size: number;
    type: number;
    normalized: boolean;
    stride: number;
    offset: number;
  }>;
}

export class MeshWireframe implements MeshSkeletonHandle {
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private tex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private rbo: WebGLRenderbuffer | null = null;
  /** true when no framebuffer could be allocated: the texture is one
   *  transparent texel and the pass never draws. Inert, not absent. */
  inert = false;

  private u: Record<string, WebGLUniformLocation | null> = {};
  private data: MeshData | null = null;
  private indexCount = 0;
  private thickBuild = false;

  private fw = 2;
  private fh = 2;
  private plateW = 1;
  private plateH = 1;

  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private time = 0;
  private cleared = false;
  private needs = true;

  private mq: MediaQueryList | null = null;
  private mqReduced = false;
  private destroyed = false;
  /** set the moment the host's context is lost and cleared only by the next
   *  `create()`. Between the restore event and the host's `create()` the
   *  context is live again but every object we hold belongs to the previous
   *  context, so touching one would raise INVALID_OPERATION in the host's log.
   *  A flag costs nothing per frame; an `is*` probe would flush the command
   *  queue every frame. */
  private lost = false;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;

  private mv: Mat4 = mat4();
  private proj: Mat4 = mat4();
  private mvp: Mat4 = mat4();

  private o: Required<
    Omit<MeshSkeletonOptions, "mesh" | "onError" | "reducedMotion">
  > & { reducedMotion: boolean | null };

  constructor(opts: MeshSkeletonOptions) {
    this.o = {
      meshParallax: opts.meshParallax ?? 5,
      meshDamping: opts.meshDamping ?? 0.03,
      meshTilt: opts.meshTilt ?? 10,
      meshScale: opts.meshScale ?? 1,
      meshOffset: opts.meshOffset ?? [0, 0],
      thickness: opts.thickness ?? 1,
      mode: opts.mode ?? "draw",
      period: opts.period ?? 5.4,
      meshResolution: opts.meshResolution ?? 512,
      meshAlpha: opts.meshAlpha ?? 0.55,
      meshDepth: opts.meshDepth ?? false,
      reducedMotion: opts.reducedMotion ?? null,
    };
    this.clampOptions();
    this.watchMotion();
    this.pitch = this.targetPitch = this.neutralPitch();
  }

  /* ================================================================ *
   * public surface
   * ================================================================ */

  get texture(): WebGLTexture | null {
    return this.tex;
  }
  get ready(): boolean {
    return this.indexCount > 0 && this.prog !== null && this.fbo !== null;
  }
  get edgeCount(): number {
    return this.data ? this.data.edges.length / 2 : 0;
  }
  get dirty(): boolean {
    return this.needs;
  }

  /** Hand the pass a parsed mesh. `null` releases it and leaves a transparent
   *  target — which is exactly the failure story: inert, not absent. */
  setMesh(data: MeshData | null): void {
    this.data = data;
    this.needs = true;
    this.cleared = false;
    if (this.gl) this.uploadBuffers();
  }

  create(gl: WebGLRenderingContext): boolean {
    if (this.destroyed) return false;
    this.releaseGl();
    this.gl = gl;
    this.watchContext(gl);
    if (gl.isContextLost()) {
      this.lost = true;
      return false;
    }
    this.lost = false;
    this.prog = this.buildProgram();
    if (this.prog) this.uploadBuffers();
    const ok = this.buildTarget();
    this.needs = true;
    this.cleared = false;
    return ok;
  }

  resize(width: number, height: number): void {
    const w = width > 0 ? width : 1;
    const h = height > 0 ? height : 1;
    if (w === this.plateW && h === this.plateH) return;
    this.plateW = w;
    this.plateH = h;
    if (this.gl) this.buildTarget();
    this.needs = true;
  }

  update(dt: number, pointer: MeshPointer | null): void {
    if (this.destroyed) return;
    const d = dt > 0 && dt < 0.25 ? dt : 1 / 60;
    const reduced = this.reduced();
    const tilt = this.neutralPitch();

    if (reduced) {
      /* freeze at the neutral pose rather than disabling the mesh: a still
         wireframe is a perfectly good hint, and removing it would change the
         layout's visual weight */
      if (this.yaw !== 0 || this.pitch !== tilt) this.needs = true;
      this.yaw = this.targetYaw = 0;
      this.pitch = this.targetPitch = tilt;
      return;
    }

    const rad = Math.PI / 180;
    const px = pointer ? clamp(pointer.x, -1, 1) : 0;
    const py = pointer ? clamp(pointer.y, -1, 1) : 0;
    this.targetYaw = px * this.o.meshParallax * rad;
    /* pointer y is y-DOWN, so a downward pointer pitches the model's top
       toward the viewer — the same sign the reference produces from its y-up
       normalised mouse times -1 */
    this.targetPitch = tilt + py * this.o.meshParallax * 0.6 * rad;

    const k = fri(clamp(this.o.meshDamping, 0.001, 1), d);
    const y0 = this.yaw;
    const p0 = this.pitch;
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    if (Math.abs(this.yaw - y0) > 1e-5 || Math.abs(this.pitch - p0) > 1e-5)
      this.needs = true;

    if (this.o.mode === "scan") {
      this.time += d;
      const p = this.o.period > 0 ? this.o.period : 5.4;
      if (this.time >= p) this.time -= Math.floor(this.time / p) * p;
      this.needs = true;
    }
  }

  render(): void {
    const gl = this.gl;
    if (!gl || this.destroyed || this.lost || gl.isContextLost()) return;
    if (!this.fbo) return;
    /* nothing to draw and the target is already transparent: the cheapest
       possible no-op, which is what a failed or absent mesh costs per frame */
    if (this.indexCount === 0 && this.cleared) {
      this.needs = false;
      return;
    }

    const s = this.save(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.fw, this.fh);
    if (s.scissor) gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    if (this.rbo) {
      /* a host that left DEPTH_WRITEMASK false would mask our depth clear and
         leave the attachment full of the previous frame's garbage, so both are
         set explicitly and put back in restore() */
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      if (s.depth) gl.disable(gl.DEPTH_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.cleared = true;

    if (this.indexCount > 0 && this.prog && this.vbo && this.ibo) {
      /* premultiplied "over": the fragment writes rgb already multiplied by a,
         so alpha accumulates as a + dst*(1-a) and overlapping edges darken
         without the squaring a plain SRC_ALPHA blend would give */
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.prog);
      this.bindAttribs(gl);
      this.uploadUniforms(gl);
      gl.drawElements(
        this.thickBuild ? gl.TRIANGLES : gl.LINES,
        this.indexCount,
        gl.UNSIGNED_SHORT,
        0
      );
    }

    this.restore(gl, s);
    this.needs = false;
  }

  setOptions(patch: Partial<MeshSkeletonOptions>): void {
    const beforeThick = this.o.thickness > 1;
    const beforeRes = this.o.meshResolution;
    const beforeDepth = this.o.meshDepth;
    for (const k of Object.keys(patch) as Array<keyof MeshSkeletonOptions>) {
      const v = patch[k];
      if (v === undefined || k === "mesh" || k === "onError") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.o as any)[k] = v;
    }
    this.clampOptions();
    const live = this.gl !== null && !this.lost && !this.gl.isContextLost();
    if (live && this.o.thickness > 1 !== beforeThick) {
      const wasStale = this.stale();
      const p = this.buildProgram();
      if (p) {
        if (this.prog && !wasStale) this.gl!.deleteProgram(this.prog);
        this.prog = p;
        this.uploadBuffers();
      }
    }
    if (
      live &&
      (this.o.meshResolution !== beforeRes || this.o.meshDepth !== beforeDepth)
    ) {
      /* force a re-spec: the dimensions may be unchanged while the depth
         attachment is not */
      this.fw = this.fh = 0;
      this.buildTarget();
    }
    this.needs = true;
    this.cleared = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseGl();
    this.unwatchContext();
    this.gl = null;
    this.data = null;
    if (this.mq) {
      const h = this.onMotion as EventListener;
      if (this.mq.removeEventListener) this.mq.removeEventListener("change", h);
      else if (this.mq.removeListener) this.mq.removeListener(h as never);
      this.mq = null;
    }
  }

  /* ================================================================ *
   * gl objects
   * ================================================================ */

  private buildProgram(): WebGLProgram | null {
    const gl = this.gl;
    if (!gl) return null;
    const thick = this.o.thickness > 1;
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSrc(thick));
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }
    const p = gl.createProgram();
    if (!p) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "aPos");
    if (thick) {
      gl.bindAttribLocation(p, 1, "aOther");
      gl.bindAttribLocation(p, 2, "aSide");
    }
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      gl.deleteProgram(p);
      return null;
    }
    for (const n of ["uMvp", "uOffset", "uScan", "uAlpha", "uPxToNdc", "uHalf"])
      this.u[n] = gl.getUniformLocation(p, n);
    return p;
  }

  /** Build the vertex and index buffers for the current mesh and thickness.
   *  Thin is the mesh's own positions with an edge index buffer; thick expands
   *  every edge into four vertices carrying both endpoints and a side. */
  private uploadBuffers(): void {
    const gl = this.gl;
    if (!gl) return;
    if (!this.stale()) {
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.ibo) gl.deleteBuffer(this.ibo);
    }
    this.vbo = null;
    this.ibo = null;
    this.indexCount = 0;
    /* a mesh that arrives while the context is down is kept in `data` and
       uploaded by the host's next `create()` — never dropped */
    if (this.lost || gl.isContextLost()) return;
    const d = this.data;
    if (!d || d.edges.length < 2) return;

    const edges = d.edges.length / 2;
    const thick = this.o.thickness > 1 && edges <= MAX_THICK_EDGES;
    this.thickBuild = thick;

    let verts: Float32Array;
    let idx: Uint16Array;
    if (thick) {
      verts = new Float32Array(edges * 4 * 7);
      idx = new Uint16Array(edges * 6);
      for (let e = 0; e < edges; e++) {
        const a = d.edges[e * 2] * 3;
        const b = d.edges[e * 2 + 1] * 3;
        const base = e * 4;
        /* side is negated on the far endpoint: its screen-space direction is
           the reverse of the near one's, so the perpendicular flips with it */
        const quad = [
          [a, b, -1],
          [a, b, 1],
          [b, a, 1],
          [b, a, -1],
        ];
        for (let k = 0; k < 4; k++) {
          const self = quad[k][0];
          const other = quad[k][1];
          const w = (base + k) * 7;
          verts[w] = d.positions[self];
          verts[w + 1] = d.positions[self + 1];
          verts[w + 2] = d.positions[self + 2];
          verts[w + 3] = d.positions[other];
          verts[w + 4] = d.positions[other + 1];
          verts[w + 5] = d.positions[other + 2];
          verts[w + 6] = quad[k][2];
        }
        const i = e * 6;
        idx[i] = base;
        idx[i + 1] = base + 1;
        idx[i + 2] = base + 2;
        idx[i + 3] = base + 2;
        idx[i + 4] = base + 1;
        idx[i + 5] = base + 3;
      }
    } else {
      verts = d.positions;
      idx = d.edges;
    }

    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vbo || !ibo) {
      if (vbo) gl.deleteBuffer(vbo);
      if (ibo) gl.deleteBuffer(ibo);
      return;
    }
    const prevA = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const prevE = gl.getParameter(
      gl.ELEMENT_ARRAY_BUFFER_BINDING
    ) as WebGLBuffer | null;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevA);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prevE);
    this.vbo = vbo;
    this.ibo = ibo;
    this.indexCount = idx.length;
    this.needs = true;
  }

  /** RGBA8 colour target at the skeleton resolution, plus — only if asked — a
   *  depth renderbuffer on OUR framebuffer, which is why the host context's
   *  `depth: false` never matters here.
   *
   *  The texture OBJECT is created once per context and only ever re-specced,
   *  so `handle.texture` is stable across resizes and the host does not have to
   *  rebind on every layout change. It changes only across `create()`. */
  private buildTarget(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const cap = this.o.meshResolution;
    const s = Math.min(1, cap / Math.max(this.plateW, this.plateH));
    const w = Math.max(2, Math.round(this.plateW * s));
    const h = Math.max(2, Math.round(this.plateH * s));
    if (!this.tex) {
      this.tex = gl.createTexture();
      if (!this.tex) return false;
    } else if (this.fbo && w === this.fw && h === this.fh) {
      return true;
    }
    this.fw = w;
    this.fh = h;

    const prevTex = gl.getParameter(
      gl.TEXTURE_BINDING_2D
    ) as WebGLTexture | null;
    const prevFbo = gl.getParameter(
      gl.FRAMEBUFFER_BINDING
    ) as WebGLFramebuffer | null;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    if (!this.fbo) this.fbo = gl.createFramebuffer();
    if (!this.fbo) {
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
      return this.inertTexture(prevTex);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.tex,
      0
    );
    if (this.o.meshDepth) {
      if (!this.rbo) this.rbo = gl.createRenderbuffer();
      if (this.rbo) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbo);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER,
          this.rbo
        );
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      }
    } else if (this.rbo) {
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        null
      );
      gl.deleteRenderbuffer(this.rbo);
      this.rbo = null;
    }
    const ok =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    if (!ok) {
      gl.deleteFramebuffer(this.fbo);
      this.fbo = null;
      if (this.rbo) gl.deleteRenderbuffer(this.rbo);
      this.rbo = null;
      return this.inertTexture(prevTex);
    }
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    this.inert = false;
    this.cleared = false;
    this.needs = true;
    return true;
  }

  /** No framebuffer: leave the texture as one transparent texel and never draw.
   *  The host binds `uSkel` before the mesh has loaded, and an INCOMPLETE
   *  texture samples as opaque BLACK in WebGL1 — i.e. a full-plate black stamp.
   *  This is the difference between "no skeleton" and "the plate went dark". */
  private inertTexture(prevTex: WebGLTexture | null): boolean {
    const gl = this.gl;
    if (!gl || !this.tex) return false;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0])
    );
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    this.fw = this.fh = 1;
    this.inert = true;
    return true;
  }

  /** True when the objects we hold no longer belong to the live context — i.e.
   *  the context was lost, and possibly already restored under us. Deleting one
   *  of them then raises INVALID_OPERATION, which would surface in the host's
   *  error log as a driver-level fault on every context restore. They are
   *  already gone with the old context, so the right move is to drop the
   *  references and allocate fresh ones.
   *
   *  `isProgram` is the probe rather than `isBuffer`, because the buffer/texture
   *  queries also answer false for an object that has never been bound, and
   *  only `isProgram` is unambiguous. */
  private stale(): boolean {
    const gl = this.gl;
    if (!gl) return true;
    if (this.lost || gl.isContextLost()) return true;
    if (this.prog !== null) return !gl.isProgram(this.prog);
    if (this.tex !== null) return !gl.isTexture(this.tex);
    return false;
  }

  private releaseTarget(abandon: boolean): void {
    const gl = this.gl;
    if (gl && !abandon) {
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.rbo) gl.deleteRenderbuffer(this.rbo);
    }
    this.tex = null;
    this.fbo = null;
    this.rbo = null;
    this.inert = false;
  }

  private releaseGl(): void {
    const gl = this.gl;
    if (!gl) return;
    const abandon = this.stale();
    if (!abandon) {
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.ibo) gl.deleteBuffer(this.ibo);
      if (this.prog) gl.deleteProgram(this.prog);
    }
    this.vbo = null;
    this.ibo = null;
    this.prog = null;
    this.indexCount = 0;
    this.u = {};
    this.releaseTarget(abandon);
  }

  /* ================================================================ *
   * draw
   * ================================================================ */

  private bindAttribs(gl: WebGLRenderingContext): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    if (this.thickBuild) {
      const stride = 7 * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);
    } else {
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    }
  }

  private uploadUniforms(gl: WebGLRenderingContext): void {
    const scale = this.o.meshScale > 0 ? this.o.meshScale : 1;
    /* the model is normalised to a unit box, so filling `scale` of the plate
       height means a visible half-height of 0.5/scale at the camera distance */
    const dist = 0.5 / (scale * HALF_TAN);
    perspectiveFlipY(this.proj, FOV, this.fw / this.fh, 0.05, dist + 2);
    modelView(this.mv, this.yaw, this.pitch, dist);
    multiply(this.mvp, this.proj, this.mv);
    if (this.u.uMvp) gl.uniformMatrix4fv(this.u.uMvp, false, this.mvp);
    const off = this.o.meshOffset;
    /* plate uv is y-down and the projection already flipped y, so the uv
       offset maps to clip space with a plain *2 on both axes */
    if (this.u.uOffset) gl.uniform2f(this.u.uOffset, off[0] * 2, off[1] * 2);
    if (this.u.uAlpha) gl.uniform1f(this.u.uAlpha, this.o.meshAlpha);
    if (this.u.uScan) {
      const scanning = this.o.mode === "scan" && !this.reduced();
      const p = this.o.period > 0 ? this.o.period : 5.4;
      gl.uniform3f(this.u.uScan, 10, scanning ? this.time / p : 0, scanning ? 1 : 0);
    }
    if (this.thickBuild) {
      if (this.u.uPxToNdc)
        gl.uniform2f(this.u.uPxToNdc, 2 / this.fw, 2 / this.fh);
      if (this.u.uHalf) gl.uniform1f(this.u.uHalf, this.o.thickness * 0.5);
    }
  }

  /* Every piece of GL state this pass touches is saved and restored, so the
     host can call render() anywhere in its frame without rebinding. That is
     ~14 `getParameter` calls, all of which are client-side cached in every
     browser's command buffer — call it a couple of microseconds. If a host
     rebinds its own state after the mesh pass anyway, this is pure waste, but
     it is the difference between "drop the call in" and "audit the core". */
  private save(gl: WebGLRenderingContext): GlState {
    const n = this.thickBuild ? 3 : 1;
    const attribs: GlState["attribs"] = [];
    for (let i = 0; i < n; i++) {
      attribs.push({
        enabled: gl.getVertexAttrib(
          i,
          gl.VERTEX_ATTRIB_ARRAY_ENABLED
        ) as boolean,
        buffer: gl.getVertexAttrib(
          i,
          gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING
        ) as WebGLBuffer | null,
        size: gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_SIZE) as number,
        type: gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_TYPE) as number,
        normalized: gl.getVertexAttrib(
          i,
          gl.VERTEX_ATTRIB_ARRAY_NORMALIZED
        ) as boolean,
        stride: gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_STRIDE) as number,
        offset: gl.getVertexAttribOffset(i, gl.VERTEX_ATTRIB_ARRAY_POINTER),
      });
    }
    return {
      fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
      clear: gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array,
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      array: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
      element: gl.getParameter(
        gl.ELEMENT_ARRAY_BUFFER_BINDING
      ) as WebGLBuffer | null,
      blend: gl.getParameter(gl.BLEND) as boolean,
      blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
      blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
      blendSrcA: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
      blendDstA: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
      depth: gl.getParameter(gl.DEPTH_TEST) as boolean,
      depthMask: this.rbo
        ? (gl.getParameter(gl.DEPTH_WRITEMASK) as boolean)
        : true,
      depthFunc: this.rbo ? (gl.getParameter(gl.DEPTH_FUNC) as number) : 0,
      scissor: gl.getParameter(gl.SCISSOR_TEST) as boolean,
      attribs,
    };
  }

  private restore(gl: WebGLRenderingContext, s: GlState): void {
    for (let i = 0; i < s.attribs.length; i++) {
      const a = s.attribs[i];
      if (a.buffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
        gl.vertexAttribPointer(
          i,
          a.size,
          a.type,
          a.normalized,
          a.stride,
          a.offset
        );
      }
      if (a.enabled) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, s.array);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.element);
    gl.useProgram(s.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
    gl.clearColor(s.clear[0], s.clear[1], s.clear[2], s.clear[3]);
    gl.blendFuncSeparate(
      s.blendSrcRgb,
      s.blendDstRgb,
      s.blendSrcA,
      s.blendDstA
    );
    if (s.blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    if (s.depth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (s.depthFunc) {
      gl.depthMask(s.depthMask);
      gl.depthFunc(s.depthFunc);
    }
    if (s.scissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
  }

  /* ================================================================ *
   * misc
   * ================================================================ */

  private clampOptions(): void {
    const o = this.o;
    o.meshParallax = clamp(o.meshParallax, 0, 45);
    o.meshDamping = clamp(o.meshDamping, 0.001, 1);
    o.meshTilt = clamp(o.meshTilt, -45, 45);
    o.meshScale = clamp(o.meshScale, 0.05, 4);
    o.thickness = clamp(o.thickness, 1, 8);
    o.meshResolution = clamp(Math.round(o.meshResolution), 32, 2048);
    o.meshAlpha = clamp(o.meshAlpha, 0, 1);
    o.period = o.period > 0 ? o.period : 5.4;
    if (!Array.isArray(o.meshOffset) || o.meshOffset.length !== 2)
      o.meshOffset = [0, 0];
  }

  private neutralPitch(): number {
    /* pitch is desktop-only on the reference: on a phone there is no hover, so
       a pointer-driven tilt is meaningless and only costs battery */
    const wide =
      typeof window === "undefined" || window.innerWidth >= TILT_MIN_WIDTH;
    return wide ? (this.o.meshTilt * Math.PI) / 180 : 0;
  }

  private reduced(): boolean {
    return this.o.reducedMotion ?? this.mqReduced;
  }

  private onLost = (): void => {
    this.lost = true;
  };

  /** Watch the host's canvas so `render()` becomes a no-op the instant the
   *  context goes, and stays one until the host calls `create()` again. We do
   *  not preventDefault and do not request a restore — that is the host's
   *  decision about its own canvas, not a decorative skeleton's. */
  private watchContext(gl: WebGLRenderingContext): void {
    const c = gl.canvas as HTMLCanvasElement | OffscreenCanvas | null;
    if (c === this.canvas) return;
    this.unwatchContext();
    if (!c || typeof c.addEventListener !== "function") return;
    this.canvas = c;
    c.addEventListener("webglcontextlost", this.onLost);
  }

  private unwatchContext(): void {
    const c = this.canvas;
    if (c && typeof c.removeEventListener === "function")
      c.removeEventListener("webglcontextlost", this.onLost);
    this.canvas = null;
  }

  private onMotion = (): void => {
    this.mqReduced = this.mq ? this.mq.matches : false;
    this.needs = true;
  };

  private watchMotion(): void {
    if (typeof window === "undefined" || !window.matchMedia) return;
    try {
      this.mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    this.mqReduced = this.mq.matches;
    const h = this.onMotion as EventListener;
    if (this.mq.addEventListener) this.mq.addEventListener("change", h);
    else if (this.mq.addListener) this.mq.addListener(h as never);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return !isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
}

function compile(
  gl: WebGLRenderingContext,
  type: number,
  src: string
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}
