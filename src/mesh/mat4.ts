/* Minimal 4x4 column-major matrix helpers — exactly what a wireframe pass
   needs and nothing more: one perspective, one Y-then-X rotation with a Z
   pushback, one multiply. No inverse, no lookAt, no quaternions, no gl-matrix.
   Adding any of those is the first step toward writing a bad three.js. */

export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Perspective projection with the Y axis negated.
 *
 *  The display pass samples `uSkel` with the plate's y-DOWN uv, but an FBO's
 *  row 0 is its BOTTOM, so a flip has to happen somewhere. Baking it into the
 *  projection costs nothing, keeps the vertex shader free of magic, and means
 *  the mesh comes out of the target in the same orientation an image skeleton
 *  would have. (It also flips winding, which is irrelevant: lines are not
 *  culled and nothing here enables face culling.) */
export function perspectiveFlipY(
  out: Mat4,
  fovy: number,
  aspect: number,
  near: number,
  far: number
): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = -f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

/** out = translate(0, 0, -dist) * rotateX(pitch) * rotateY(yaw).
 *
 *  Composed directly rather than through three multiplies: the rotation block
 *  is nine terms written out, which is both smaller and faster than building
 *  and multiplying three matrices. Angles in radians. */
export function modelView(
  out: Mat4,
  yaw: number,
  pitch: number,
  dist: number
): Mat4 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  out[0] = cy;
  out[1] = sp * sy;
  out[2] = -cp * sy;
  out[3] = 0;
  out[4] = 0;
  out[5] = cp;
  out[6] = sp;
  out[7] = 0;
  out[8] = sy;
  out[9] = -sp * cy;
  out[10] = cp * cy;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = -dist;
  out[15] = 1;
  return out;
}

/** out = a * b. `out` may alias neither `a` nor `b`. */
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}
