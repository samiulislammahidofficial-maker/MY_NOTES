import { SAMPLE_STRIDE, type InkStroke } from '../domain/types';
import { boundsOf } from './render';

export type Pt = { x: number; y: number };

export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Fraction of a stroke's samples inside the lasso polygon. */
export function insideFraction(s: InkStroke, poly: Pt[]): number {
  const n = s.samples.length / SAMPLE_STRIDE;
  if (!n) return 0;
  let c = 0;
  for (let i = 0; i < n; i++) if (pointInPolygon(s.samples[i * SAMPLE_STRIDE], s.samples[i * SAMPLE_STRIDE + 1], poly)) c++;
  return c / n;
}

export function bboxIntersectsPolygonBounds(b: InkStroke['bounds'], poly: Pt[]): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return !(b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1);
}

/** True if any part of the stroke is within r of the point. */
export function strokeHitsCircle(s: InkStroke, cx: number, cy: number, r: number): boolean {
  const R = r + s.width / 2;
  const b = s.bounds;
  if (cx < b.x0 - r || cx > b.x1 + r || cy < b.y0 - r || cy > b.y1 + r) return false;
  const a = s.samples;
  const n = a.length / SAMPLE_STRIDE;
  if (n === 1) return Math.hypot(a[0] - cx, a[1] - cy) <= R;
  for (let i = 0; i < n - 1; i++) {
    const o = i * SAMPLE_STRIDE, q = o + SAMPLE_STRIDE;
    if (segDist(cx, cy, a[o], a[o + 1], a[q], a[q + 1]) <= R) return true;
  }
  return false;
}

/**
 * Remove the part of a stroke inside a circle, returning surviving fragments
 * (each at least 2 samples). Returns null if untouched.
 */
export function eraseCircle(s: InkStroke, cx: number, cy: number, r: number, newId: () => string): InkStroke[] | null {
  if (!strokeHitsCircle(s, cx, cy, r)) return null;
  const R = r + s.width / 2;
  const a = s.samples;
  const n = a.length / SAMPLE_STRIDE;
  const sampleHit = (i: number) => Math.hypot(a[i * SAMPLE_STRIDE] - cx, a[i * SAMPLE_STRIDE + 1] - cy) <= R;
  const segHit = (i: number) => {
    const o = i * SAMPLE_STRIDE, q = o + SAMPLE_STRIDE;
    return segDist(cx, cy, a[o], a[o + 1], a[q], a[q + 1]) <= R;
  };
  const out: InkStroke[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && end - start + 1 >= 2) {
      const samples = a.slice(start * SAMPLE_STRIDE, (end + 1) * SAMPLE_STRIDE);
      out.push({ ...s, id: newId(), samples, bounds: boundsOf(samples, s.width) });
    }
    start = -1;
  };
  for (let i = 0; i < n; i++) {
    if (sampleHit(i)) { flush(i - 1); continue; }
    if (start < 0) start = i;
    if (i < n - 1 && segHit(i)) flush(i);
  }
  flush(n - 1);
  return out;
}

/** Apply x' = x*sx + dx about an anchor, scale uniform. Pressure/tilt/time preserved. */
export function transformStroke(s: InkStroke, scale: number, ax: number, ay: number, dx: number, dy: number, newId?: string): InkStroke {
  const samples = new Float32Array(s.samples);
  for (let i = 0; i < samples.length; i += SAMPLE_STRIDE) {
    samples[i] = ax + (samples[i] - ax) * scale + dx;
    samples[i + 1] = ay + (samples[i + 1] - ay) * scale + dy;
  }
  const width = s.width * scale;
  return { ...s, id: newId ?? s.id, samples, width, bounds: boundsOf(samples, width) };
}

export function unionBounds(list: InkStroke[]): InkStroke['bounds'] | null {
  if (!list.length) return null;
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of list) {
    b.x0 = Math.min(b.x0, s.bounds.x0); b.y0 = Math.min(b.y0, s.bounds.y0);
    b.x1 = Math.max(b.x1, s.bounds.x1); b.y1 = Math.max(b.y1, s.bounds.y1);
  }
  return b;
}

// ---- shapes ----
export function shapePoints(kind: 'line' | 'rect' | 'ellipse', a: Pt, b: Pt, shift = false): Pt[] {
  let { x: x1, y: y1 } = b;
  if (shift && kind !== 'line') {
    const d = Math.max(Math.abs(x1 - a.x), Math.abs(y1 - a.y));
    x1 = a.x + Math.sign(x1 - a.x || 1) * d;
    y1 = a.y + Math.sign(y1 - a.y || 1) * d;
  }
  const lerp = (p: Pt, q: Pt, n: number) => Array.from({ length: n }, (_, i) => ({ x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n }));
  if (kind === 'line') return [...lerp(a, { x: x1, y: y1 }, 24), { x: x1, y: y1 }];
  if (kind === 'rect') {
    const c = [a, { x: x1, y: a.y }, { x: x1, y: y1 }, { x: a.x, y: y1 }, a];
    return [...c.slice(0, 4).flatMap((p, i) => lerp(p, c[i + 1], 16)), a];
  }
  const cx = (a.x + x1) / 2, cy = (a.y + y1) / 2, rx = Math.abs(x1 - a.x) / 2, ry = Math.abs(y1 - a.y) / 2;
  return Array.from({ length: 73 }, (_, i) => ({ x: cx + rx * Math.cos((i / 72) * Math.PI * 2), y: cy + ry * Math.sin((i / 72) * Math.PI * 2) }));
}

/**
 * Draw-and-hold shape snapping fit: evaluates whether raw samples match a line,
 * rectangle, or ellipse with high confidence. Conservative thresholds avoid turning
 * ordinary handwritten loops into circles automatically.
 */
export function fitShape(samples: Float32Array): { shape: 'line' | 'rect' | 'ellipse'; pts: Pt[]; confidence: number } | null {
  const n = samples.length / SAMPLE_STRIDE;
  if (n < 6) return null;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: samples[i * SAMPLE_STRIDE], y: samples[i * SAMPLE_STRIDE + 1] });
  const a = pts[0], b = pts[pts.length - 1];
  let pathLen = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    x0 = Math.min(x0, pts[i].x); y0 = Math.min(y0, pts[i].y);
    x1 = Math.max(x1, pts[i].x); y1 = Math.max(y1, pts[i].y);
    if (i > 0) pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < 20) return null;

  // 1. Line check: chord distance close to path length & low perpendicular deviation
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord / Math.max(pathLen, 1) > 0.94) {
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, segDist(p.x, p.y, a.x, a.y, b.x, b.y));
    if (maxDev / chord < 0.06) {
      return { shape: 'line', pts: shapePoints('line', a, b), confidence: 1 - maxDev / chord };
    }
  }

  // Closed shape check: endpoints must be reasonably close relative to perimeter
  const endGap = Math.hypot(b.x - a.x, b.y - a.y);
  if (endGap > diag * 0.35 || w < 14 || h < 14) return null;

  // Compare RMS error to rectangle vs ellipse
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = w / 2, ry = h / 2;
  let errRect = 0, errEllipse = 0;
  for (const p of pts) {
    const dRect = Math.min(Math.abs(p.x - x0), Math.abs(p.x - x1), Math.abs(p.y - y0), Math.abs(p.y - y1));
    errRect += dRect * dRect;
    const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry;
    const r = Math.hypot(nx, ny);
    const dEll = Math.abs(r - 1) * Math.min(rx, ry);
    errEllipse += dEll * dEll;
  }
  const rmsRect = Math.sqrt(errRect / pts.length) / diag;
  const rmsEll = Math.sqrt(errEllipse / pts.length) / diag;

  if (rmsRect < 0.055 && rmsRect < rmsEll * 0.9) {
    return { shape: 'rect', pts: shapePoints('rect', { x: x0, y: y0 }, { x: x1, y: y1 }), confidence: 1 - rmsRect * 10 };
  }
  if (rmsEll < 0.065) {
    return { shape: 'ellipse', pts: shapePoints('ellipse', { x: x0, y: y0 }, { x: x1, y: y1 }), confidence: 1 - rmsEll * 10 };
  }
  return null;
}

/** Project point onto a ruler line (point p0, angle rad) if within snap distance. */
export function snapToRuler(p: Pt, rx: number, ry: number, angleRad: number, snapDist = 18): Pt {
  const dx = Math.cos(angleRad), dy = Math.sin(angleRad);
  const vx = p.x - rx, vy = p.y - ry;
  const perp = -vx * dy + vy * dx;
  if (Math.abs(perp) > snapDist) return p;
  const along = vx * dx + vy * dy;
  const edgeOffset = perp >= 0 ? 10 : -10;
  return { x: rx + along * dx - edgeOffset * dy, y: ry + along * dy + edgeOffset * dx };
}
