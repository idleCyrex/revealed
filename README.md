# revealed

**Paint one image out of another.** A wet-edge WebGL reveal for React and plain JS.

![A scripted pointer sweep tears a photograph of a pigeon open along a wet, noise-carved edge, uncovering an X-ray of the same bird; the tear keeps travelling for about a second after the stroke stops, leaves islands of feather standing inside the uncovered ground, and then the photograph heals back over it.](https://raw.githubusercontent.com/idleCyrex/revealed/main/media/hero.gif)

Two pictures are stacked in the same box. Wherever the pointer moves, the top one is eaten
away and the one underneath shows through - like wiping condensation off a window, except
the boundary is a fractal lace that bulges, drips and punches holes through itself. A
stroke does not just paint where the pointer went: it throws the reveal forward, and the
front keeps travelling and tearing for about a second after the pointer stops. Then it
heals over, so the picture repairs itself behind the cursor. One option makes the reveal
permanent instead, another turns it into a torch with no trail at all, and another drives
it from scroll with no pointer at all.

Coming from an earlier version and want the old, quieter look back? One word:
`edge="plain"`.

Nobody touching it? It paints itself. Idle strokes sweep in from off-frame, arc through
the image and leave, so the effect demonstrates itself instead of sitting there looking
like a static hero.

- **No runtime dependencies.** The CDN build is 52 kB minified, 18.8 kB gzipped, GLSL and
  all. React is an optional peer.
- **Three passes, one context.** A ping-ponged feedback mask, one composite draw, and a
  1×1 reduction that reports how much has been uncovered. The wave rides in the mask's two
  spare channels: no extra render target, no extra program, no float textures.
- **Degrades all the way down.** No WebGL, a software renderer, `prefers-reduced-motion`,
  a lost context, a failed shader link, a 404 on a plate - every one of them leaves the
  plain front image, which was in the DOM the whole time.
- **SSR-safe.** Importing it on the server touches nothing, and `revealed/react` ships its
  own `"use client"`.

**See it working:** [revealed.idlee.xyz](https://revealed.idlee.xyz) - live demos, the six presets
side by side, and a [playground](https://revealed.idlee.xyz/playground) wired to every
option. Full [documentation](https://revealed.idlee.xyz/docs) and
[API reference](https://revealed.idlee.xyz/docs/api) live there too.

---

## Install

```bash
npm i revealed
```

React is optional. Install it only if you use the `revealed/react` entry.

## React

```tsx
import { Revealed } from "revealed/react";

export default function Hero() {
  return (
    <Revealed
      front="/hero-front.webp"
      back="/hero-back.webp"
      edge="liquid"
      style={{ maxWidth: 820 }}
    />
  );
}
```

That is the whole thing. The component renders one `<div>`, injects a `<canvas>` and the
two `<img>` plates into it, takes the front image's aspect ratio, and starts.

## Vanilla

```ts
import { RevealField } from "revealed";

const host = document.querySelector<HTMLElement>("#hero")!;

const field = new RevealField(host, {
  front: "/hero-front.webp",
  back: "/hero-back.webp",
  edge: "liquid",
  onReveal: (f) => console.log(`${Math.round(f * 100)}% uncovered`),
});

// later
field.destroy();
```

The host needs a width. Everything else - height, position, the canvas, the plates - the
field arranges itself.

## CDN

The IIFE build puts a single global, `revealed`, on `window`. It contains the core only:
`RevealField`, `isSupported`, `presets`, `DEFAULT_EDGE`, `DEFAULT_BRUSH`. There is no
React in it, and no [mesh skeleton](#3d-wireframe-skeletons) - that one is ESM only, since
a wireframe hero is not a drop-a-script-tag feature.

```html
<div id="hero" style="max-width: 820px"></div>
<script src="https://unpkg.com/revealed@0.1.0/dist/revealed.global.js"></script>
<script>
  new revealed.RevealField(document.getElementById("hero"), {
    front: "/hero-front.webp",
    back: "/hero-back.webp",
  });
</script>
```

jsDelivr serves the same file from
`https://cdn.jsdelivr.net/npm/revealed@0.1.0/dist/revealed.global.js`.

---

## The three layers

| layer | required | what it is |
| --- | --- | --- |
| `front` | yes | the image on top - the one that gets eaten away |
| `back` | yes | the image underneath - the one that gets revealed |
| `skeleton` | no | line art of `back`, ghosted onto `front` and sketched on in a loop, so the visitor can tell there is something hidden underneath. Either an image, or a [3D wireframe mesh](#3d-wireframe-skeletons) |

![The three layers side by side. front: a photograph of a beige CRT monitor showing a 1990s MapQuest page. back: a flat-panel monitor showing a modern cruise-line site. skeleton: white line art tracing the outline of the flat monitor and its stand.](https://raw.githubusercontent.com/idleCyrex/revealed/main/media/layers.png)

`front` and `back` should be the **same size and the same framing**. The shader maps both
onto the same quad and the plates are `object-fit: fill`, so anything that does not line up
will look like it slid or stretched.

### Authoring a skeleton

The skeleton is the part that makes people move their cursor. It is a faint outline of
what is underneath, stamped onto the front layer *before* the reveal mix - so it is wiped
away exactly where `back` has already been uncovered, and lingers only on the parts still
to be found.

1. Open `back` and trace its silhouette plus a handful of interior edges as strokes.
   Ten to thirty lines is plenty; this is a hint, not a drawing.
2. Export at the **same dimensions and framing as the plates**, either as an SVG or as a
   transparent PNG with the lines opaque and everything else clear.
3. Pass it as `skeleton`. Transparent art is keyed off its alpha, which is the default.

```tsx
import { Revealed } from "revealed/react";

export function Crt() {
  return (
    <Revealed
      front="/crt.webp"
      back="/monitor.webp"
      skeleton={{ src: "/monitor-outline.svg", color: "#18375d", opacity: 0.2 }}
    />
  );
}
```

If what you have is black lines on a white background rather than transparency, pass
`source: "luma"` and it keys off the darkness instead. If the art is already coloured the
way you want it on screen, pass `source: "image"` and it is drawn as-is with no tint.

`skeleton` is optional and costs nothing when it is left out: the whole branch is compiled
out of the fragment shader, and no third texture is uploaded.

### 3D wireframe skeletons

The skeleton can be a **rotating 3D wireframe** instead of a flat image - a hero object
drawn as hairlines, parallaxing a few degrees with the pointer. It lives behind its own
subpath so the core stays lean:

```bash
# nothing to install - it ships in the same package
```

```tsx
import { Revealed } from "revealed/react";
import { meshSkeleton } from "revealed/mesh";
import { useEffect, useMemo } from "react";

export function Hero() {
  const mesh = useMemo(() => meshSkeleton({ mesh: "/helmet.json" }), []);
  /* YOU created it, so you destroy it. The field never does. */
  useEffect(() => () => mesh.destroy(), [mesh]);

  return (
    <Revealed
      front="/crt.webp"
      back="/monitor.webp"
      skeleton={{ mesh, color: "#18375d", opacity: 0.2, mode: "scan" }}
    />
  );
}
```

Vanilla is the same three lines:

```js
import { RevealField } from "revealed";
import { meshSkeleton } from "revealed/mesh";

const mesh = meshSkeleton({ mesh: "/helmet.json" });
const field = new RevealField(el, { front, back, skeleton: { mesh } });
// on teardown:
field.destroy();
mesh.destroy();
```

**Lifecycle is yours.** `meshSkeleton()` returns a handle; the field brings it up on its
context, resizes it with the plate, steps it with the pointer and draws it, and rebinds it
after a context restore. It never calls `destroy()`. Create the handle once, keep it for as
long as the field lives, and destroy it when you are done with it - destroying the field
alone leaks nothing (the GL objects go with the context) but does leave the handle's
media-query listener attached.

**`src` and `mesh` are two answers to the same question.** Give one. If you give both,
`mesh` wins and you get a development warning. `source` is forced to `"alpha"` with a mesh -
the wireframe writes premultiplied black plus alpha, which is exactly what the `"alpha"`
path reads and tints with `color`.

**`mode` and `period` belong on the skeleton, not on `meshSkeleton()`.** The display pass
and the mesh's own scan band are two halves of one animation, so `skeleton.mode` is the
single source of truth and is forwarded down to the handle. Setting `mode` on
`meshSkeleton()` and not on the skeleton will be overwritten.

The mesh is fetched in the background and **never awaited**: `onReady` fires on the plates
alone. A mesh that 404s, fails to parse, or blows the index limit calls the handle's
`onError` and leaves a transparent skeleton - the reveal runs exactly as if you had not
asked for one.

#### `mode: "scan"`

`"draw"`, `"hold"` and `"pulse"` are screen-space opacity envelopes and work on a mesh
unchanged. `"scan"` is mesh-only: a band travelling along the model's **own object-space Y**,
so it sweeps the geometry as it turns rather than wiping across the viewport. On an image
skeleton `"scan"` collapses to `"hold"`.

#### Mesh options

These go to `meshSkeleton()`, not to `skeleton`:

| key | type | default | what it does |
| --- | --- | --- | --- |
| `mesh` | `string \| { positions, edges }` | - | url of a `.obj` or `.json` edge list, or arrays you already have. Required |
| `meshParallax` | `number` | `5` | peak yaw in degrees at the far edge of the plate |
| `meshDamping` | `number` | `0.03` | 0..1 approach per 60 Hz frame, frame-rate corrected |
| `meshTilt` | `number` | `10` | constant pitch offset in degrees, suppressed under 768 px |
| `meshScale` | `number` | `1` | fraction of the plate **height** the model's largest dimension fills |
| `meshOffset` | `[number, number]` | `[0, 0]` | translation in plate uv, y down |
| `thickness` | `number` | `1` | line width in device pixels. `1` uses `gl.LINES`; above that an expanded-quad buffer is built at load (4× vertices) |
| `meshResolution` | `number` | `512` | cap on the skeleton target's long edge. The ghost is upsampled bilinear, which is what keeps the hairlines soft |
| `meshAlpha` | `number` | `0.55` | alpha per line fragment, before `skeleton.opacity` scales the whole stamp. Overlapping edges accumulate |
| `meshDepth` | `boolean` | `false` | attach a depth buffer so back edges are hidden. Off looks closer to a real wireframe |
| `reducedMotion` | `boolean \| null` | `null` | override the media query. Reduced motion freezes the pose rather than removing the mesh |
| `onError` | `(err) => void` | - | informational, never fatal |

`mode` and `period` are also accepted here, but `skeleton.mode` / `skeleton.period` overwrite
them - see above.

The handle exposes `texture`, `ready`, `edgeCount`, `dirty`, and `setOptions(patch)` for
live changes. Everything is live except `mesh` (refetches) and `thickness` crossing 1
(rebuilds the buffers).

#### Budget: 1,500–3,000 edges

This is a **visual** limit, not a performance one. A wireframe drawn at half alpha with no
depth test stops reading as a shape long before it costs you a frame:

- **under ~1,500 edges** - reads as a wire cage, not a surface
- **1,500–3,000 edges** - the usable band for a hero. Enough to see the form, sparse
  enough that individual lines stay individual
- **above ~3,000** - the lines start to merge; by ~20,000 it is uniformly grey mush

So decimate hard. In Blender: add a Decimate modifier and pull the ratio down until the
face count is in that band, export as OBJ with triangulation on and normals/UVs/materials
off, then run `node node_modules/revealed/src/mesh/obj-to-edges.mjs model.obj model.json`
to get the deduplicated JSON edge list. Ship the JSON: it is smaller, already normalised,
and costs one `JSON.parse` at load. Positions are normalised into a centred unit box, so
exporter scale and origin do not matter. Y up is assumed for `"scan"`.

The Uint16 index buffer caps a mesh at 65,536 vertices, far above anything that still looks
like a wireframe.

#### Cost

`revealed/mesh` is **~6.6 kB gzipped** (minified), and it is not in the core bundle,
the React bundle, or the CDN `revealed.global.js` - those are byte-identical whether or not
you use it. Import it and you pay for it; do not and you never see it. It imports nothing
from the core, so it is a leaf in your graph. The pass itself is one draw call into a
target capped at `meshResolution`, skipped entirely on any frame where the pose has not
moved.

---

## Options

Everything is optional except `front` and `back`. Every numeric tunable is a live uniform:
changing it through `setOptions()` (or a React prop) takes effect on the next frame and
never rebuilds the GL context.

| prop | type | default | what it does |
| --- | --- | --- | --- |
| `front` | `ImageSource` | - | the plate on top |
| `back` | `ImageSource` | - | the plate underneath |
| `skeleton` | `ImageSource \| SkeletonOptions` | - | optional line-art hint |
| `aspect` | `number` | from `front` | width / height of the plates |
| `edge` | `EdgePreset \| EdgeOptions` | `"liquid"` | how the boundary is carved |
| `brush` | `BrushOptions` | - | size and lifetime of a stroke |
| `idle` | `boolean \| IdleOptions` | `true` | the autopilot |
| `maxDpr` | `number` | `1.5` | cap on `devicePixelRatio`, floored at `0.5` |
| `running` | `boolean` | `true` | `false` parks the render loop |
| `progress` | `number` | `0` | 0..1 forced reveal floor, clamped |
| `measure` | `UvRect` | whole image | uv rect `onReveal` is measured over |
| `onReveal` | `(fraction: number) => void` | - | called ~10×/s with 0..1 uncovered |
| `onReady` | `() => void` | - | plates decoded, first frame painted |
| `onError` | `(err: Error) => void` | - | a degradation was taken; see below |
| `pointerTarget` | `HTMLElement \| null` | the host | element the pointer is tracked on |
| `deferInit` | `boolean` | `true` | bring GL up at `requestIdleCallback` |

`onReveal` reports `max(measured, progress)`, so a scroll-driven reveal moves it too. It
also fires immediately after `clear()` and `revealAll()`, even if no frame runs in between
- a paused, hidden or off-screen field still reports the truth.

The fraction still means the same thing it always did - the share of `measure` that is
uncovered, read off the mask - but with the wave on it **breathes**: it rises while a
stroke is travelling and falls back as the reveal heals, so it is not a one-way ratchet.
It never was under a healing brush, but the wave makes it obvious. If you are latching on
`fraction >= x`, latch it yourself; do not assume it only rises. Under `persist` it is
monotone, as before.

`onError` is informational, never fatal: it means the field fell back to the static front
plate. `onReady` still fires in that case, once the plate has decoded. Neither callback is
invoked before the constructor has returned.

### `ImageSource`

A string, or a string plus a narrow-viewport swap:

```ts
import type { ImageSource } from "revealed";

const hero: ImageSource = {
  src: "/hero.webp",
  small: "/hero-480.webp",
  smallMaxWidth: 640, // default 640
};
```

The plate is injected as a real `<picture>` with a `(max-width: …)` source, and the
texture is picked by the same rule, so the DOM and the GPU never disagree. Crossing the
breakpoint re-uploads the textures on its own.

### `EdgeOptions`

| key | type | default | what it does |
| --- | --- | --- | --- |
| `scale` | `number` | `7.5` | fbm frequency of the carve. higher = finer lace |
| `carve` | `number` | `0.38` | how hard the noise chews the boundary. useful range 0..1.5 |
| `detail` | `number` | `0.28` | secondary, finer octave amount |
| `feather` | `number` | `0.012` | anti-alias width of the cut. `0.012` is a knife edge |
| `threshold` | `number` | `0.18` | mask value the cut happens at, clamped to 0.01..0.99 |
| `refraction` | `number` | `0.008` | rim refraction strength in uv. `0` disables it |
| `refractionFalloff` | `number` | `55` | how tightly refraction hugs the rim |
| `speed` | `number` | `1` | drift speed of the noise field |
| `bubble` | `number` | `0.5` | how hard the banded-noise term punches holes **through** the reveal. `0` is the plain carve and nothing else. Useful range 0..1.2 |
| `bubbleScale` | `number` | `2.5` | how many nested level sets one noise hill is wrapped into. Higher = more, smaller holes; much over `4` it turns into visible contour rings |
| `facet` | `number` | `0` | `0` reads the mask smoothly; `1` reads it on its own grid, giving a low-poly, faceted tear. Fractional values blend |

`bubble` is what leaves islands of `front` standing inside uncovered ground, and specks
detached from the main stroke. It is gated on the mask's own health, so a `progress`-driven
reveal stays clean - the holes only appear where a stroke put them.

**`carve` and `refraction` moved in this release** (`0.62 → 0.38` and `0.012 → 0.008`). The
wave and the bubbles now supply most of the character, so the old carve double-counted it
and the old rim fringe fought the torn boundary. `edge: "plain"` puts both back and turns
the wave off - see [Presets](#presets).

### `BrushOptions`

| key | type | default | what it does |
| --- | --- | --- | --- |
| `radius` | `number` | `0.3` | radius in aspect-corrected units (1 = image height) |
| `persist` | `boolean` | `false` | painted area never fades - what is uncovered stays uncovered until `clear()`. Ignores `trail` |
| `spotlight` | `boolean` | `false` | no trail at all - the reveal is only where the pointer is right now, and closes immediately behind it. Ignores `trail`, and forces `wave` off |
| `trail` | `number` | `2.8` | with `persist` and `spotlight` off, seconds a stroke stays before it has fully faded |
| `healRate` | `number` | `1 / trail` | how fast the mask heals, in mask units per second. `persist: true` is exactly `healRate: 0`; `spotlight: true` is exactly `healRate: Infinity` |
| `holdTimeout` | `number` | `130` | ms of pointer stillness after which painting stops. Ignored under `spotlight` |
| `wave` | `boolean \| WaveOptions` | `true` | momentum: a stroke throws the reveal forward and it keeps travelling after the pointer stops |

`trail`, `healRate`, `persist` and `spotlight` are four views of one number. `trail` is a
duration, `healRate` is its reciprocal, and `persist` and `spotlight` are the two ends of
it - `healRate: 0`, nothing ever heals, and `healRate: Infinity`, everything heals every
frame. Set whichever reads best.

Precedence, coarsest first: **`persist` beats `spotlight` beats an explicit `healRate`
beats `trail`.** `persist` and `spotlight` are opposites, so asking for both is a mistake
rather than a blend: `persist` wins and a development-build warning says so.

### `WaveOptions`

`brush.wave` is `true` by default, `false` is exactly `{ enabled: false }`, and an object
tunes it. Everything here is a uniform and takes effect on the next frame through
`setOptions()` - except `resolution`, which reallocates the mask, at the same cost as a
resize.

| key | type | default | what it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | master switch. `false` is exactly the pre-wave behaviour |
| `advect` | `number` | `2` | how far the reveal is carried along its own velocity each second, in uv at full speed. `0` = no momentum |
| `inject` | `number` | `1` | velocity a second of full-strength contact puts into the field, along the stroke. This is what makes a stroke *throw* the reveal |
| `swirl` | `number` | `0.45` | `0` = injected velocity runs along the stroke; `1` = purely across it, counter-rotating on either side. The rotational part is where the curls and detached islands come from |
| `damping` | `number` | `0.16` | fraction of the velocity field that survives one second, clamped to 0..0.98. Lower = the wave stops sooner |
| `spread` | `number` | `0.12` | how fast the reveal creeps into its neighbours, uv/second. **Forced to `0` under `persist`**, and clamped under `healRate` otherwise |
| `resolution` | `number` | `512` | cap on the mask's long edge while the wave is on. Lower = more faceted, and cheaper |

How it works: the mask's two spare channels carry a velocity field. A stroke injects into
it - forward along the stroke, and rotating in opposite directions on either side of it -
and every frame the reveal is dilated along that field while the field itself is
transported and damped. Nothing else is added: no second render target, no extra program,
no float textures.

Two things follow, and both are load-bearing:

- **It always stops.** Damping contracts the velocity every frame and snaps it to exactly
  zero once it is inside one step of the 8-bit encoding, so the wave has a hard, bounded
  life (about 2.5 s at the default `damping`), and the front can only travel as far as the
  velocity carries it in that time. `persist: true` plus the wave settles to a reveal
  fraction that then holds constant to five decimals indefinitely.
- **`spread` is forced to `0` under `persist`.** It is the only term that adds to the
  reveal without a stroke, and with nothing ever healing, a creep of any size would
  eventually reach every texel on the plate.

With the wave on, the mask is capped at `wave.resolution` (512) rather than 1024. That is
both the cheaper choice and the better-looking one: the coarser field is what gives the
tear its faceted character.

### `SkeletonOptions`

| key | type | default | what it does |
| --- | --- | --- | --- |
| `src` | `ImageSource` | - | the line art. One of `src` or `mesh` is required |
| `mesh` | `MeshSkeletonHandle` | - | a 3D wireframe from [`revealed/mesh`](#3d-wireframe-skeletons) instead of an image. Wins over `src`; forces `source: "alpha"`. You own its lifecycle |
| `color` | `string` | `"#18375d"` | any CSS colour the art is tinted to. Ignored by `source: "image"` |
| `opacity` | `number` | `0.18` | peak opacity |
| `mode` | `"draw" \| "hold" \| "pulse" \| "scan"` | `"draw"` | `"draw"` sketches a pen front top→bottom then fades; `"hold"` is constant; `"pulse"` breathes; `"scan"` is mesh-only - a band travelling along the model's own object-space Y (on an image it collapses to `"hold"`) |
| `period` | `number` | `5.4` | seconds for one draw-on / hold / fade / scan cycle |
| `source` | `"alpha" \| "luma" \| "image"` | `"alpha"` | how the image becomes coverage. Ignored - and forced to `"alpha"` - with a mesh |
| `reactive` | `boolean` | `true` | raise coverage while strokes are passing; on a still, untouched field the ghost drops to about a ninth of `opacity` |

`source` and `mode` are the only two options in the whole library that are baked into the
shader. Changing either relinks the display program; everything else about the skeleton is
a uniform.

With a mesh, `mode` and `period` are also forwarded down to the handle, so set them here
rather than on `meshSkeleton()`.

### `IdleOptions`

Pass `idle: false` to switch the autopilot off, `idle: true` to force it on, or an object:

| key | type | default | what it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true`, or `false` when `brush.persist` is on | autopilot strokes so the effect breathes |
| `strokes` | `number` | `2` | concurrent strokes, clamped to 1..4 |
| `speed` | `number` | `1` | stroke travel speed multiplier |
| `region` | `UvRect` | whole image | uv rect the strokes aim through |
| `yieldAfter` | `number` | `900` | ms of pointer inactivity before the autopilot starts spawning again |

Strokes already in flight always finish - the autopilot never cuts one off mid-sweep - and
it only starts a new one once the pointer has been quiet for `yieldAfter`.

### `UvRect`

`measure` and `idle.region` are both `UvRect`: `{ x0, y0, x1, y1 }` in 0..1 of the plate,
y down, clamped to that range.

---

## Presets

```tsx
import { Revealed } from "revealed/react";

export function Dissolving() {
  return <Revealed front="/a.webp" back="/b.webp" edge="dissolve" />;
}
```

| preset | feel | overrides | wave |
| --- | --- | --- | --- |
| `liquid` | wet, torn, travelling - the default look | *(the defaults)* | on |
| `plain` | **everything the library did before the wave** | `carve: 0.62, refraction: 0.012, bubble: 0, facet: 0` | off |
| `dissolve` | fine grain, crumbling edge, most holes | `scale: 22, carve: 0.5, detail: 0.4, feather: 0.008, bubble: 0.8, bubbleScale: 4` | on |
| `ink` | slow, heavy, curling blot | `scale: 4, carve: 0.8, detail: 0.15, speed: 0.4, refraction: 0.02` | `swirl: 0.7, damping: 0.35` |
| `shatter` | sharp angular tears, low-poly edge | `scale: 12, carve: 1.1, detail: 0.05, feather: 0.004, refraction: 0, bubble: 0.3, facet: 1` | on |
| `clean` | no noise, no holes, plain soft circle | `carve: 0, detail: 0, feather: 0.02, refraction: 0, bubble: 0, facet: 0` | off |

![The same stroke on the same frame, rendered six times - edge="liquid", "plain", "dissolve", "ink", "shatter" and "clean" - each labelled, so the carved boundary can be compared from a torn lace, through a quiet curve, to a fine speckled crumble.](https://raw.githubusercontent.com/idleCyrex/revealed/main/media/presets.png)

### Getting the old look back

`edge: "plain"` is the pre-wave library in one word - the old `carve` and `refraction`, no
bubbles, no faceting, and no momentum:

```tsx
<Revealed front="/a.webp" back="/b.webp" edge="plain" />
```

Anything narrower is a normal override. `brush={{ wave: false }}` kills only the momentum
and keeps the bubbles; `edge={{ bubble: 0 }}` kills only the bubbles and keeps the
momentum.

A preset is an `EdgeOptions` patch over the defaults, plus - for the named presets only -
an implied `brush.wave`. An explicit `brush.wave` always wins over the preset's, and an
`edge` given as an object never carries a preset wave, because there is no preset to carry
one from. Start from a preset and override:

```tsx
import { presets } from "revealed";
import { Revealed } from "revealed/react";

export function SlowInk() {
  return (
    <Revealed front="/a.webp" back="/b.webp" edge={{ ...presets.ink, speed: 0.15 }} />
  );
}
```

---

## Recipes

### Make the reveal permanent

`brush.persist` stops the mask healing: whatever the visitor uncovers stays uncovered, and
`clear()` is the only way back. `trail` is ignored while it is on.

```tsx
import { useRef } from "react";
import { Revealed, type RevealHandle } from "revealed/react";

export function Frosted() {
  const ref = useRef<RevealHandle>(null);
  return (
    <>
      <Revealed
        ref={ref}
        front="/frosted.webp"
        back="/window.webp"
        brush={{ persist: true, radius: 0.22 }}
        onReveal={(f) => f === 1 && console.log("all of it")}
      />
      <button onClick={() => ref.current?.clear()}>Frost it over again</button>
    </>
  );
}
```

Same thing in plain JS:

```ts
import { RevealField } from "revealed";

const field = new RevealField(document.querySelector<HTMLElement>("#hero")!, {
  front: "/frosted.webp",
  back: "/window.webp",
  brush: { persist: true },
});
// field.clear() puts the frost back
```

The idle autopilot would paint the whole image out on its own here, so it defaults **off**
whenever `persist` is on. Ask for `idle: true` explicitly if you want a picture that
uncovers itself over a minute or two.

`persist` is live: flip it through `setOptions()` and whatever is painted right now freezes
in place; flip it back and the mask resumes fading from exactly where it is. For a slow,
permanent-*ish* fade rather than a hard freeze, set a low `healRate` instead -
`brush: { healRate: 0.01 }` takes about a hundred seconds to heal.

The wave still works under `persist`, and still terminates: `wave.spread` is forced to `0`
(it is the one term that would grow the reveal with no stroke behind it, and with nothing
healing it would eventually take the whole plate), and the momentum runs out on its own
inside a few seconds. What a stroke leaves behind is the union of where it painted and
where it threw the reveal, and that is final until `clear()`.

### Make it a torch instead of a paint stroke

`brush.spotlight` is the other end of the same number `persist` is one end of. Where
`persist` is `healRate: 0` and nothing ever heals, `spotlight` is `healRate: Infinity` and
*everything* heals every frame - so the reveal is only ever exactly where the pointer is
right now, and closes immediately behind it.

![Two copies of the same tree painted with the same stroke. On the left the default brush leaves a trail of bare winter branches that heals over behind the pointer. On the right, brush.spotlight keeps the reveal only under the pointer, closing immediately behind it.](https://raw.githubusercontent.com/idleCyrex/revealed/main/media/spotlight.gif)

```tsx
import { Revealed } from "revealed/react";

export function Torch() {
  return (
    <Revealed
      front="/dark.webp"
      back="/lit.webp"
      brush={{ spotlight: true, radius: 0.18 }}
    />
  );
}
```

Things worth knowing:

- **The wave is forced off.** Momentum that outlives the frame is a trail, which is the one
  thing this mode is defined by not having. An explicit `brush.wave` cannot bring it back.
- **The edge is not a plain circle.** `carve`, `detail` and `bubble` all still apply, so
  the light has the same torn, holed rim a stroke does. `edge: "clean"` if you do want a
  plain disc.
- **A still pointer keeps the light on.** `holdTimeout` is ignored here: with no trail for
  a held mark to fade into, "where the pointer is" is still a place. The light goes out
  when the pointer *leaves*, not when it stops.
- **The autopilot still works** and is still on by default - it moves a virtual cursor, and
  the light follows it, which is exactly what you want for a self-demonstrating hero. That
  is the opposite of the `persist` case, where idle defaults off because it would uncover
  the whole picture.
- **`onReveal` reports the footprint of the light**, which is small and near-constant while
  the pointer is down and `0` when it is not. That is the truth, not a bug - there is
  nothing accumulated to measure. Use `progress` if you need a number that climbs.
- `clear()` and `revealAll()` still work; `revealAll()` shows everything for exactly one
  frame before the next one heals it away.

Under the hood there is no special case: an infinite heal rate is a whole mask unit of
decay per frame, which the existing decay arithmetic already produces at its limit, and the
mask pass skips its feedback fetch entirely when it sees one.

### Drive the reveal from scroll, with no pointer

`progress` is a floor under the painted mask. It is not a cross-fade: it runs through the
same carved cut a stroke does, so a scroll-driven reveal wears the identical wet edge. It
never touches the mask, so a pointer can still paint on top of it.

```tsx
import { useEffect, useState } from "react";
import { Revealed } from "revealed/react";

export function ScrollReveal() {
  const [p, setP] = useState(0);

  useEffect(() => {
    const on = () => setP(Math.min(1, window.scrollY / 800));
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return <Revealed front="/a.webp" back="/b.webp" progress={p} idle={false} />;
}
```

With `edge: "clean"` (no carve, no detail) the progress sweep degrades to a plain
top-to-bottom wipe, which is often what you want for a scroll-linked hero.

`bubble` does not punch holes in a `progress`-driven reveal: the band term is gated on the
mask's own health, and `progress` never touches the mask. A scroll sweep stays clean even
at `edge: "dissolve"`, while a pointer painting on top of it still gets the holes.

### Count something as it is uncovered

```tsx
import { useState } from "react";
import { Revealed } from "revealed/react";

export function Counter() {
  const [year, setYear] = useState(1997);
  return (
    <Revealed
      front="/crt.webp"
      back="/monitor.webp"
      measure={{ x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.74 }}
      onReveal={(f) => setYear(1997 + Math.round(f * 28))}
    >
      <span>{year}</span>
    </Revealed>
  );
}
```

### Reveal on click, reset on double click

```tsx
import { useRef } from "react";
import { Revealed, type RevealHandle } from "revealed/react";

export function ClickToReveal() {
  const ref = useRef<RevealHandle>(null);
  return (
    <div
      onClick={() => ref.current?.revealAll()}
      onDoubleClick={() => ref.current?.clear()}
    >
      <Revealed ref={ref} front="/a.webp" back="/b.webp" />
    </div>
  );
}
```

### Draw a scripted stroke

`paint()` takes plate uv. Calls less than 200 ms apart join into one continuous stroke,
however far apart the points are.

```ts
import { RevealField } from "revealed";

declare const field: RevealField;

let t = 0;
const id = setInterval(() => {
  t += 0.02;
  field.paint(t, 0.5 + Math.sin(t * 6) * 0.2);
  if (t > 1) clearInterval(id);
}, 16);
```

---

## API

Everything exported from `revealed`:

```ts
import {
  RevealField,
  isSupported,
  presets,
  DEFAULT_EDGE,
  DEFAULT_BRUSH,
  type BrushOptions,
  type EdgeOptions,
  type EdgePreset,
  type IdleOptions,
  type ImageSource,
  type ResolvedBrush,
  type RevealOptions,
  type SkeletonOptions,
  type UvRect,
} from "revealed";
```

…and everything exported from the optional `revealed/mesh` subpath:

```ts
import {
  meshSkeleton,
  MeshWireframe,
  loadMesh,
  parseObj,
  parseEdgeJson,
  fromArrays,
  MAX_VERTICES,
  type MeshData,
  type MeshPointer,
  type MeshSkeletonHandle,
  type MeshSkeletonOptions,
  type MeshSource,
} from "revealed/mesh";
```

`revealed/mesh` imports nothing from the core and the core imports nothing from it (the
`skeleton.mesh` type is erased at compile time), so the two are independent bundles. See
[3D wireframe skeletons](#3d-wireframe-skeletons).

### `RevealField`

```ts
class RevealField {
  constructor(host: HTMLElement, options: RevealOptions);

  /** merge new options; image sources reload plates, everything else is live */
  setOptions(next: Partial<RevealOptions>): void;
  /** paint at a point in 0..1 uv of the plate - calls <200ms apart join into one stroke */
  paint(x: number, y: number, strength?: number): void;
  /** wipe the mask back to fully covered - the only way back under `brush.persist` */
  clear(): void;
  /** flood the mask - `back` fully visible. Then decays over `brush.trail` like any
   *  other stroke, unless `brush.persist` is on, where it stays */
  revealAll(): void;
  /** restart the render loop after `pause()` or `running: false` */
  play(): void;
  /** park the render loop; the canvas keeps its last frame */
  pause(): void;
  /** free the context, observers, listeners and injected DOM, and restore the host */
  destroy(): void;

  /** last measured 0..1 fraction of `measure` uncovered */
  readonly progress: number;
  /** true while the WebGL effect is actually running on this field */
  readonly supported: boolean;
}
```

`strength` defaults to `1` and is clamped to 0..1. Constructing a field without a DOM (an
accidental `new` on the server) is inert rather than a crash.

### `isSupported()`

```ts
import { isSupported } from "revealed";

const willAnimate = isSupported();
```

`true` when a hardware WebGL context is available and the visitor has not asked for reduced
motion. False on the server. You rarely need it - the field falls back on its own - but it
is there if you want to skip preloading the second plate.

### `presets`, `DEFAULT_EDGE`, `DEFAULT_BRUSH`, `DEFAULT_WAVE`

`presets` is a `Record<EdgePreset, EdgeOptions>` of the six looks above, each a sparse
patch over the defaults. `DEFAULT_EDGE` is the full `Required<EdgeOptions>` those patches
land on. `DEFAULT_BRUSH` is the resolved brush - `radius`, `persist`, `spotlight`, `trail`,
`healRate`, `holdTimeout` and `wave` - with `healRate` already derived from `trail`. `DEFAULT_WAVE` is
the resolved wave on its own. Their types are exported as `ResolvedBrush` and
`ResolvedWave`.

Note that `presets` carries only the *edge* half of a preset. The wave a named preset
implies is not part of it, because the wave is a brush option - spreading `presets.plain`
into an `edge` object gives you its carve, not its lack of momentum.

```ts
import { DEFAULT_EDGE, DEFAULT_BRUSH } from "revealed";

const softer = { ...DEFAULT_EDGE, carve: DEFAULT_EDGE.carve * 0.5 };
const slower = { radius: DEFAULT_BRUSH.radius, trail: DEFAULT_BRUSH.trail * 3 };
```

### React

```tsx
import {
  Revealed,
  useRevealed,
  type RevealHandle,
  type RevealedProps,
  type UseRevealedResult,
} from "revealed/react";
```

`<Revealed />` takes every `RevealOptions` prop plus:

| prop | type | what it does |
| --- | --- | --- |
| `className` | `string` | on the host element |
| `style` | `CSSProperties` | on the host element |
| `fallback` | `ReactNode` | rendered until the field mounts - i.e. on the server and during the first client render |
| `children` | `ReactNode` | rendered in an absolutely positioned layer over the canvas |
| `ref` | `Ref<RevealHandle>` | `paint`, `clear`, `revealAll`, `play`, `pause`, and `field` |

`RevealHandle.field` is the underlying `RevealField | null`, for anything the handle does
not cover.

`useRevealed(hostRef, options)` is the same thing for an element you own. It returns
`{ field, supported, ready, progress }`, where `progress` is React state that updates about
ten times a second.

```tsx
import { useRef } from "react";
import { useRevealed } from "revealed/react";

export function Custom() {
  const hostRef = useRef<HTMLDivElement>(null);
  const { ready, progress } = useRevealed(hostRef, {
    front: "/a.webp",
    back: "/b.webp",
  });

  return (
    <div ref={hostRef} style={{ position: "relative", maxWidth: 820 }}>
      {ready ? <span>{Math.round(progress * 100)}%</span> : null}
    </div>
  );
}
```

Both are built so the field is constructed **once**, keyed only on the image sources.
Every other prop is forwarded through `setOptions`, and callbacks live in a ref - so an
inline `onReveal={(f) => setYear(f)}` will never tear down the GL context.

Only three things rebuild the field: `front`, `back`, and the skeleton's **image** - that
is `skeleton` when you pass a string, or `skeleton.src` when you pass an object (adding or
removing the skeleton counts as an image change). Every other key of `SkeletonOptions` -
`color`, `opacity`, `mode`, `period`, `source`, `reactive` - is live, exactly as it is
through `setOptions()`. Retinting the line art when a theme toggle flips is a uniform
change on the next frame, not a remount:

```tsx
<Revealed
  front="/before.webp"
  back="/after.webp"
  skeleton={{ src: "/outline.svg", color: dark ? "#ffffff" : "#000000" }}
/>
```

Object props are compared by **value**, not by identity, so writing `edge={{ … }}` or
`skeleton={{ … }}` inline - a fresh object on every render - pushes an update only when
something inside it actually changed.

### SSR and Next.js

`revealed/react` ships its own `"use client"` banner, so `<Revealed />` drops straight into
a Next.js App Router server component. No `dynamic()`, no `ssr: false`.

The server render is the host `<div>` plus `fallback`; the canvas and the plates are
injected after hydration. The core entry carries no directive, so importing `revealed` in
shared code does not drag a bundler into a client boundary - and importing it on the server
touches no browser global.

---

## What happens when things are not ideal

| situation | what the field does |
| --- | --- |
| no WebGL, or context creation fails | keeps the static front plate; `onError("revealed: could not create a WebGL context")` |
| software renderer (SwiftShader, llvmpipe, a blocklisted GPU) | never attempts GL - the CPU cost of this shader is not worth it; `onError("revealed: no hardware WebGL, using the static plate")` |
| `prefers-reduced-motion: reduce` | never brings GL up, and this is **not** an error, so `onError` does not fire. Re-checked live: turning the preference on tears the effect down mid-session, turning it off brings it back, no reload |
| tab hidden | the rAF loop stops. On return the frame clock is re-stamped, so the trail cannot jump forward by however long you were away |
| element scrolled off screen | an `IntersectionObserver` (threshold 0.01) stops the loop; the canvas holds its last frame and resumes where it left off |
| window blurred | the pointer is treated as gone, so the autopilot is not parked by a cursor left resting on the image |
| WebGL context lost | the loss is `preventDefault`ed so a restore is possible, GL is freed and the static front plate is shown again. On `webglcontextrestored` the field brings itself back up automatically, starting from a covered mask |
| a plate 404s, or is cross-origin without CORS | `onError("revealed: image failed: <url>")` and the static plates stay |
| shader link, framebuffer or texture allocation fails | same fallback, with the specific message |

In every one of those cases `onReady` still fires once the front plate has decoded, and
`field.supported` is `false`.

## What it does to your DOM

- Injects the two `<img>` plates and the `<canvas>` as the host's **first** children, so
  anything you render into the host (React `children`, a caption, a button) stays on top.
  The back plate is loaded but hidden - only GL ever shows it.
- Sets `position: relative` on the host if it computes to `static`, and claims its
  `aspect-ratio` only if your CSS has not already set one.
- Adds the class `revealed--gl` to the host while the canvas is the thing on screen, and
  removes it whenever the field falls back to the plate. Useful for styling an overlay
  that should only appear over the live effect.
- Sets `touch-action: pan-y` on the pointer target, but only if the page has not set one
  itself - vertical pans keep scrolling the page, sideways movement paints.
- `ResizeObserver` on the host. A resize mid-stroke resamples the old mask into the new
  one, so the trail does not flash away.
- Caps `devicePixelRatio` at 1.5 by default - the display pass runs two 5-octave fbm
  evaluations per pixel, and the extra resolution buys nothing on an effect this soft.
- `destroy()` frees every texture, framebuffer, program, buffer, observer, listener and
  animation frame, calls `WEBGL_lose_context`, removes the injected nodes and puts the
  host's inline `position` and `aspect-ratio` back the way it found them.

## Accessibility

The plates are decorative and the library treats them that way. **The surrounding page
owns the meaning.**

- Both `<img>` plates carry `alt=""` and the canvas is `aria-hidden="true"`. If the
  pictures carry information, put it in real text next to them, or in `children`.
- Never make the reveal the only way to reach something. Nothing here is pointer-gated:
  `progress`, `revealAll()` and `paint()` let you drive the effect from a button, a scroll
  position, a keyboard handler or a timer.
- `prefers-reduced-motion: reduce` skips WebGL entirely and leaves the static front plate,
  re-checked live.
- Touch works - a stroke lives from finger-down to finger-up - and the page still scrolls.

## Browser support

Any browser with WebGL 1: Chrome, Edge, Firefox, Safari 15+, and their mobile counterparts.
Everything uses core WebGL 1 - no extensions, no float textures, no derivatives - with a
hardware context required (`failIfMajorPerformanceCaveat`, plus a renderer-string check for
software rasterizers that slip past it).

## Troubleshooting

**Nothing shows up at all.** The host needs a width. The field takes an aspect ratio but
never a width, and a host with zero client width or height is skipped entirely - it will
start the moment layout gives it a box.

**The plates look stretched.** They are `object-fit: fill`. Either give `front` and `back`
the same dimensions, or set `aspect` explicitly. If your own CSS already sets
`aspect-ratio` on the host, the library leaves it alone and yours wins.

**It stays a static image and `onError` says "no hardware WebGL".** A software rasterizer
(headless Chrome, a VM, a blocklisted GPU) or a browser that refused the context. This is
the intended fallback, not a bug.

**It stays a static image and no error fires.** `prefers-reduced-motion: reduce` is on, in
the OS or in devtools' rendering panel.

**`onError` says "image failed".** The plate 404'd, or it is cross-origin and the host did
not send `Access-Control-Allow-Origin`. Cross-origin plates are requested with
`crossOrigin="anonymous"` because a tainted texture would poison the whole context.

**The reveal heals when I asked for permanent.** `healRate` beats `trail`, and `persist`
beats both - check you are not setting an explicit `healRate` alongside `persist: false`.

**`spotlight` does nothing.** `persist` beats it. They are opposite ends of `healRate`, so
only one can apply; drop `persist`. A development build says so in the console.

**The autopilot never runs.** It defaults off when `brush.persist` is on (it would uncover
the whole picture on its own); pass `idle: true` to override. It also only spawns after the
first frame has painted and after `idle.yieldAfter` ms of pointer quiet.

**`onReveal` never moves.** It needs frames: a paused field, one that is off screen, or one
in a hidden tab does not measure. Check `measure` covers the part you are painting, and
remember the reported value is `max(measured, progress)`.

**The skeleton is invisible.** Default `opacity` is `0.18`, and with `reactive: true` it
sits near a ninth of that on a still field and rises as strokes pass. Black-on-white art
needs `source: "luma"`; transparent art needs `source: "alpha"` (the default).

**The mesh skeleton never appears.** Check the handle's `onError` first - the fetch is
deliberately never awaited, so a 404 or a parse failure is silent apart from that callback,
and leaves a transparent skeleton rather than a black stamp. If `handle.ready` is `true` and
`handle.edgeCount` is sane, it is the same visibility story as above: raise
`skeleton.opacity`, or `meshAlpha` on the handle.

**The mesh skeleton is grey mush.** Too many edges. A wireframe at half alpha with no depth
test stops reading as a shape somewhere above ~3,000 edges - decimate to 1,500–3,000. This
is a visual limit, not a performance one.

**`mode: "scan"` behaves like `"hold"`.** Either the skeleton is an image (`"scan"` is
mesh-only and collapses to `"hold"` there), or `prefers-reduced-motion` is on, which freezes
the band with the pose.

**Painting on touch does nothing until I press.** That is deliberate: with no hover there
is nothing to enter with, so a stroke lives from finger-down to finger-up.

**The reveal keeps moving after I stop, and I did not ask for that.** That is the wave, and
it is on by default. `brush={{ wave: false }}` turns it off; `edge="plain"` turns off the
whole new look at once.

**The edge has holes in it that were not there before.** That is `edge.bubble`, also on by
default - it is what leaves islands of the front plate standing inside the uncovered area.
`edge={{ bubble: 0 }}` removes them and keeps everything else.

**The boundary went blockier.** With the wave on the mask runs at 512 rather than 1024, and
`edge.facet` may be quantising the fetch on top of that. Raise `brush.wave.resolution` or
drop `facet` to `0`.

**`onReveal` goes down as well as up.** Expected with the wave: see
[`onReveal` reports…](#options) above. Latch it yourself if you need a one-way signal.

## Contributing

Issues and pull requests are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for how to
run the build and what the project will not accept (chiefly: it stays at zero runtime
dependencies). Bugs go to
[GitHub issues](https://github.com/idleCyrex/revealed/issues); a reproduction matters more
than a description, because most of what goes wrong here is driver- and
renderer-specific.

## Licence

MIT © 2026 idlee.xyz
