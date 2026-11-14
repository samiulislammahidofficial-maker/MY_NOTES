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
  streamline?: number;
  ballpointModel?: 'normal' | 'compatibility';
};

const MAX_PATH_CACHE = 2000;
const strokePathCache = new Map<string, Path2D>();
const centerlinePathCache = new Map<string, Path2D>();

const PF_SCALE = 10;

/**
 * Remove sub-pixel micro-duplicates, isolated 1-sample sideways jitter spikes,
 * and tiny pen-down/lift-off backward hooks while keeping dots and sharp corners intact.
 */
export function cleanStrokeSamples(samples: Float32Array, width = 2): Float32Array {
  const rawCount = Math.floor(samples.length / SAMPLE_STRIDE);
  if (rawCount <= 1) return samples;

  // Stage 1: deduplicate sub-0.08pt repeated points while keeping endpoints
  const kept: number[] = [0];
  let lastX = samples[0];
  let lastY = samples[1];
  for (let i = 1; i < rawCount; i++) {
    const o = i * SAMPLE_STRIDE;
    const x = samples[o];
    const y = samples[o + 1];
    const dist = Math.hypot(x - lastX, y - lastY);
    if (dist >= 0.08 || (i === rawCount - 1 && dist >= 0.02)) {
      kept.push(i);
      lastX = x;
      lastY = y;
    }
  }
  if (kept.length <= 2) {
    if (kept.length === rawCount) return samples;
    const out = new Float32Array(kept.length * SAMPLE_STRIDE);
    for (let k = 0; k < kept.length; k++) {
      const src = kept[k] * SAMPLE_STRIDE;
      const dst = k * SAMPLE_STRIDE;
      for (let c = 0; c < SAMPLE_STRIDE; c++) out[dst + c] = samples[src + c];
    }
    return out;
  }

  const getX = (idx: number) => samples[idx * SAMPLE_STRIDE];
  const getY = (idx: number) => samples[idx * SAMPLE_STRIDE + 1];

  // Stage 2: remove isolated 1-sample sideways/needle outlier spikes
  const maxStepLen = Math.max(9.0, width * 4.0);
  const maxPerpSpike = Math.max(4.5, width * 2.2);
  let filtered = kept;
  for (let pass = 0; pass < 2 && filtered.length >= 4; pass++) {
    const next: number[] = [filtered[0]];
    const m = filtered.length;
    for (let i = 1; i < m - 1; i++) {
      const iA = next[next.length - 1];
      const iB = filtered[i];
      const iC = filtered[i + 1];
      const ax = getX(iB) - getX(iA);
      const ay = getY(iB) - getY(iA);
      const bx = getX(iC) - getX(iB);
      const by = getY(iC) - getY(iB);
      const cx = getX(iC) - getX(iA);
      const cy = getY(iC) - getY(iA);
      const d1 = Math.hypot(ax, ay);
      const d2 = Math.hypot(bx, by);
      const chord = Math.hypot(cx, cy);

      if (Math.max(d1, d2) <= maxStepLen && d1 > 1e-4 && d2 > 1e-4) {
        const cosTurn = (ax * bx + ay * by) / (d1 * d2);
        const perpDist = chord > 1e-4 ? Math.abs(ax * cy - ay * cx) / chord : Math.min(d1, d2);

        let cosBypassIn = 0;
        let cosThroughIn = 0;
        if (next.length >= 2) {
          const iPrev = next[next.length - 2];
          const px = getX(iA) - getX(iPrev);
          const py = getY(iA) - getY(iPrev);
          const pl = Math.hypot(px, py);
          if (pl > 1e-4) {
            cosThroughIn = (px * ax + py * ay) / (pl * d1);
            if (chord > 1e-4) cosBypassIn = (px * cx + py * cy) / (pl * chord);
          }
        }

        let cosBypassOut = 0;
        let cosThroughOut = 0;
        if (i + 2 < m) {
          const iNext = filtered[i + 2];
          const nx = getX(iNext) - getX(iC);
          const ny = getY(iNext) - getY(iC);
          const nl = Math.hypot(nx, ny);
          if (nl > 1e-4) {
            cosThroughOut = (bx * nx + by * ny) / (d2 * nl);
            if (chord > 1e-4) cosBypassOut = (cx * nx + cy * ny) / (chord * nl);
          }
        }

        const hasIn = next.length >= 2;
        const hasOut = i + 2 < m;
        const bypassAligns =
          hasIn && hasOut
            ? cosBypassIn + cosBypassOut > cosThroughIn + cosThroughOut + 0.35 &&
              Math.max(cosBypassIn, cosBypassOut) > 0.35
            : hasIn
              ? cosBypassIn > cosThroughIn + 0.35 && cosBypassIn > 0.45
              : hasOut
                ? cosBypassOut > cosThroughOut + 0.35 && cosBypassOut > 0.45
                : false;

        const isNeedleBacktrack = cosTurn < -0.5 && Math.max(d1, d2) <= Math.max(4.0, width * 1.8) && chord < Math.max(d1, d2) * 0.75;
        const isSidewaysSpike =
          perpDist <= maxPerpSpike &&
          ((cosTurn < -0.25 && perpDist > 0.25) || (perpDist > 0.35 && d1 + d2 > chord * 1.15)) &&
          bypassAligns;

        if (isNeedleBacktrack || isSidewaysSpike) {
          continue;
        }
      }
      next.push(iB);
    }
    next.push(filtered[m - 1]);
    if (next.length === filtered.length) break;
    filtered = next;
  }

  // Stage 3: trim short touch-down / lift-off backward hooks (> 117deg reversal)
  const hookLimit = Math.min(4.0, Math.max(2.0, width * 1.4));
  while (filtered.length >= 3) {
    const m = filtered.length;
    const i2 = filtered[m - 3];
    const i1 = filtered[m - 2];
    const i0 = filtered[m - 1];
    const sx = getX(i1) - getX(i2);
    const sy = getY(i1) - getY(i2);
    const tx = getX(i0) - getX(i1);
    const ty = getY(i0) - getY(i1);
    const stemLen = Math.hypot(sx, sy);
    const tailLen = Math.hypot(tx, ty);
    if (
      tailLen <= hookLimit &&
      stemLen >= Math.max(3.5, tailLen * 2.2) &&
      tailLen > 1e-4 &&
      (sx * tx + sy * ty) / (stemLen * tailLen) < -0.45
    ) {
      filtered.pop();
    } else {
      break;
    }
  }
  while (filtered.length >= 3) {
    const i0 = filtered[0];
    const i1 = filtered[1];
    const i2 = filtered[2];
    const hx = getX(i1) - getX(i0);
    const hy = getY(i1) - getY(i0);
    const sx = getX(i2) - getX(i1);
    const sy = getY(i2) - getY(i1);
    const headLen = Math.hypot(hx, hy);
    const stemLen = Math.hypot(sx, sy);
    if (
      headLen <= hookLimit &&
      stemLen >= Math.max(3.5, headLen * 2.2) &&
      headLen > 1e-4 &&
      (hx * sx + hy * sy) / (headLen * stemLen) < -0.45
    ) {
      filtered.shift();
    } else {
      break;
    }
  }

  if (filtered.length === rawCount) return samples;
  const out = new Float32Array(filtered.length * SAMPLE_STRIDE);
  for (let k = 0; k < filtered.length; k++) {
    const src = filtered[k] * SAMPLE_STRIDE;
    const dst = k * SAMPLE_STRIDE;
    for (let c = 0; c < SAMPLE_STRIDE; c++) out[dst + c] = samples[src + c];
  }
  return out;
}

/** Nib behaviour: ballpoint ~constant width; fountain = elliptical chisel; brush = strong pressure curve. */
export function strokePath(s: PathSrc, complete = true): Path2D {
  const tool = s.tool ?? 'ballpoint';
  const effectiveStreamline = s.streamline ?? s.smoothing;
  const cacheKey =
    complete && s.id
      ? `${s.id}:${s.revision ?? 1}:${s.width}:${tool}:${effectiveStreamline ?? ''}:${s.ballpointModel ?? ''}:${s.samples.length}`
      : null;
  if (cacheKey && strokePathCache.has(cacheKey)) {
    return strokePathCache.get(cacheKey)!;
  }
  const cleaned = cleanStrokeSamples(s.samples, s.width);
  const n = cleaned.length / SAMPLE_STRIDE;
  if (n === 0) return new Path2D();

  // Single-point dot or ultra-short tap: render a clean filled disc so dots/i-tittles/punctuation never disappear
  let totalLen = 0;
  for (let i = 1; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    totalLen += Math.hypot(cleaned[o] - cleaned[o - SAMPLE_STRIDE], cleaned[o + 1] - cleaned[o - SAMPLE_STRIDE + 1]);
  }
  if (n === 1 || totalLen < 0.35) {
    const p = new Path2D();
    const r = Math.max(0.5, (s.width * (tool === 'brush' ? 1.1 : 1.0)) / 2);
    p.arc(cleaned[0], cleaned[1], r, 0, Math.PI * 2);
    if (cacheKey) {
      if (strokePathCache.size >= MAX_PATH_CACHE) {
        const oldest = strokePathCache.keys().next().value;
        if (oldest) strokePathCache.delete(oldest);
      }
      strokePathCache.set(cacheKey, p);
    }
    return p;
  }

  let lastFountainFactor = 0.75;
  if (tool === 'fountain') {
    for (let i = 1; i < n; i++) {
      const o = i * SAMPLE_STRIDE;
      const dx = cleaned[o] - cleaned[o - SAMPLE_STRIDE];
      const dy = cleaned[o + 1] - cleaned[o - SAMPLE_STRIDE + 1];
      if (Math.hypot(dx, dy) > 0.15) {
        const ang = Math.atan2(dy, dx);
        lastFountainFactor = 0.5 + 0.5 * Math.abs(Math.sin(ang - Math.PI / 4));
        break;
      }
    }
  }

  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const o = i * SAMPLE_STRIDE;
    let p = Math.max(0.15, Math.min(1, cleaned[o + 2]));
    if (tool === 'ballpoint') {
      // Ballpoint pens have natural physical ink flow with gentle pressure response
      p = 0.5 + 0.5 * p;
    } else if (tool === 'brush') {
      p = 0.25 + 0.75 * Math.pow(p, 1.25);
    } else if (tool === 'fountain') {
      if (i > 0) {
        const dx = cleaned[o] - cleaned[o - SAMPLE_STRIDE];
        const dy = cleaned[o + 1] - cleaned[o - SAMPLE_STRIDE + 1];
        if (Math.hypot(dx, dy) > 0.15) {
          const ang = Math.atan2(dy, dx);
          lastFountainFactor = 0.5 + 0.5 * Math.abs(Math.sin(ang - Math.PI / 4));
        }
      }
      p *= lastFountainFactor;
    }
    pts.push([cleaned[o] * PF_SCALE, cleaned[o + 1] * PF_SCALE, p]);
  }
  const cfg = {
    ballpoint: { thinning: 0.04, smoothing: 0.55, streamline: 0.25 },
    fountain: { thinning: 0.35, smoothing: 0.55, streamline: 0.25 },
    brush: { thinning: 0.6, smoothing: 0.58, streamline: 0.28 },
    highlighter: { thinning: 0, smoothing: 0.5, streamline: 0.2 },
  }[tool];
  const outline = getStroke(pts, {
    size: (tool === 'brush' ? s.width * 1.45 : s.width) * PF_SCALE,
    thinning: cfg.thinning,
    smoothing: cfg.smoothing,
    streamline: effectiveStreamline ?? cfg.streamline,
    simulatePressure: false,
    // Keep last: true for both live and committed so lifting the pen never causes a sudden curve/width jump!
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
  const p = new Path2D();
  if (outline.length < 2) {
    if (pts.length) p.arc(pts[0][0] / PF_SCALE, pts[0][1] / PF_SCALE, s.width / 2, 0, Math.PI * 2);
    return p;
  }
  p.moveTo(outline[0][0] / PF_SCALE, outline[0][1] / PF_SCALE);
  if (outline.length === 2) {
    p.lineTo(outline[1][0] / PF_SCALE, outline[1][1] / PF_SCALE);
  } else {
    for (let i = 1; i < outline.length - 1; i++) {
      const cx = outline[i][0] / PF_SCALE;
      const cy = outline[i][1] / PF_SCALE;
      const nx = outline[i + 1][0] / PF_SCALE;
      const ny = outline[i + 1][1] / PF_SCALE;
      p.quadraticCurveTo(cx, cy, (cx + nx) * 0.5, (cy + ny) * 0.5);
    }
    const lastPt = outline[outline.length - 1];
    p.lineTo(lastPt[0] / PF_SCALE, lastPt[1] / PF_SCALE);
  }
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

/** Build a center-line path for dashed, dotted, or compatibility strokes. */
export function centerlinePath(samples: Float32Array, strokeId?: string, revision?: number): Path2D {
  const key = strokeId ? `${strokeId}:${revision ?? 1}:${samples.length}` : null;
  if (key && centerlinePathCache.has(key)) return centerlinePathCache.get(key)!;
  const p = new Path2D();
  const cleaned = cleanStrokeSamples(samples);
  const n = cleaned.length / SAMPLE_STRIDE;
  if (!n) return p;
  p.moveTo(cleaned[0], cleaned[1]);
  if (n === 1) {
    p.lineTo(cleaned[0] + 0.01, cleaned[1]);
  } else if (n === 2) {
    p.lineTo(cleaned[SAMPLE_STRIDE], cleaned[SAMPLE_STRIDE + 1]);
  } else {
    for (let i = 1; i < n - 1; i++) {
      const prevO = (i - 1) * SAMPLE_STRIDE;
      const o = i * SAMPLE_STRIDE;
      const nextO = (i + 1) * SAMPLE_STRIDE;
      const ax = cleaned[o] - cleaned[prevO];
      const ay = cleaned[o + 1] - cleaned[prevO + 1];
      const bx = cleaned[nextO] - cleaned[o];
      const by = cleaned[nextO + 1] - cleaned[o + 1];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      const cosTurn = la > 1e-4 && lb > 1e-4 ? (ax * bx + ay * by) / (la * lb) : 1;
      if (cosTurn < 0.35) {
        p.lineTo(cleaned[o], cleaned[o + 1]);
      } else {
        p.quadraticCurveTo(
          cleaned[o],
          cleaned[o + 1],
          (cleaned[o] + cleaned[nextO]) * 0.5,
          (cleaned[o + 1] + cleaned[nextO + 1]) * 0.5,
        );
      }
    }
    const lastO = (n - 1) * SAMPLE_STRIDE;
    p.lineTo(cleaned[lastO], cleaned[lastO + 1]);
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
