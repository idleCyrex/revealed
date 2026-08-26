/* One vertex shader for all three passes. vUv is y-DOWN so that image space,
   pointer space and mask space all agree without a flip anywhere on the CPU;
   the only flip in the whole renderer is the one inside maskAt(). */
export const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;
