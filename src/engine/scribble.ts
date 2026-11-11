import { SAMPLE_STRIDE } from '../domain/types';

export interface ScribbleResult {
  isScribble: boolean;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  reversals: number;
}

/**
 * Conservative scribble detector: many sharp direction reversals in a small area,
 * quickly drawn, with a long path relative to its extent. Straight lines, circles,
 * and a single hatch pass are rejected.
 */
export function detectScribble(samples: Float32Array, opts: { maxMs?: number; maxExtent?: number } = {}): ScribbleResult {
  const n = samples.length / SAMPLE_STRIDE;
  const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let len = 0;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = samples[i * SAMPLE_STRIDE], y = samples[i * SAMPLE_STRIDE + 1];
    bbox.x0 = Math.min(bbox.x0, x); bbox.y0 = Math.min(bbox.y0, y); bbox.x1 = Math.max(bbox.x1, x); bbox.y1 = Math.max(bbox.y1, y);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) >= 2) { if (last) len += Math.hypot(x - last.x, y - last.y); pts.push({ x, y }); }
  }
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  const diag = Math.hypot(w, h);
  const ms = n ? samples[(n - 1) * SAMPLE_STRIDE + 5] : 0;
  // count reversals using direction over a short window to ignore jitter
  let reversals = 0;
  let prevDir: { x: number; y: number } | null = null;
  const step = 3;
  for (let i = step; i < pts.length; i += step) {
    const d = { x: pts[i].x - pts[i - step].x, y: pts[i].y - pts[i - step].y };
    const m = Math.hypot(d.x, d.y);
    if (m < 4) continue;
    d.x /= m; d.y /= m;
    if (prevDir && prevDir.x * d.x + prevDir.y * d.y < -0.2) reversals++;
    prevDir = d;
  }
  const ok =
    reversals >= 5 &&
    diag > 8 &&
    diag <= (opts.maxExtent ?? 220) &&
    ms <= (opts.maxMs ?? 3000) &&
    len / Math.max(diag, 1) >= 6;
  return { isScribble: ok, bbox, reversals };
}
