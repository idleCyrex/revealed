import { PRECISION } from "./vertex.js";

/* Reduction pass: samples the mask on a fixed 10x10 grid over the `measure`
   rect and writes the fraction past the reveal threshold into R of a 1x1
   target. One cheap draw plus a 4-byte readback (throttled in the loop) gives
   the CPU "how much is uncovered" without ever reading the whole canvas back.

   The grid is deliberately coarse: the value is smoothed on the CPU and only
   delivered ~10x/s, so more samples would buy precision nobody can perceive. */
export const REDUCE_FRAG = `${PRECISION}
uniform sampler2D uMask;
uniform vec4 uRect;      // x0, y0, x1, y1 in uv of the plate
uniform float uThreshold;
void main() {
  float acc = 0.0;
  for (int i = 0; i < 10; i++) {
    for (int j = 0; j < 10; j++) {
      vec2 uv = uRect.xy + (vec2(float(i), float(j)) + 0.5) / 10.0 * (uRect.zw - uRect.xy);
      float m = texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r;
      acc += step(uThreshold, m);
    }
  }
  gl_FragColor = vec4(acc / 100.0, 0.0, 0.0, 1.0);
}
`;
