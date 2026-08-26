/* Thin, allocation-free helpers over WebGL1. Everything here returns null on
   failure instead of throwing: a missing program is a degradation path (static
   plates), never an exception thrown at the consumer's render. */

export function compileShader(
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

/** Every program binds aPos to slot 0, so one enabled attrib array serves all
 *  of them and no program switch has to touch vertex state. */
export function linkProgram(
  gl: WebGLRenderingContext,
  vsSrc: string,
  fsSrc: string
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

/** One oversized triangle, not a quad: three vertices, no index buffer, and no
 *  diagonal seam where two triangles would meet. */
export function createFullscreenTriangle(
  gl: WebGLRenderingContext
): WebGLBuffer | null {
  const buf = gl.createBuffer();
  if (!buf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return buf;
}

/** Cross-origin images have to opt into CORS before WebGL will sample them —
 *  and one tainted texture poisons the whole context, which would also break
 *  the reduce pass's readPixels. Same-origin urls are left alone, because
 *  requesting CORS from a host that does not send the header fails the load. */
function needsCors(url: string): boolean {
  if (typeof window === "undefined") return false;
  if (/^(data:|blob:)/i.test(url)) return false;
  try {
    return new URL(url, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (needsCors(url)) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    /* unprefixed: the field adds "revealed: " when it forwards this to onError */
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

export function textureFromImage(
  gl: WebGLRenderingContext,
  img: TexImageSource
): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  /* premultiplied everywhere: the context is premultiplied, the plates may have
     alpha, and the skeleton composite below is a premultiplied "over" */
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export interface RenderTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/** RGBA8 colour target. RGBA8 rather than a float format because it is the only
 *  universally renderable one, and the mask's linear decay only ever needs
 *  whole 1/255 steps, so 8 bits is exact for it. */
export function createTarget(
  gl: WebGLRenderingContext,
  w: number,
  h: number,
  filter: number
): RenderTarget | null {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) {
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
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
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0
  );
  const ok =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
    gl.getError() === gl.NO_ERROR;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    return null;
  }
  return { tex, fbo };
}
