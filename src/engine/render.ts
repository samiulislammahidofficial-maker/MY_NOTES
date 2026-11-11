import { getStroke } from 'perfect-freehand';
import type { InkStroke, ViewMatrix } from '../domain/types';
import { SAMPLE_STRIDE } from '../domain/types';

type PathSrc = { samples: Float32Array; width: number; tool?: InkStroke['tool']; smoothing?: number };

/** Nib behaviour: ballpoint ~constant width; fountain = elliptical chisel; brush = strong pressure curve. */
export function strokePath(s: PathSrc, complete = true): Path2D {
  const tool = s.tool ?? 'ballpoint';
  const n = s.samples.length / SAMPLE_STRIDE;
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    let p = s.samples[o + 2];
    if (tool === 'brush') p = Math.pow(p, 1.6);
    if (tool === 'fountain' && i > 0) {
      const dx = s.samples[o] - s.samples[o - SAMPLE_STRIDE], dy = s.samples[o + 1] - s.samples[o - SAMPLE_STRIDE + 1];
      const ang = Math.atan2(dy, dx);
      p *= 0.35 + 0.65 * Math.abs(Math.sin(ang - Math.PI / 4));
    }
    pts.push([s.samples[o], s.samples[o + 1], p]);
  }
  const cfg = {
    ballpoint: { thinning: 0.1, smoothing: 0.5, streamline: 0.4 },
    fountain: { thinning: 0.55, smoothing: 0.6, streamline: 0.5 },
    brush: { thinning: 0.85, smoothing: 0.7, streamline: 0.55 },
    highlighter: { thinning: 0, smoothing: 0.5, streamline: 0.4 },
  }[tool];
  const outline = getStroke(pts, {
    size: tool === 'brush' ? s.width * 1.6 : s.width,
    thinning: cfg.thinning,
    smoothing: cfg.smoothing,
    streamline: s.smoothing ?? cfg.streamline,
    simulatePressure: false,
    last: complete,
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
  return p;
}

/** Build a center-line path for dashed or dotted strokes. */
export function centerlinePath(samples: Float32Array): Path2D {
  const p = new Path2D();
  const n = samples.length / SAMPLE_STRIDE;
  if (!n) return p;
  p.moveTo(samples[0], samples[1]);
  for (let i = 1; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    p.lineTo(samples[o], samples[o + 1]);
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
