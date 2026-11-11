import { getStroke } from 'perfect-freehand';
import type { InkStroke, ViewMatrix } from '../domain/types';
import { SAMPLE_STRIDE } from '../domain/types';

type PathSrc = {
  id?: string;
  revision?: number;
  samples: Float32Array;
  width: number;
  tool?: InkStroke['tool'];
  smoothing?: number;
};

const MAX_PATH_CACHE = 2000;
const strokePathCache = new Map<string, Path2D>();
const centerlinePathCache = new Map<string, Path2D>();

/** Nib behaviour: ballpoint ~constant width; fountain = elliptical chisel; brush = strong pressure curve. */
export function strokePath(s: PathSrc, complete = true): Path2D {
  const tool = s.tool ?? 'ballpoint';
  const cacheKey =
    complete && s.id
      ? `${s.id}:${s.revision ?? 1}:${s.width}:${tool}:${s.smoothing ?? ''}:${s.samples.length}`
      : null;
  if (cacheKey && strokePathCache.has(cacheKey)) {
    return strokePathCache.get(cacheKey)!;
  }
  const n = s.samples.length / SAMPLE_STRIDE;
  if (n === 0) return new Path2D();

  // Single-point dot or ultra-short tap: render a clean filled disc so dots/i-tittles/punctuation never disappear
  let totalLen = 0;
  for (let i = 1; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    totalLen += Math.hypot(s.samples[o] - s.samples[o - SAMPLE_STRIDE], s.samples[o + 1] - s.samples[o - SAMPLE_STRIDE + 1]);
  }
  if (n === 1 || totalLen < 0.35) {
    const p = new Path2D();
    const r = Math.max(0.5, (s.width * (tool === 'brush' ? 1.1 : 1.0)) / 2);
    p.arc(s.samples[0], s.samples[1], r, 0, Math.PI * 2);
    if (cacheKey) {
      if (strokePathCache.size >= MAX_PATH_CACHE) {
        const oldest = strokePathCache.keys().next().value;
        if (oldest) strokePathCache.delete(oldest);
      }
      strokePathCache.set(cacheKey, p);
    }
    return p;
  }

  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    let p = Math.max(0.05, Math.min(1, s.samples[o + 2]));
    if (tool === 'brush') p = 0.18 + 0.82 * Math.pow(p, 1.35);
    if (tool === 'fountain' && i > 0) {
      const dx = s.samples[o] - s.samples[o - SAMPLE_STRIDE], dy = s.samples[o + 1] - s.samples[o - SAMPLE_STRIDE + 1];
      if (Math.hypot(dx, dy) > 0.25) {
        const ang = Math.atan2(dy, dx);
        p *= 0.42 + 0.58 * Math.abs(Math.sin(ang - Math.PI / 4));
      }
    }
    pts.push([s.samples[o], s.samples[o + 1], p]);
  }
  const cfg = {
    ballpoint: { thinning: 0.08, smoothing: 0.35, streamline: 0.2 },
    fountain: { thinning: 0.48, smoothing: 0.42, streamline: 0.25 },
    brush: { thinning: 0.72, smoothing: 0.48, streamline: 0.28 },
    highlighter: { thinning: 0, smoothing: 0.35, streamline: 0.2 },
  }[tool];
  const outline = getStroke(pts, {
    size: tool === 'brush' ? s.width * 1.45 : s.width,
    thinning: cfg.thinning,
    smoothing: cfg.smoothing,
    streamline: s.smoothing ?? cfg.streamline,
    simulatePressure: false,
    // Keep last: true for both live and committed so lifting the pen never causes a sudden curve/width jump!
    last: true,
    start: tool === 'highlighter' ? { cap: false } : undefined,
    end: tool === 'highlighter' ? { cap: false } : undefined,
  });
  const p = new Path2D();
  if (outline.length < 2) {
    if (pts.length) p.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2);
    return p;
  }
  p.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) p.lineTo(outline[i][0], outline[i][1]);
  p.closePath();
  if (cacheKey) {
    if (strokePathCache.size >= MAX_PATH_CACHE) {
      const oldest = strokePathCache.keys().next().value;
      if (oldest) strokePathCache.delete(oldest);
    }
    strokePathCache.set(cacheKey, p);
  }
  return p;
}

/** Build a center-line path for dashed or dotted strokes. */
export function centerlinePath(samples: Float32Array, strokeId?: string, revision?: number): Path2D {
  const key = strokeId ? `${strokeId}:${revision ?? 1}:${samples.length}` : null;
  if (key && centerlinePathCache.has(key)) return centerlinePathCache.get(key)!;
  const p = new Path2D();
  const n = samples.length / SAMPLE_STRIDE;
  if (!n) return p;
  p.moveTo(samples[0], samples[1]);
  for (let i = 1; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    p.lineTo(samples[o], samples[o + 1]);
  }
  if (key) {
    if (centerlinePathCache.size >= MAX_PATH_CACHE) {
      const oldest = centerlinePathCache.keys().next().value;
      if (oldest) centerlinePathCache.delete(oldest);
    }
    centerlinePathCache.set(key, p);
  }
  return p;
}
export function applyView(ctx: CanvasRenderingContext2D, v: ViewMatrix, dpr: number) {
  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
}

export function boundsOf(samples: Float32Array, pad: number) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < samples.length; i += SAMPLE_STRIDE) {
    x0 = Math.min(x0, samples[i]);
    y0 = Math.min(y0, samples[i + 1]);
    x1 = Math.max(x1, samples[i]);
    y1 = Math.max(y1, samples[i + 1]);
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Deterministic rainbow gradient style from a seed and sample array. */
export function createRainbowStyle(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array,
  seed: number,
  fallbackColor: string,
): string | CanvasGradient {
  const n = samples.length / SAMPLE_STRIDE;
  if (n < 2) return fallbackColor;
  const x0 = samples[0], y0 = samples[1];
  const x1 = samples[(n - 1) * SAMPLE_STRIDE], y1 = samples[(n - 1) * SAMPLE_STRIDE + 1];
  const dx = x1 - x0, dy = y1 - y0;
  const g = Math.hypot(dx, dy) > 4
    ? ctx.createLinearGradient(x0, y0, x1, y1)
    : ctx.createLinearGradient(x0 - 25, y0 - 25, x0 + 25, y0 + 25);
  const baseHue = ((seed % 360) + 360) % 360;
  const stops = 6;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    const h = (baseHue + i * 60) % 360;
    g.addColorStop(t, `hsl(${h}, 92%, 60%)`);
  }
  return g;
}
