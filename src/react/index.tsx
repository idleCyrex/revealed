import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  RevealField,
  type ImageSource,
  type RevealOptions,
  type SkeletonOptions,
} from "../index.js";

export interface RevealHandle {
  /** paint at a point in 0..1 uv of the plate */
  paint: (x: number, y: number, strength?: number) => void;
  /** wipe the mask back to fully covered */
  clear: () => void;
  /** flood the mask — `back` fully visible */
  revealAll: () => void;
  play: () => void;
  pause: () => void;
  /** the underlying instance, for anything the handle does not cover */
  field: RevealField | null;
}

export interface RevealedProps extends RevealOptions {
  className?: string;
  style?: CSSProperties;
  /** rendered until the field has mounted — i.e. on the server and during the
   *  first client render. Once mounted the field's own plates take over, and
   *  they are what covers every degradation (no WebGL, reduced motion, a lost
   *  context) from then on. */
  fallback?: ReactNode;
  /** rendered over the canvas */
  children?: ReactNode;
}

export interface UseRevealedResult {
  field: RevealField | null;
  /** whether the WebGL effect is actually running */
  supported: boolean;
  /** plates decoded and the first frame painted */
  ready: boolean;
  /** last measured 0..1 fraction of `measure` uncovered */
  progress: number;
}

const OVERLAY: CSSProperties = { position: "absolute", inset: 0 };

/**
 * Attach a `RevealField` to an element you own.
 *
 * The field is constructed once per set of image sources; every other option
 * change is forwarded through `setOptions`, so changing a slider never tears
 * down the GL context. Callbacks are held in a ref, so an inline `onReveal`
 * does not re-create anything.
 *
 * ── Where every `RevealOptions` field goes ────────────────────────────────
 *
 * The three categories below are EXHAUSTIVE. A field in none of them is a prop
 * that silently does nothing after mount, which is the one failure this
 * binding can have; add new options to one of the lists as they are added to
 * `RevealOptions`, and keep the lists next to the code that implements them.
 *
 *  (b) CONSTRUCTION KEY — rebuilds the field, because a new image has to be
 *      decoded and uploaded:
 *        `front`, `back`, and the skeleton's IMAGE SOURCE — i.e. `skeleton`
 *        when it is a string, or `skeleton.src`. Adding or removing the
 *        skeleton entirely is a source change too.
 *
 *  (c) REF-HELD, never a dependency — an inline arrow must not key anything:
 *        `onReveal`, `onReady`, `onError`.
 *
 *  (a) FORWARDED LIVE through `setOptions` — everything else:
 *        `aspect`, `edge`, `brush`, `idle`, `maxDpr`, `running`, `progress`,
 *        `measure`, `pointerTarget`, `deferInit`, and every non-source field
 *        of `skeleton`: `color`, `opacity`, `mode`, `period`, `source`,
 *        `reactive`.
 *      `skeleton.source` and `skeleton.mode` are the only two options in the
 *      library baked into the shader; `setOptions` relinks the display program
 *      for them, still without touching the context. Everything else here is a
 *      uniform read on the next frame. `deferInit` is live but only decides
 *      how the NEXT GL bring-up is scheduled — it is a no-op while GL is up.
 *
 * Object-valued options are compared by VALUE, not by identity: the inline
 * `edge={{ … }}` / `skeleton={{ … }}` literal every caller naturally writes
 * cannot push an update on every render, and one mutated in place is still
 * seen. Element-valued ones (`pointerTarget`) stay identity-compared.
 */
export function useRevealed(
  hostRef: RefObject<HTMLElement | null>,
  options: RevealOptions
): UseRevealedResult {
  const [field, setField] = useState<RevealField | null>(null);
  const [supported, setSupported] = useState(false);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);

  /* callbacks live in a ref so an inline arrow prop cannot key the effect */
  const cbs = useRef(options);
  cbs.current = options;

  const onReveal = useCallback((f: number) => {
    setProgress(f);
    cbs.current.onReveal?.(f);
  }, []);
  const onReady = useCallback(() => {
    setReady(true);
    cbs.current.onReady?.();
  }, []);
  const onError = useCallback((err: Error) => {
    setSupported(false);
    cbs.current.onError?.(err);
  }, []);

  /* (b) the one construction effect. Keyed ONLY on the image identities: an
     option change must never remount GL. `options` deliberately does not
     appear in the dependency list — the second effect below forwards it
     instead. `skelSrcKey` is the skeleton's IMAGE only; the rest of the
     skeleton is live and belongs to the second effect. */
  const frontKey = srcKey(options.front);
  const backKey = srcKey(options.back);
  const skelSrcKey = skeletonSrcKey(options.skeleton);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const instance = new RevealField(host, {
      ...cbs.current,
      onReveal,
      onReady,
      onError,
    });
    setField(instance);
    setSupported(instance.supported);
    /* `supported` flips a tick after construction, once GL bring-up has run at
       browser idle, so it is re-read when the first frame lands */
    return () => {
      instance.destroy();
      setField(null);
      setReady(false);
      setSupported(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef, frontKey, backKey, skelSrcKey, onReveal, onReady, onError]);

  /* (a) every other prop, forwarded live. The object-valued ones are keyed by
     value so an inline literal is only an update when something in it really
     changed — the deps are these keys, never the objects themselves. */
  const edgeKey = valueKey(options.edge);
  const brushKey = valueKey(options.brush);
  const idleKey = valueKey(options.idle);
  const measureKey = valueKey(options.measure);
  const skelLiveKey = skeletonLiveKey(options.skeleton);
  /* a mesh handle has no value identity to key on, and it must NOT be a
     construction key: remounting GL on a swapped handle would throw away the
     mask mid-stroke. It is live, like the rest of the skeleton. */
  const skelMesh = skeletonObject(options.skeleton)?.mesh ?? null;

  useEffect(() => {
    if (!field) return;
    field.setOptions({
      aspect: options.aspect,
      edge: options.edge,
      brush: options.brush,
      idle: options.idle,
      maxDpr: options.maxDpr,
      running: options.running,
      progress: options.progress,
      measure: options.measure,
      pointerTarget: options.pointerTarget,
      deferInit: options.deferInit,
      /* the image is a construction key, so the only thing that can have
         changed here is the skeleton's colour, opacity, mode, period, source
         or reactive — all of which `setOptions` applies without a rebuild.
         Passing the whole object is safe: `setOptions` compares the source by
         value and reloads no plate when it is the same image. */
      skeleton: options.skeleton,
    });
    setSupported(field.supported);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    field,
    options.aspect,
    edgeKey,
    brushKey,
    idleKey,
    options.maxDpr,
    options.running,
    options.progress,
    measureKey,
    options.pointerTarget,
    options.deferInit,
    skelSrcKey,
    skelLiveKey,
    skelMesh,
  ]);

  useEffect(() => {
    if (field && ready) setSupported(field.supported);
  }, [field, ready]);

  return { field, supported, ready, progress };
}

/**
 * The image on top is painted away to reveal the one underneath.
 *
 * Renders a single host element; the canvas and the two `<img>` plates are
 * injected into it, and `children` sit above them. SSR-safe: the server render
 * is the host plus `fallback`, and GL is brought up after hydration.
 */
export const Revealed = forwardRef<RevealHandle, RevealedProps>(
  function Revealed(props, ref) {
    const { className, style, fallback, children, ...options } = props;
    const hostRef = useRef<HTMLDivElement | null>(null);
    const { field } = useRevealed(hostRef, options as RevealOptions);
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    useImperativeHandle(
      ref,
      (): RevealHandle => ({
        paint: (x, y, strength) => field?.paint(x, y, strength),
        clear: () => field?.clear(),
        revealAll: () => field?.revealAll(),
        play: () => field?.play(),
        pause: () => field?.pause(),
        field,
      }),
      [field]
    );

    return (
      <div ref={hostRef} className={className} style={style}>
        {!mounted && fallback ? fallback : null}
        {children ? <div style={OVERLAY}>{children}</div> : null}
      </div>
    );
  }
);

function srcKey(src: ImageSource | null | undefined): string {
  if (!src) return "";
  if (typeof src === "string") return src;
  return `${src.src}|${src.small ?? ""}|${src.smallMaxWidth ?? 640}`;
}

/** `{ src }` is both a valid `ImageSource` and a valid `SkeletonOptions`, and
 *  the two agree on what it means — only the ImageSource-only keys have to
 *  discriminate. Mirrors `normalizeSkeleton` in core/options.ts. */
function skeletonObject(sk: RevealOptions["skeleton"]): SkeletonOptions | null {
  if (!sk) return null;
  if (typeof sk === "string") return { src: sk };
  if ("small" in sk || "smallMaxWidth" in sk) return { src: sk as ImageSource };
  return sk as SkeletonOptions;
}

/** The skeleton's IMAGE — the only part of `skeleton` that rebuilds the field,
 *  because a new plate has to be decoded and uploaded. */
function skeletonSrcKey(sk: RevealOptions["skeleton"]): string {
  const o = skeletonObject(sk);
  return o ? srcKey(o.src) : "";
}

/** Everything about the skeleton that `setOptions` applies in place: the three
 *  uniforms (`color`, `opacity`, `period`), the two the display program is
 *  compiled for (`source`, `mode`) and `reactive`. Keyed by value so an inline
 *  `skeleton={{ … }}` object is not an update on every render. */
function skeletonLiveKey(sk: RevealOptions["skeleton"]): string {
  const o = skeletonObject(sk);
  if (!o) return "";
  return [o.color, o.opacity, o.mode, o.period, o.source, o.reactive]
    .map((v) => (v === undefined ? "" : String(v)))
    .join("|");
}

/** Stable, key-order-independent identity for a plain-data option. Used for
 *  `edge`, `brush`, `idle` and `measure`, which callers write inline. */
function valueKey(v: unknown): string {
  if (v === null || typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}:${valueKey(o[k])}`)
    .join(",")}}`;
}
