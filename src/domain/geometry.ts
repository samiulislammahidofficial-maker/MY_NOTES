import type { ViewMatrix } from './types';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Client CSS coords -> document coords, using the canvas bounding rect. */
export function clientToDoc(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  v: ViewMatrix,
): { x: number; y: number } {
  return { x: (clientX - rect.left - v.tx) / v.scale, y: (clientY - rect.top - v.ty) / v.scale };
}

export function docToClient(
  x: number,
  y: number,
  rect: { left: number; top: number },
  v: ViewMatrix,
): { x: number; y: number } {
  return { x: x * v.scale + v.tx + rect.left, y: y * v.scale + v.ty + rect.top };
}

/** Zoom about a fixed screen point (canvas-local CSS px), keeping the doc point under it still. */
export function zoomAbout(v: ViewMatrix, cx: number, cy: number, newScale: number): ViewMatrix {
  const s = clampScale(newScale);
  const dx = (cx - v.tx) / v.scale;
  const dy = (cy - v.ty) / v.scale;
  return { scale: s, tx: cx - dx * s, ty: cy - dy * s };
}

export function fitPage(
  viewW: number,
  viewH: number,
  pageW: number,
  pageH: number,
  margin = 24,
): ViewMatrix {
  const s = clampScale(Math.min((viewW - margin * 2) / pageW, (viewH - margin * 2) / pageH));
  return { scale: s, tx: (viewW - pageW * s) / 2, ty: (viewH - pageH * s) / 2 };
}

/**
 * Default Fit Width view matrix: scales the page to fill the pane width with a modest gutter
 * and positions the top of the page near the top of the pane for natural vertical writing.
 */
export function fitWidth(
  viewW: number,
  _viewH: number,
  pageW: number,
  _pageH: number,
  gutter = 20,
  topMargin = 16,
): ViewMatrix {
  const availW = Math.max(80, viewW - gutter * 2);
  const s = clampScale(availW / Math.max(1, pageW));
  return { scale: s, tx: (viewW - pageW * s) / 2, ty: topMargin };
}
