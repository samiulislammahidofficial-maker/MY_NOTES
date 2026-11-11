import { SAMPLE_STRIDE, type InkStroke } from '../domain/types';
import { strokePath } from '../engine/render';

export interface LineSegment {
  index: number;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  strokes: InkStroke[];
}

/**
 * Group strokes into ordered horizontal lines (top-to-bottom, left-to-right within each line),
 * accounting for vertical overlap so punctuation, ascenders, and descenders stay with their line.
 */
export function segmentStrokesIntoLines(strokes: InkStroke[]): LineSegment[] {
  const eligible = strokes.filter((s) => s.tool !== 'highlighter' && !s.shape);
  if (!eligible.length) return [];

  // Sort by vertical center first
  const items = eligible
    .map((s) => ({
      s,
      cy: (s.bounds.y0 + s.bounds.y1) / 2,
      h: Math.max(4, s.bounds.y1 - s.bounds.y0),
    }))
    .sort((a, b) => a.cy - b.cy);

  const clusters: { y0: number; y1: number; cySum: number; strokes: InkStroke[] }[] = [];
  for (const item of items) {
    const b = item.s.bounds;
    let best: (typeof clusters)[0] | null = null;
    for (const c of clusters) {
      const cCenter = c.cySum / c.strokes.length;
      const cHeight = Math.max(12, c.y1 - c.y0);
      const overlap = Math.min(c.y1, b.y1) - Math.max(c.y0, b.y0);
      if (overlap > -cHeight * 0.25 && Math.abs(item.cy - cCenter) < cHeight * 0.75) {
        best = c;
        break;
      }
    }
    if (best) {
      best.y0 = Math.min(best.y0, b.y0);
      best.y1 = Math.max(best.y1, b.y1);
      best.cySum += item.cy;
      best.strokes.push(item.s);
    } else {
      clusters.push({ y0: b.y0, y1: b.y1, cySum: item.cy, strokes: [item.s] });
    }
  }

  return clusters
    .sort((a, b) => a.y0 - b.y0)
    .map((c, idx) => {
      const sorted = [...c.strokes].sort((a, b) => a.bounds.x0 - b.bounds.x0);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of sorted) {
        x0 = Math.min(x0, s.bounds.x0); y0 = Math.min(y0, s.bounds.y0);
        x1 = Math.max(x1, s.bounds.x1); y1 = Math.max(y1, s.bounds.y1);
      }
      return { index: idx, bounds: { x0, y0, x1, y1 }, strokes: sorted };
    });
}

/**
 * Render a group of strokes into a normalized PNG DataURL:
 * dark ink (#000000) on a clean white (#FFFFFF) background with padding,
 * independent of paper theme, gridlines, or original ink color.
 */
export function rasterizeNormalizedCrop(strokes: InkStroke[], scale = 2, pad = 14): { dataUrl: string; width: number; height: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    x0 = Math.min(x0, s.bounds.x0); y0 = Math.min(y0, s.bounds.y0);
    x1 = Math.max(x1, s.bounds.x1); y1 = Math.max(y1, s.bounds.y1);
  }
  if (!Number.isFinite(x0)) return { dataUrl: '', width: 1, height: 1 };
  const w = Math.min(1600, Math.max(32, Math.ceil((x1 - x0 + pad * 2) * scale)));
  const h = Math.min(800, Math.max(32, Math.ceil((y1 - y0 + pad * 2) * scale)));
  if (typeof document === 'undefined') return { dataUrl: 'data:image/png;base64,', width: w, height: h };

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.scale(scale, scale);
  ctx.translate(-x0 + pad, -y0 + pad);
  ctx.fillStyle = '#000000';
  for (const s of strokes) {
    if (s.tool === 'highlighter') continue;
    ctx.fill(strokePath({ samples: s.samples, width: Math.max(1.6, s.width), tool: s.tool }));
  }
  return { dataUrl: c.toDataURL('image/png'), width: w, height: h };
}

/** Quick geometric character estimate fallback when offline pack is not yet downloaded. */
export function geometricOfflineEstimate(lines: LineSegment[]): string {
  return lines
    .map((line) => {
      let words = 1;
      for (let i = 1; i < line.strokes.length; i++) {
        const gap = line.strokes[i].bounds.x0 - line.strokes[i - 1].bounds.x1;
        if (gap > 16) words++;
      }
      const sampleCount = line.strokes.reduce((acc, s) => acc + s.samples.length / SAMPLE_STRIDE, 0);
      return `[Line ${line.index + 1}: ${line.strokes.length} strokes, ~${words} word${words > 1 ? 's' : ''}, ${sampleCount} pts]`;
    })
    .join('\n');
}
