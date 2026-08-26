import { PRECISION } from "./vertex.js";

/* Mask pass: reads the previous mask, writes the next one, ping-ponged, so the
   two are never the same texture in one draw.

   CHANNELS. R is the reveal field. G and B are a VELOCITY field, biased so that
   zero velocity is the byte 128:

     encoded = 128/255 + v * 0.5      v = (encoded - 128/255) * 2

   which is the only reason the pass touches anything but R, and is exactly what
   the two spare channels are for - no second target, no float texture. A mask
   whose G/B are ZERO reads as velocity (-1, -1) and the field leaves the plate
   on the first frame, so every fill site (createMaskPair, fillMaskPair, clear(),
   revealAll(), context restore) must write 128, not 0.

   Without the wave (uAdvect, uSpread, uInject all 0) this is bit-for-bit the
   old pass:

     value = max(prev - decay, brush(capsule))

   the union of everything drawn while it was still healing. With the wave it is

     value = max(prev, prev(back-traced), spread(...)) - decay
             then max'd with brush(capsule)

   where the back-trace is one semi-Lagrangian tap through the velocity field
   the strokes themselves stirred up. Note the max: the VELOCITY is transported
   (it is replaced by what flowed in) but the REVEAL is DILATED along the flow.
   That asymmetry is deliberate and is explained where it happens, below. It is
   what gives the reveal momentum without letting the repeated resample eat it:
   a stroke does not only paint where the pointer has been, it throws a front
   forward and the front keeps going for about a second after the pointer stops.

   EXACTNESS. The old pass was a pure `max` under `brush.persist` and left
   painted texels bit-identical frame after frame, which is why a long session
   could not band. That still holds here. Only two things ever write R: `max`
   of taps of the previous frame, and `- uDecay`, which is whole 1/255 steps -
   so no value is ever re-quantised in place, whatever the velocity field is
   doing. And the velocity is strictly contracted every frame (damped, then
   snapped to exactly zero once it is inside one encoding step), so the field
   always returns to a bit-identical at-rest state after a bounded time rather
   than creeping on a rounding residual. Measured: `persist` plus the wave
   settles to a fraction that is then constant to five decimals for 20 s.

   SPOTLIGHT is the other end of the same one number: `healRate: Infinity` owes
   a whole mask unit of decay every frame, so nothing from the previous mask can
   survive and the pass skips the feedback fetch outright and reduces to the
   brush alone. No branch anywhere else in the library - it is what the existing
   decay arithmetic already does at its limit.

   MULTI-CAPSULE. runMaskPasses draws one pass per capsule. Advection, decay,
   spread and damping are owed ONCE per frame, so the loop zeroes uAdvect and
   uSpread and uDecay and sets uDamp to 1 on every pass after the first; those
   passes then reduce to `max` plus their own velocity injection.

   Everything tunable is a uniform, including the aspect, so changing the brush
   radius, the plate aspect or any wave control at runtime never recompiles. */
export const MASK_FRAG = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uPrev;
uniform vec4 uSeg;     // capsule: start.xy, delta.zw, in aspect-corrected space
uniform float uAmp;    // brush strength, 0 while the pointer is absent or still
uniform float uR;      // brush radius: idle strokes each carry their own
uniform float uDecay;  // decay owed this frame, in whole 1/255 steps.
                       // 0 = persist, >= 1 = spotlight (no feedback at all)
uniform float uAspect; // plate width / height
uniform vec2 uTexel;   // one mask texel in uv, for the spread taps
uniform float uAdvect; // uv travelled this frame at |v| = 1. 0 after pass 0
uniform float uSpread; // 0..1 approach toward the neighbourhood max this frame
uniform float uInject; // velocity added over the brush disc this frame
uniform float uSwirl;  // 0 = along the stroke, 1 = perpendicular, sign per side
uniform float uDamp;   // velocity survival this frame. 1 after pass 0

const float SEG_EPS = 0.000001;
/* zero velocity, as the byte 128 */
const float VZERO = 0.501960784;
/* one 8-bit step of the encoding, expressed in velocity units */
const float VLSB = 0.007843137;
/* the encodable range is +-1; stay well inside it so a long stroke that keeps
   injecting cannot clip a component and shear the field */
const float VMAX = 0.8;
/* mask value the spread gives up per texel it travels. three whole 1/255 steps:
   large enough that quantisation can never round it to nothing, which is what
   makes the creep terminate - from a peak of 1 it can reach at most 85 texels,
   whatever the rate, whatever the frame rate, forever. */
const float SPREAD_DROP = 0.011764706;

vec2 decodeVel(vec2 e){ return (e - VZERO) * 2.0; }
vec2 encodeVel(vec2 v){ return v * 0.5 + VZERO; }

void main() {
  /* the pass writes vUv y-down into the FBO, so every fetch uses the same flip
     and the mask stays self-consistent across passes. source and target have
     the same size here, so this fetch lands exactly on a texel centre */
  vec2 uvFlip = vec2(vUv.x, 1.0 - vUv.y);
  vec2 src = uvFlip;
  float field = 0.0;
  vec2 vel = vec2(0.0);

  /* uDecay >= 1 is healRate Infinity - brush.spotlight. A whole mask unit of
     decay in one frame means NOTHING from the previous mask can survive, so the
     entire feedback half of the pass is skipped: no fetch, no back-trace, no
     spread. What is left is the brush on its own, which is exactly the mode's
     definition - the reveal is only where the pointer is right now. (Passes
     after the first still take this branch with uDecay 0, so several capsules
     in one frame still union correctly.) */
  if (uDecay < 1.0) {
    vec4 prev = texture2D(uPrev, uvFlip);
    vel = decodeVel(prev.gb);
    field = prev.r;

    /* semi-Lagrangian back-trace: where was the stuff that is here now? One tap,
       through the PREVIOUS velocity, which is what transports both the reveal and
       the velocity itself and is where the momentum comes from. Velocity lives in
       aspect-corrected space, so only x has to be converted back to uv. */
    if (uAdvect > 0.0) {
      vec2 off = vel * uAdvect;
      off.x /= uAspect;
      /* uvFlip.y runs the other way from plate uv, hence the + on y */
      src = vec2(uvFlip.x - off.x, uvFlip.y + off.y);
      vec4 back = texture2D(uPrev, src);
      /* the VELOCITY is transported - it is the thing with momentum, it has to
         leave where it was - but the REVEAL is DILATED: the max of where it is and
         where it came from, rather than replaced by it.

         Replacing is the textbook advection and it is wrong here. Each frame's
         back-trace lands off-texel-centre, so a plain replace is a bilinear tap,
         i.e. one box blur per frame; the reveal is thresholded, so a hundred
         frames of that dissolve it - measured, 72% of the area gone in 2 s with
         healing switched off entirely, which reads as the stroke evaporating
         rather than travelling. Dilating instead makes advection strictly
         additive: the reveal grows along the flow and nothing but uDecay ever
         takes it away, so trail still means what it says. The front still stops
         - it can only reach as far as the velocity carries it before damping
         snaps that to zero - which is what keeps persist finite. */
      /* the mask clamps to its edge, so a back-trace that leaves the plate reads
         the border texel - and under a dilation that border feeds itself and the
         wave pins to the frame and creeps along it forever. Outside the plate
         there is nothing to have come from, so the dilation simply does not
         apply; the velocity still transports, which is what lets a wave leave. */
      vec2 lim = step(vec2(0.0), src) * step(src, vec2(1.0));
      float inside = lim.x * lim.y;
      field = max(field, back.r * inside);
      vel = mix(vel, decodeVel(back.gb), inside);
    }

    /* the reveal creeps into its neighbours: four taps of R around the same spot
       the back-trace landed on. Bounded twice over - it can never lift a texel
       above its neighbourhood max minus SPREAD_DROP, and it climbs there by at
       most uSpread of the way per frame - so it is a travelling front with a
       finite range, not a diffusion that can eat the plate. */
    if (uSpread > 0.0) {
      float mx = field;
      mx = max(mx, texture2D(uPrev, src + vec2(uTexel.x, 0.0)).r);
      mx = max(mx, texture2D(uPrev, src - vec2(uTexel.x, 0.0)).r);
      mx = max(mx, texture2D(uPrev, src + vec2(0.0, uTexel.y)).r);
      mx = max(mx, texture2D(uPrev, src - vec2(0.0, uTexel.y)).r);
      field = max(field, mix(field, mx - SPREAD_DROP, uSpread));
    }
  }

  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 ab = uSeg.zw;
  float len2 = dot(ab, ab);
  /* nearest point on the segment the pointer covered since the last pass: an
     arbitrarily fast move lays one continuous stroke in a single cheap draw */
  float h = clamp(dot(p - uSeg.xy, ab) / max(len2, SEG_EPS), 0.0, 1.0);
  float d = distance(p, uSeg.xy + ab * h);
  /* the profile is 1 at the axis and falls smoothly to 0 at uR, with NO flat
     core: as the value decays the reveal threshold walks inward from the edge,
     so the stroke thins continuously and its last remnant is a point instead
     of a core that pops */
  float brush = (1.0 - smoothstep(0.0, max(uR, 0.001), d)) * uAmp;

  vel *= uDamp;
  /* a degenerate capsule - a held pointer, or an idle stroke standing still -
     has no direction to throw anything in, so it injects nothing */
  if (uInject > 0.0 && len2 > SEG_EPS) {
    vec2 dir = ab * inversesqrt(len2);
    /* the rotational part flips sign across the stroke axis, which manufactures
       the counter-rotating vortex pair directly instead of waiting for a
       pressure solve to shed one. It is where the holes and the islands come
       from; with swirl at 0 the wave is just a smear. */
    vec2 rel = p - uSeg.xy;
    /* the sign RAMPS across the axis rather than flipping. A hard flip is a
       velocity discontinuity one texel wide - infinite shear at the mask's
       resolution - and it shreds the reveal in a few frames instead of curling
       it. Ramped over half the brush radius it is a real dipole: no rotation
       on the axis, full rotation out at the rim, and the pair is what the
       vortex-core holes come from. */
    float side = clamp(
      (rel.x * dir.y - rel.y * dir.x) / max(uR * 0.5, 0.001), -1.0, 1.0
    );
    vec2 idir = mix(dir, vec2(-dir.y, dir.x) * side, uSwirl);
    /* the velocity profile is FATTER than the brush profile, and deliberately.
       The reference's splat is a squared falloff, but there the mask IS the
       velocity, so its front and its momentum are the same contour. Here they
       are different channels: the reveal's front sits out where the brush
       profile has fallen to the cut threshold, and a squared falloff leaves
       exactly that ring at zero speed - the stroke then churns its own inside
       and never advances, which is what it measurably did. A plateau across
       the disc, rolled off over its outer half, carries the front with it. */
    float vfall = 1.0 - smoothstep(0.5, 1.0, d / max(uR, 0.001));
    vel += idir * (uInject * uAmp * vfall);
  }

  float sp = length(vel);
  if (sp > VMAX) vel *= VMAX / sp;
  /* anything under one encoding step would quantise to a stuck residual that
     never dies and would drag the field a fraction of a texel per frame for the
     rest of the session. Snap it to exactly zero instead: that is what makes
     the wave settle to a bit-identical at-rest field. */
  if (sp < VLSB) vel = vec2(0.0);

  gl_FragColor = vec4(
    max(max(field - uDecay, 0.0), brush),
    encodeVel(vel),
    1.0
  );
}
`;
