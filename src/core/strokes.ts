import type { ResolvedIdle } from "./options.js";
import type { UvRect } from "./types.js";

/* The autopilot: strokes that sweep the plate when nobody is pointing at it, so
   the effect demonstrates itself instead of sitting there looking like a static
   image. One generator per field — two fields on a page get independent
   rhythms rather than the same gesture twice.

   Everything is in PLATE uv (0..1 across the image, y down). A stroke is born
   off the plate, arcs through `region`, and leaves off the other side, so what
   the visitor sees is a gesture passing through rather than something switching
   on in the middle of the picture.

   Nothing here touches window, document or any timer: the field's render loop
   owns the clock and advances the pool by handing in its rAF timestamp. So a
   paused, hidden or off-screen field does not advance strokes, and no sweep is
   ever spent where nobody could see it. SSR-safe by construction. */

export interface IdleSample {
  on: boolean;
  /** current position, plate uv */
  x: number;
  y: number;
  /** the position at the previous sampled frame: the consumer draws px,py -> x,y
   *  as one continuous capsule, exactly as it does for the pointer */
  px: number;
  py: number;
  /** radius scale, 1 = the field's own brush radius */
  r: number;
}

interface Stroke extends IdleSample {
  /** retired on the NEXT advance, so the frame that reaches t = 1 is still
   *  drawn: otherwise the last capsule of every stroke would be dropped */
  done: boolean;
  t: number;
  dur: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number; // quadratic bezier control point
  cy: number;
  ease: number;
  /** which side of the region this stroke entered on, so the next spawn can
   *  pick a different one instead of stacking arrivals on one edge */
  side: number;
}

/** hard pool size; `idle.strokes` caps how many of these may be alive at once */
const POOL = 4;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/* one of four pacings per stroke, so no two sweeps read the same:
   0 ease in-out, 1 ease out (bursts in, coasts), 2 ease in, 3 linear */
const easeAt = (e: number, mode: number) => {
  if (mode === 0) return e * e * (3 - 2 * e);
  if (mode === 1) return 1 - (1 - e) * (1 - e);
  if (mode === 2) return e * e;
  return e;
};

const PLATE: UvRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
/* how far past the plate a stroke is born and dies: far enough that the entry
   is plainly off-image, so no stroke ever appears out of nowhere on it */
const OUT_PAD = 0.08;
/* the two region-boundary crossings must be this far apart, in region units
   (the region is the unit square, so its diagonal is 1.414). This is what stops
   a stroke clipping a corner: an adjacent-side pair hugging a shared corner is
   far under it. */
const MIN_SPAN = 0.85;
/* the arrival stroke is the one the visitor is guaranteed to see, so it is not
   allowed to be a corner clip that merely satisfies MIN_SPAN: it goes straight
   across a pair of OPPOSITE sides with its ends pushed apart, which puts its
   span at 1.0 region units at worst and 1.22 at best */
const FIRST_NEAR = 0.15;
const FIRST_FAR = 0.55;
const FIRST_T = 0.3;
/* plate uv per second, thin strokes to fat ones. duration follows the path's
   real length, so the sweep takes the same time whatever the viewport does */
const SPD_THIN = 0.86;
const SPD_FAT = 0.4;
/* the more strokes are already running, the less likely another joins, so the
   composition breathes instead of saturating */
const SPAWN_CHANCE = [1, 0.8, 0.5, 0.2];
/* A pointer report is an activity PING, not a sticky flag: it expires this many
   SAMPLED seconds after the last report. pointermove fires at least once per
   frame while the cursor moves at all, so this is far longer than any gap in a
   real drag. What it covers is every path where pointerleave never fires — a
   tab swap with the cursor at rest on the image, an exit through the browser
   chrome, a listener that missed the event — each of which would otherwise park
   the autopilot permanently. */
const PTR_TIMEOUT = 0.6;
/* nearly one gap in five is a genuine rest, so the field does empty out and the
   rhythm never reads as a metronome */
const nextGap = () => (Math.random() < 0.18 ? rnd(2.7, 5.8) : rnd(0.4, 2.4));
/* how long after arming the FIRST stroke is born: long enough to clear the
   page's own entrance, short enough that the effect is demonstrated on arrival */
const FIRST_GAP_LO = 0.2;
const FIRST_GAP_HI = 0.4;

export class IdleStrokes {
  private pool: Stroke[] = [];
  private opts: ResolvedIdle;
  private lastT = 0;
  private spawnTimer = 0;
  private autoHold = 0;
  private ptr = 0;
  /** nothing advances or spawns before the field has actually painted a frame */
  private armed = false;
  private firstStroke = false;

  constructor(opts: ResolvedIdle) {
    this.opts = opts;
    for (let i = 0; i < POOL; i++) {
      this.pool.push({
        on: false,
        done: false,
        x: 0,
        y: 0,
        px: 0,
        py: 0,
        r: 1,
        t: 0,
        dur: 1,
        ax: 0,
        ay: 0,
        bx: 0,
        by: 0,
        cx: 0,
        cy: 0,
        ease: 0,
        side: -1,
      });
    }
  }

  setOptions(opts: ResolvedIdle): void {
    this.opts = opts;
    if (!opts.enabled) this.reset();
  }

  /** Called by the field once it can genuinely paint: textures in, mask
   *  allocated, one frame already on screen. Idempotent. */
  arm(): void {
    if (this.armed || !this.opts.enabled) return;
    this.armed = true;
    this.firstStroke = true;
    this.spawnTimer = rnd(FIRST_GAP_LO, FIRST_GAP_HI);
  }

  /** `on` true is a PING that must be repeated (every pointermove does);
   *  `on` false is an immediate clear. */
  pointer(on: boolean): void {
    this.ptr = on ? PTR_TIMEOUT : 0;
  }

  reset(): void {
    for (const s of this.pool) {
      s.on = false;
      s.done = false;
    }
    this.lastT = 0;
    this.spawnTimer = 0;
    this.autoHold = 0;
    this.ptr = 0;
    this.armed = false;
    this.firstStroke = false;
  }

  /** 0..1 measure of stroke activity right now, for overlays that must ride the
   *  strokes and vanish on a still, untouched field (the skeleton). A live
   *  pointer pins it to full; otherwise each stroke contributes a hump that is
   *  0 at the ends of its sweep and 1 in the middle, so the overlay pulses like
   *  a wave as strokes are born, pass and die. */
  activity(): number {
    if (this.ptr > 0) return 1;
    let a = 0;
    for (const s of this.pool) {
      if (!s.on || s.done) continue;
      const e = s.t < 0 ? 0 : s.t > 1 ? 1 : s.t;
      const hump = Math.sin(Math.PI * e);
      if (hump > a) a = hump;
    }
    return a;
  }

  /** Read the pool, advancing it at most once per frame. `now` is the rAF
   *  timestamp; dt is real and clamped, so a hitch, a hidden tab or a paused
   *  loop cannot jump a stroke forward. */
  sample(now: number): readonly IdleSample[] {
    if (this.lastT === 0) this.lastT = now;
    else if (now > this.lastT) {
      const dt = Math.min((now - this.lastT) / 1000, 1 / 30);
      this.lastT = now;
      /* the takeover expires on the same clamped, sampled clock the strokes
         move on — never wall clock and never a frame count */
      if (this.ptr > 0) this.ptr = Math.max(0, this.ptr - dt);
      if (this.armed && this.opts.enabled) this.advance(dt);
    }
    return this.pool;
  }

  /* schedule and advance. strokes in flight always finish, only spawning is
     parked while the pointer owns the field, because cutting a sweep mid-frame
     is a visible pop */
  private advance(dt: number): void {
    if (this.ptr > 0) {
      this.autoHold = this.opts.yieldAfter;
    } else if (this.autoHold > 0) {
      this.autoHold -= dt;
      if (this.autoHold <= 0) this.spawnTimer = rnd(0.2, 1.2);
    } else {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) this.trySpawn();
    }

    for (const s of this.pool) {
      if (!s.on) continue;
      if (s.done) {
        s.on = false;
        s.done = false;
        continue;
      }
      s.px = s.x;
      s.py = s.y;
      s.t += dt / s.dur;
      const e = s.t > 1 ? 1 : s.t;
      const es = easeAt(e, s.ease);
      const iv = 1 - es;
      s.x = iv * iv * s.ax + 2 * iv * es * s.cx + es * es * s.bx;
      s.y = iv * iv * s.ay + 2 * iv * es * s.cy + es * es * s.by;
      if (s.t >= 1) s.done = true;
    }
  }

  private trySpawn(): void {
    let alive = 0;
    for (const s of this.pool) if (s.on) alive++;
    const cap = this.opts.strokes;
    if (alive < cap && Math.random() < SPAWN_CHANCE[alive]) {
      for (const s of this.pool) {
        if (!s.on) {
          this.spawn(s, this.firstStroke);
          /* cleared only when it is actually taken, so a declined roll cannot
             spend the arrival stroke on nothing */
          this.firstStroke = false;
          break;
        }
      }
      this.spawnTimer = nextGap();
    } else {
      /* declined: re-roll soon rather than commit to a long silence */
      this.spawnTimer = rnd(0.3, 0.95);
    }
  }

  private spawn(s: Stroke, first: boolean): void {
    const reg = this.opts.region;
    const gw = Math.max(reg.x1 - reg.x0, 0.001);
    const gh = Math.max(reg.y1 - reg.y0, 0.001);

    /* 1. the two points where the stroke crosses the region, in region units.
       entry on one side and exit past a DIFFERENT one: half the pairs are
       opposite sides, half are one of the two neighbours, for variety. the
       entry side is picked from the ones nobody is currently using, so
       concurrent sweeps do not arrive together off one edge and read as a fan. */
    let taken = 0;
    for (const o of this.pool) {
      if (o.on && o !== s && o.side >= 0) taken |= 1 << o.side;
    }
    const free: number[] = [];
    for (let i = 0; i < 4; i++) if ((taken & (1 << i)) === 0) free.push(i);
    const sa = free.length
      ? free[Math.floor(Math.random() * free.length)]
      : Math.floor(Math.random() * 4);
    s.side = sa;

    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    if (first) {
      /* the arrival stroke, straight across the opposite side with its two ends
         pushed into opposite halves: no rejection loop, no corner clip, span
         >= 1.0 region unit by construction. the side and which way it runs are
         still rolled, so what the visitor gets is random, only never weak. */
      const sb = sa ^ 1;
      const near = FIRST_NEAR + Math.random() * FIRST_T;
      const far = FIRST_FAR + Math.random() * FIRST_T;
      const flip = Math.random() < 0.5;
      [ax, ay] = sidePoint(sa, flip ? near : far);
      [bx, by] = sidePoint(sb, flip ? far : near);
    } else {
      for (let i = 0; i < 6; i++) {
        const sb =
          Math.random() < 0.5
            ? sa ^ 1
            : (sa < 2 ? 2 : 0) + (Math.random() < 0.5 ? 0 : 1);
        [ax, ay] = edgePoint(sa);
        [bx, by] = edgePoint(sb);
        if (Math.hypot(bx - ax, by - ay) >= MIN_SPAN) break;
      }
      /* six corner-hugging draws in a row: mirror the entry through the centre,
         which is the longest span there is and always >= 1 region unit */
      if (Math.hypot(bx - ax, by - ay) < MIN_SPAN) {
        bx = 1 - ax;
        by = 1 - ay;
      }
    }

    /* 2. the same two points in plate uv, and the chord direction there */
    const pax = reg.x0 + ax * gw;
    const pay = reg.y0 + ay * gh;
    const pbx = reg.x0 + bx * gw;
    const pby = reg.y0 + by * gh;
    const ddx = pbx - pax;
    const ddy = pby - pay;
    const dl = Math.hypot(ddx, ddy) || 1;
    const ux = ddx / dl;
    const uy = ddy / dl;

    /* 3. extend both ends off the plate, along the chord */
    const ka = outward(pax, pay, -ux, -uy);
    const kb = outward(pbx, pby, ux, uy);
    const sax = pax - ux * ka;
    const say = pay - uy * ka;
    const sbx = pbx + ux * kb;
    const sby = pby + uy * kb;

    /* 4. back into region units, where the waypoint and the bow are defined.
       the map is affine so the extended ends stay collinear with the crossings,
       and mapping the three bezier control points back at the end is exact */
    const gax = (sax - reg.x0) / gw;
    const gay = (say - reg.y0) / gh;
    const gbx = (sbx - reg.x0) / gw;
    const gby = (sby - reg.y0) / gh;
    const dx = gbx - gax;
    const dy = gby - gay;
    const len = Math.hypot(dx, dy) || 1;
    /* quadratic bezier pinned through a waypoint in the middle half of the
       region: whatever the ends are, the belly of the stroke sweeps the middle */
    const wx = 0.25 + Math.random() * 0.5;
    const wy = 0.25 + Math.random() * 0.5;
    /* skew slides WHERE along the stroke that pass happens, so the arc is not
       symmetric; solving B(tw) = w gives the control point */
    const tw = 0.5 + rnd(-0.15, 0.15);
    const iw = 1 - tw;
    const k = 1 / (2 * iw * tw);
    /* bow then shoves the control point off the chord for the organic bulge. it
       moves the belly by at most half of it, so 0.22 keeps the pass point inside
       0.14..0.86 of the region however the waypoint fell */
    const bow = rnd(0.06, 0.22) * (Math.random() < 0.5 ? -1 : 1);
    const cx = (wx - iw * iw * gax - tw * tw * gbx) * k + (-dy / len) * bow;
    const cy = (wy - iw * iw * gay - tw * tw * gby) * k + (dx / len) * bow;

    s.ax = sax;
    s.ay = say;
    s.bx = sbx;
    s.by = sby;
    s.cx = reg.x0 + cx * gw;
    s.cy = reg.y0 + cy * gh;
    /* heft ties weight to pace: thin strokes flick past, fat ones drift. the
       arrival stroke takes the middle of the range rather than the thinnest and
       fastest end, so what is demonstrated reads as a stroke and not a flick */
    const heft = first ? rnd(0.35, 0.65) : Math.random();
    s.r = 0.6 + 0.55 * heft;
    const spd = (SPD_THIN + (SPD_FAT - SPD_THIN) * heft) * this.opts.speed;
    const lenS = Math.hypot(sbx - sax, sby - say);
    s.dur = Math.min(12, Math.max(0.4, (lenS / spd) * rnd(0.85, 1.2)));
    s.ease = Math.floor(Math.random() * 4);
    s.t = 0;
    s.done = false;
    /* both ends of the first segment sit on the entry point, so the stroke does
       not streak in from wherever the previous tenant of this slot ended */
    s.x = s.ax;
    s.y = s.ay;
    s.px = s.ax;
    s.py = s.ay;
    s.on = true;
  }
}

/* a point ON side s of the region at t along it, in region units.
   0 left, 1 right, 2 top, 3 bottom -> s ^ 1 is the opposite side */
function sidePoint(s: number, t: number): [number, number] {
  if (s === 0) return [0, t];
  if (s === 1) return [1, t];
  if (s === 2) return [t, 0];
  return [t, 1];
}

function edgePoint(s: number): [number, number] {
  return sidePoint(s, 0.1 + Math.random() * 0.8);
}

/* distance from an interior point along the unit vector u to where it leaves
   the box. u is a unit vector, so at least one component clears the epsilon and
   the result is always finite */
function rayExit(
  x: number,
  y: number,
  ux: number,
  uy: number,
  b: UvRect
): number {
  let k = Infinity;
  if (Math.abs(ux) > 1e-6) k = Math.min(k, ((ux > 0 ? b.x1 : b.x0) - x) / ux);
  if (Math.abs(uy) > 1e-6) k = Math.min(k, ((uy > 0 ? b.y1 : b.y0) - y) / uy);
  return k === Infinity ? 0 : Math.max(0, k);
}

/** run an end of the chord clear of the plate and a little way past it */
function outward(x: number, y: number, ux: number, uy: number): number {
  return rayExit(x, y, ux, uy, PLATE) + OUT_PAD;
}
