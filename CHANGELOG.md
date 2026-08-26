# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - Initial release

### Added

- `RevealField` - the vanilla WebGL engine. Injects its own `<canvas>` plus
  the `front`/`back` `<img>` plates behind it, so a correct static image is
  always on screen even before (or without) GL.
- `<Revealed />` React component and `useRevealed()` hook (`revealed/react`
  entry point, ships its own `"use client"` banner), plus `RevealHandle`
  (`paint`/`clear`/`revealAll`/`play`/`pause`/`field`) via `ref`.
- Three-layer reveal model: required `front` and `back` images, optional
  `skeleton` line-art layer that ghosts onto `front` and sketches itself on
  in a loop (`draw` / `hold` / `pulse` modes), wiped away exactly where
  `back` is already uncovered.
- Wet, noise-carved edge: fbm-driven cut between the two plates with
  gradient-driven rim refraction, tunable via `EdgeOptions` (`scale`,
  `carve`, `detail`, `feather`, `threshold`, `refraction`,
  `refractionFalloff`, `speed`).
- Five edge presets: `liquid`, `dissolve`, `ink`, `shatter`, `clean`.
- Capsule-brush pointer painting with configurable `radius`, fade `trail`,
  and stillness `holdTimeout`, plus a programmatic `paint(x, y, strength?)`
  API in plate uv space.
- Idle autopilot strokes so the effect breathes with no pointer input
  (`IdleOptions`: `enabled`, `strokes`, `speed`, `region`, `yieldAfter`).
- `progress` option and `onReveal` callback for scroll-driven or otherwise
  controlled reveals, measurable over a `measure` sub-rect.
- Automatic environment handling: `ResizeObserver`, `IntersectionObserver`
  pause off-screen, `visibilitychange` pause on hidden tabs,
  `prefers-reduced-motion: reduce` support (re-checked live), software
  renderer (SwiftShader/llvmpipe) refusal, and automatic recovery from
  WebGL context loss - all falling back to the static plates.
- `isSupported()` and cached, SSR-safe hardware-GL detection.
- Narrow-viewport image swapping via `{ src, small, smallMaxWidth }` sources.
- Full cleanup via `destroy()` - textures, FBOs, programs, buffers,
  observers, listeners, and the render loop are all freed.
- ESM + CJS + `.d.ts` builds for both entry points, plus a minified IIFE
  (`revealed.global.js`) for CDN/`<script>` use via `window.revealed`.
- Zero runtime dependencies; `react`/`react-dom` are optional peer
  dependencies used only by the `revealed/react` entry point.
