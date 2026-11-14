import type { ViewMatrix } from './types';

export const MIN_SCALE = 0.15;
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
 * Constrains translation and scale to ensure the page remains recoverable and cannot float offscreen.
 * Specifications:
 * - V = available viewport dimension, S = document dimension * view scale, g = gutter.
 * - If S <= V - 2g: center that axis with translation t = (V - S) / 2; disable unnecessary pan along that axis.
 * - If S > V - 2g: clamp translation to [V - g - S, g].
 */
export function constrainView(
  v: ViewMatrix,
  viewW: number,
  viewH: number,
  pageW: number,
  pageH: number,
  gutter = 16,
): ViewMatrix {
  const scale = Number.isFinite(v.scale) && v.scale > 0 ? clampScale(v.scale) : 1;
  const sw = pageW * scale;
  const sh = pageH * scale;

  let tx: number;
  if (sw <= viewW - 2 * gutter) {
    tx = (viewW - sw) / 2;
  } else {
    const minTx = viewW - gutter - sw;
    const maxTx = gutter;
    tx = Math.max(minTx, Math.min(maxTx, v.tx));
  }

  let ty: number;
  if (sh <= viewH - 2 * gutter) {
    ty = (viewH - sh) / 2;
  } else {
    const minTy = viewH - gutter - sh;
    const maxTy = gutter;
    ty = Math.max(minTy, Math.min(maxTy, v.ty));
  }

  return { scale, tx, ty };
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
