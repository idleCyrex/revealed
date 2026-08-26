import { PRECISION } from "./vertex.js";

export interface DisplayVariant {
  skeleton: {
    source: "alpha" | "luma" | "image";
    mode: "draw" | "hold" | "pulse" | "scan";
  } | null;
}

/** The compiled shape of a display program. Only these three things are baked
 *  in; every numeric tunable is a uniform, so `setOptions` is live for all of
 *  them and only adding/removing a skeleton, or changing how it is sampled or
 *  animated, costs a relink. */
export function displayVariantKey(v: DisplayVariant): string {
  return v.skeleton ? `${v.skeleton.source}:${v.skeleton.mode}` : "none";
}

/* Display pass. The mask is warped by noise and then cut with a hard threshold,
   so the boundary is a knife edge with organic wobble (no feather, no halo) and
   the two plates stay pixel sharp on either side of it. */
export function displayFrag(v: DisplayVariant): string {
  const sk = v.skeleton;

  const skeletonUniforms = sk
    ? `
uniform sampler2D uSkel;
uniform vec3 uSkelColor;
uniform float uSkelAmp;    // opacity, already scaled by pointer activity
uniform float uSkelPeriod; // seconds for one animation cycle
`
    : "";

  /* coverage + premultiplied colour of the skeleton at vUv. `k` is the frame's
     overall strength; the three sources differ only in where alpha comes from
     and whether the tint is applied at all. */
  const skeletonSample = !sk
    ? ""
    : sk.source === "image"
      ? `
  vec4 sk = texture2D(uSkel, vUv);
  /* "image": drawn as-is. the texture is premultiplied, so scaling rgb and a
     by the same k keeps it premultiplied and needs no un-premultiply */
  float skA = sk.a * k;
  vec3 skC = sk.rgb * k;
`
      : sk.source === "luma"
        ? `
  vec4 sk = texture2D(uSkel, vUv);
  /* "luma": black lines on white. coverage is the darkness, gated by alpha so
     a transparent margin around the art contributes nothing */
  float cov = clamp(1.0 - dot(sk.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0) * sk.a;
  float skA = cov * k;
  vec3 skC = uSkelColor * skA;
`
        : `
  vec4 sk = texture2D(uSkel, vUv);
  float skA = sk.a * k;
  vec3 skC = uSkelColor * skA;
`;

  /* the animation envelope, 0..1, by mode */
  const skeletonAnim = !sk
    ? ""
    : /* "scan" is the mesh's own object-space travelling band, drawn into the
         skeleton texture before this pass ever samples it. The envelope here
         has to be flat for it: any screen-space animation on top would be a
         second, unrelated sweep multiplying the first. */
      sk.mode === "hold" || sk.mode === "scan"
      ? `  float anim = 1.0;
`
      : sk.mode === "pulse"
        ? `  /* "pulse": breathes, never all the way out, so the hint never blinks off */
  float anim = mix(0.18, 1.0, 0.5 + 0.5 * sin(6.2831853 * uTime / uSkelPeriod));
`
        : `  /* "draw": a pen front travels top -> bottom over the first 60% of the
     cycle, the line stays behind it, then the whole skeleton holds and fades
     out before it redraws, so it reads as being sketched in, not switched on */
  float ph = fract(uTime / uSkelPeriod);
  float front = clamp(ph / 0.6, 0.0, 1.0);
  float drawn = smoothstep(vUv.y - 0.05, vUv.y, front);
  float envelope = 1.0 - smoothstep(0.86, 1.0, ph);
  float anim = drawn * envelope;
`;

  /* stamped onto the FRONT layer, before the reveal mix, so the mix below wipes
     it off exactly the parts a stroke has already discovered while it lingers
     on the rest. cut from the UNWARPED vUv so the lines stay crisp. */
  const skeletonStamp = !sk
    ? "  vec4 frontS = front4;\n"
    : `${skeletonAnim}  float k = uSkelAmp * anim;
${skeletonSample}  vec4 frontS = vec4(
    skC + front4.rgb * (1.0 - skA),
    skA + front4.a * (1.0 - skA)
  );
`;

  return `${PRECISION}
varying vec2 vUv;
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform sampler2D uMask;
uniform vec2 uTexel;    // one mask texel in uv, for the gradient taps
uniform float uTime;
uniform vec3 uNoise;    // scale, carve, detail
uniform vec3 uCut;      // threshold, feather, speed
uniform vec2 uRefract;  // strength, falloff
uniform vec3 uBubble;   // strength, band count, facet
uniform vec2 uMaskPx;   // mask size in texels, for the facet snap
uniform float uProgress;
${skeletonUniforms}
/* mask -> field gain. 1.9 spreads one 8-bit mask step over enough field range
   that the carve can actually chew it, and is the reference's proven value. */
const float FIELD_K = 1.9;

/* the mask was written y-down, so read it back the same way.
   uBubble.z is the facet: it slides the fetch from wherever it asked for
   (bilinear, a smooth tear) onto the mask's own texel centres (nearest, a
   low-poly torn edge, straight segments about one mask texel long). It is the
   coordinate that blends, not two samples, so a fractional value is a real
   in-between rather than a cross-fade, and it needs no second texture and no
   filter change — the refraction gradient below still reads a filtered mask. */
float maskAt(vec2 uv){
  vec2 q = mix(uv, (floor(uv * uMaskPx) + 0.5) / uMaskPx, uBubble.z);
  return texture2D(uMask, vec2(q.x, 1.0 - q.y)).r;
}

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), fr = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float cc = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(a, b, u.x), mix(cc, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.02 + 7.3; a *= 0.5; }
  return v;
}

void main() {
  float m = maskAt(vUv);
  float t = uTime * uCut.z;
  /* fractal dissolve: the reveal spreads with watery, wave-like edges and holes
     punched through the pattern. the second octave is the first at twice the
     frequency, drifting the other way, so the two never beat together */
  float fb  = fbm(vUv * uNoise.x + vec2(t * 0.030, -t * 0.020));
  float fb2 = fbm(vUv * uNoise.x * 2.0 - vec2(t * 0.017, t * 0.025));
  /* the carve only modulates where the mask is healthy. a fading region sits
     near the hard cut, so animated noise there drags patches across the knife
     edge and sparkles; below the cut the amplitude falls off and the region
     just recedes with a clean edge */
  float cw = smoothstep(0.0, uCut.x, m);
  float carve = ((fb - 0.5) * uNoise.y + (fb2 - 0.5) * uNoise.z) * cw;
  float field = (m - uCut.x) * FIELD_K + carve;

  /* bubbles. One smooth noise hill, wrapped uBubble.y times, is a topographic
     contour generator: a single hill becomes that many nested closed level
     sets. Subtracting the bands from the field cuts along them, which punches
     concentric holes THROUGH healthy reveal and leaves islands of the front
     plate standing inside it — and, where the reveal is thin, pinches specks
     off it entirely. Two ALU on an fb we already sampled.
     Gated on cw, the mask's own health, for two reasons: a mask-driven reveal
     gets the holes, and a progress-driven one (where the mask is empty and the
     floor below does the work) stays clean. */
  if (uBubble.x > 0.0) {
    float bands = abs(fract(fb * uBubble.y) - 0.5) * 2.0;
    field -= (1.0 - bands) * uBubble.x * cw;
  }

  /* forced reveal floor. it runs through the SAME cut below rather than
     cross-fading, so a scroll-driven reveal wears the identical wet edge a
     stroke does. the threshold field is the noise remapped to fill 0..1, which
     makes progress an (approximately) linear sweep of AREA; with the carve
     turned off it degrades to a plain top-to-bottom wipe instead of a
     flat 0.5 everywhere. */
  if (uProgress > 0.0) {
    float nP = clamp((mix(fb, fb2, 0.35) - 0.5) * 2.2 + 0.5, 0.0, 1.0);
    nP = mix(vUv.y, nP, clamp(uNoise.y + uNoise.z, 0.0, 1.0));
    field = max(field, uProgress * (1.0 + 2.0 * uCut.y) - uCut.y - nP);
  }

  /* hard cut: only uCut.y of anti-alias, so the boundary reads as a knife */
  float reveal = smoothstep(-uCut.y, uCut.y, field);

  /* edge refraction: only the pixels sitting on the mask boundary bend, along
     the gradient of the mask, like the rim of a water bead. four taps of the
     mask texture: no derivatives, no extension, and smoother than dFdx because
     the mask is lower resolution than the display. the mask itself is still cut
     from the UNWARPED vUv so the knife edge stays exact. */
  vec2 warp = vec2(0.0);
  if (uRefract.x > 0.0) {
    float mL = maskAt(vUv - vec2(uTexel.x, 0.0));
    float mR = maskAt(vUv + vec2(uTexel.x, 0.0));
    float mD = maskAt(vUv - vec2(0.0, uTexel.y));
    float mU = maskAt(vUv + vec2(0.0, uTexel.y));
    vec2 gr = vec2(mR - mL, mU - mD);
    float gm = length(gr);
    vec2 gdir = gm > 0.00001 ? gr / gm : vec2(0.0);
    warp = gdir * (uRefract.x * exp(-abs(field) * uRefract.y));
  }
  vec2 tUv = clamp(vUv + warp, 0.0, 1.0);

  vec4 front4 = texture2D(uFront, tUv);
  vec4 back4  = texture2D(uBack, tUv);

${skeletonStamp}
  gl_FragColor = mix(frontS, back4, clamp(reveal, 0.0, 1.0));
}
`;
}
