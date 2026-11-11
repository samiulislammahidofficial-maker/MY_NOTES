import type { InkStroke, Page, Template, TextBox, ViewMatrix } from '../domain/types';
import { SAMPLE_STRIDE, isDark } from '../domain/types';
import { clientToDoc, fitPage, zoomAbout } from '../domain/geometry';
import { SampleBuffer, arbitrate, expandEvents, resolvePressure } from './input';
import { applyView, boundsOf, centerlinePath, createRainbowStyle, strokePath } from './render';
import { getScannedImageElement, renderPdfPageBackground } from '../pdf/pdfManager';
import {
  type Pt,
  bboxIntersectsPolygonBounds,
  eraseCircle,
  fitShape,
  insideFraction,
  shapePoints,
  snapToRuler,
  strokeHitsCircle,
  transformStroke,
  unionBounds,
} from './hit';
import { detectScribble } from './scribble';
import type { LayerInfo, PaperSpec, SelectionInfo, ToolSettings } from './tools';

export type { ToolSettings } from './tools';

export interface SurfaceOptions {
  getTool(): ToolSettings;
  getPaper(): PaperSpec;
  getLayers(): LayerInfo[];
  activeLayerId(): string | undefined;
  onStroke(s: InkStroke): void;
  onEdit(label: string, remove: InkStroke[], add: InkStroke[]): void;
  onActivate?(): void;
  onSelection?(s: SelectionInfo | null): void;
  onCopy?(strokes: InkStroke[]): void;
  /** Optional source rectangle in document coordinates (when magnified window is open). */
  getZoomRect?(): { x: number; y: number; w: number; h: number } | null;
  /** If true, this surface is a fixed magnified viewport without auto-fit. */
  disableAutoFit?: boolean;
  getTexts?(): TextBox[];
  onCanvasTap?(docPt: { x: number; y: number }): void;
}

type Mode = 'ink' | 'erase' | 'lasso' | 'shape' | 'pan' | 'laser';

interface Selection {
  ids: Set<string>;
  strokes: InkStroke[];
  t: { scale: number; dx: number; dy: number; ax: number; ay: number };
}

const ID_T = { scale: 1, dx: 0, dy: 0, ax: 0, ay: 0 };

export class InkSurface {
  readonly scene = document.createElement('canvas');
  readonly live = document.createElement('canvas');
  private sctx = this.scene.getContext('2d')!;
  private lctx = this.live.getContext('2d')!;
  private ro: ResizeObserver;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private view: ViewMatrix = { scale: 1, tx: 0, ty: 0 };
  private page: Page | null = null;
  private strokes: InkStroke[] = [];
  private raf = 0;
  private sceneDirty = true;
  private liveDirty = false;

  // input state
  private touches = new Map<number, { x: number; y: number }>();
  private activeId: number | null = null;
  private activeType = '';
  private mode: Mode = 'ink';
  private buf: SampleBuffer | null = null;
  private t0 = 0;
  private penDown = false;
  private lastPenUp = -1e9;
  private completed = new Set<number>();
  private navLast: { cx: number; cy: number; d: number } | null = null;
  private fitted = false;
  private frameMs: number[] = [];
  private hasCoalesced = typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype;

  // tool sessions
  private panLast: { x: number; y: number } | null = null;
  private lasso: Pt[] = [];
  private sel: Selection | null = null;
  private drag: { kind: 'move' | 'scale'; start: Pt; ax: number; ay: number; d0: number } | null = null;
  private lastSelKey = '';
  private eraseTouched = new Map<string, InkStroke>();
  private eraseFrag = new Set<string>();
  private eraseAt: Pt | null = null;
  private shapeA: Pt | null = null;
  private shapeB: Pt | null = null;
  private laserPts: { x: number; y: number; t: number }[] = [];
  private holdTimer = 0;
  private snappedShape: { shape: 'line' | 'rect' | 'ellipse'; pts: Pt[] } | null = null;
  private liveSeed = 0;
  private ruler = { x: 297, y: 420, angle: 0 };
  private rulerDrag: { kind: 'move' | 'rotate'; startX: number; startY: number; rx: number; ry: number; a0: number } | null = null;
  private bgCanvas: HTMLCanvasElement | HTMLImageElement | null = null;
  private bgPageKey = '';

  constructor(private host: HTMLElement, private opts: SurfaceOptions) {
    for (const c of [this.scene, this.live]) {
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
      host.appendChild(c);
    }
    // touch-action:none ONLY on the drawing surface
    this.live.style.touchAction = 'none';
    this.live.addEventListener('pointerdown', this.onDown);
    this.live.addEventListener('pointermove', this.onMove);
    this.live.addEventListener('pointerup', this.onUp);
    this.live.addEventListener('pointercancel', this.onCancel);
    this.live.addEventListener('lostpointercapture', this.onCancel);
    this.live.addEventListener('wheel', this.onWheel, { passive: false });
    this.live.addEventListener('contextmenu', (e) => e.preventDefault());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  destroy() {
    clearTimeout(this.holdTimer);
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.host.replaceChildren();
  }

  getView() {
    return this.view;
  }
  getStats() {
    const a = [...this.frameMs].sort((x, y) => x - y);
    return {
      coalescedSupported: this.hasCoalesced,
      frames: a.length,
      p95Ms: a.length ? a[Math.floor(a.length * 0.95)] : 0,
      dpr: this.dpr,
      strokes: this.strokes.length,
    };
  }

  setPage(page: Page, strokes: InkStroke[]) {
    const changed = this.page?.id !== page.id;
    this.page = page;
    this.strokes = strokes;
    if (changed) {
      this.fitted = false;
      this.clearSelection();
      this.loadPageBackground(page);
    }
    this.maybeFit();
    this.invalidate();
  }

  private loadPageBackground(page: Page) {
    const key = `${page.id}:${page.pdfAssetId ?? ''}:${page.pdfPageIndex ?? ''}:${page.imageAssetId ?? ''}`;
    if (key === this.bgPageKey) return;
    this.bgPageKey = key;
    this.bgCanvas = null;
    if (page.pdfAssetId && page.pdfPageIndex) {
      renderPdfPageBackground(page.pdfAssetId, page.pdfPageIndex, 1.5).then((bmp) => {
        if (this.bgPageKey === key && bmp) {
          this.bgCanvas = bmp;
          this.invalidate();
        }
      }).catch(() => {});
    } else if (page.imageAssetId) {
      getScannedImageElement(page.imageAssetId).then((img) => {
        if (this.bgPageKey === key && img) {
          this.bgCanvas = img;
          this.invalidate();
        }
      }).catch(() => {});
    }
  }
  setStrokes(strokes: InkStroke[]) {
    this.strokes = strokes;
    if (this.sel) {
      const live = new Set(strokes.map((s) => s.id));
      this.sel.strokes = this.sel.strokes.filter((s) => live.has(s.id));
      this.sel.ids = new Set(this.sel.strokes.map((s) => s.id));
      if (!this.sel.strokes.length) this.clearSelection();
    }
    this.invalidate();
  }
  setView(v: ViewMatrix) {
    this.view = v;
    this.invalidate();
  }
  fit() {
    if (!this.page) return;
    this.view = fitPage(this.cssW, this.cssH, this.page.width, this.page.height);
    this.invalidate();
  }
  invalidate() {
    this.sceneDirty = true;
    this.liveDirty = true;
    this.schedule();
  }

  private maybeFit() {
    if (this.opts.disableAutoFit) return;
    if (!this.fitted && this.page && this.cssW > 8) {
      this.fit();
      this.fitted = true;
    }
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const oldW = this.cssW;
    const oldH = this.cssH;
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.scene, this.live]) {
      c.width = Math.round(this.cssW * this.dpr);
      c.height = Math.round(this.cssH * this.dpr);
    }
    if (this.fitted && oldW > 8) {
      this.view = { ...this.view, tx: this.view.tx + (this.cssW - oldW) / 2, ty: this.view.ty + (this.cssH - oldH) / 2 };
    }
    this.maybeFit();
    this.invalidate();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    const t = performance.now();
    if (this.laserPts.length) {
      this.laserPts = this.laserPts.filter((p) => t - p.t < 900);
      this.liveDirty = true;
      if (this.laserPts.length) this.schedule();
    }
    if (this.sceneDirty) {
      this.drawScene();
      this.sceneDirty = false;
    }
    if (this.liveDirty) {
      this.drawLive();
      this.liveDirty = false;
    }
    this.frameMs.push(performance.now() - t);
    if (this.frameMs.length > 300) this.frameMs.shift();
  };

  // ---------- layers / eligibility ----------
  private layerMap() {
    const m = new Map<string, LayerInfo & { order: number }>();
    this.opts.getLayers().forEach((l, i) => m.set(l.id, { ...l, order: i }));
    return m;
  }
  private editable(s: InkStroke, lm = this.layerMap()) {
    const l = lm.get(s.layerId);
    return !l || (l.visible && !l.locked);
  }

  // ---------- drawing ----------
  private drawTemplate(ctx: CanvasRenderingContext2D, tpl: Template, dark: boolean) {
    if (tpl === 'blank' || !this.page) return;
    const { width: w, height: h } = this.page;
    const gap = 28;
    ctx.strokeStyle = dark ? '#ffffff26' : '#00000026';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    if (tpl === 'ruled') {
      for (let y = 56; y < h; y += gap) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    } else if (tpl === 'grid') {
      for (let y = gap; y < h; y += gap) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      for (let x = gap; x < w; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    } else {
      for (let y = gap; y < h; y += gap) for (let x = gap; x < w; x += gap) { ctx.moveTo(x + 1, y); ctx.arc(x, y, 1, 0, Math.PI * 2); }
      ctx.fill();
    }
    ctx.stroke();
  }

  private paintStroke(ctx: CanvasRenderingContext2D, s: InkStroke, layerOpacity: number, dark: boolean) {
    ctx.globalAlpha = s.opacity * layerOpacity;
    const style = s.rainbowSeed !== undefined ? createRainbowStyle(ctx, s.samples, s.rainbowSeed, s.color) : s.color;
    // highlighter: one filled outline composited once -> no self-overlap blotches
    ctx.globalCompositeOperation = s.tool === 'highlighter' ? (dark ? 'screen' : 'multiply') : 'source-over';
    if (s.strokeStyle && s.strokeStyle !== 'solid' && s.tool !== 'highlighter') {
      ctx.strokeStyle = style;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const w = Math.max(1.5, s.width);
      ctx.setLineDash(s.strokeStyle === 'dashed' ? [w * 3, w * 2.2] : [w * 0.2, w * 2.2]);
      ctx.stroke(centerlinePath(s.samples));
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = style;
      ctx.fill(strokePath(s));
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawScene() {
    const ctx = this.sctx;
    const spec = this.opts.getPaper();
    const dark = isDark(spec.color);
    const paper = { page: spec.color, back: dark ? '#0d0d0d' : '#3a3a3a', line: dark ? '#2a2a2a' : '#c8c8c8' };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = paper.back;
    ctx.fillRect(0, 0, this.scene.width, this.scene.height);
    if (!this.page) return;
    applyView(ctx, this.view, this.dpr);
    ctx.fillStyle = paper.page;
    ctx.fillRect(0, 0, this.page.width, this.page.height);
    if (this.bgCanvas) {
      ctx.drawImage(this.bgCanvas, 0, 0, this.page.width, this.page.height);
    }
    this.drawTemplate(ctx, spec.template, dark);
    ctx.strokeStyle = paper.line;
    ctx.lineWidth = 1 / this.view.scale;
    ctx.strokeRect(0, 0, this.page.width, this.page.height);
    const lm = this.layerMap();
    const vx0 = -this.view.tx / this.view.scale;
    const vy0 = -this.view.ty / this.view.scale;
    const vx1 = vx0 + this.cssW / this.view.scale;
    const vy1 = vy0 + this.cssH / this.view.scale;
    const ordered = [...this.strokes].sort((a, b) => (lm.get(a.layerId)?.order ?? 0) - (lm.get(b.layerId)?.order ?? 0) || a.order - b.order);
    const t = this.sel?.t;
    for (const s of ordered) {
      const l = lm.get(s.layerId);
      if (l && !l.visible) continue;
      const inSel = this.sel?.ids.has(s.id);
      const b = s.bounds;
      if (!inSel && (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1)) continue;
      if (inSel && t && (t.scale !== 1 || t.dx || t.dy)) {
        ctx.save();
        ctx.translate(t.ax + t.dx, t.ay + t.dy);
        ctx.scale(t.scale, t.scale);
        ctx.translate(-t.ax, -t.ay);
        this.paintStroke(ctx, s, l?.opacity ?? 1, dark);
        ctx.restore();
      } else this.paintStroke(ctx, s, l?.opacity ?? 1, dark);
    }
    const texts = this.opts.getTexts?.() ?? [];
    for (const tb of texts) {
      const l = lm.get(tb.layerId);
      if (l && !l.visible) continue;
      ctx.globalAlpha = l?.opacity ?? 1;
      ctx.fillStyle = tb.color;
      ctx.font = `${tb.fontSize}px ${tb.fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = tb.align;
      const lines = tb.text.split('\n');
      const lh = tb.fontSize * (tb.lineHeight || 1.3);
      const ax = tb.align === 'center' ? (tb.bounds.x0 + tb.bounds.x1) / 2 : tb.align === 'right' ? tb.bounds.x1 : tb.bounds.x0;
      lines.forEach((line, idx) => {
        ctx.fillText(line, ax, tb.bounds.y0 + idx * lh);
      });
    }
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  private selBounds() {
    if (!this.sel) return null;
    const b = unionBounds(this.sel.strokes);
    if (!b) return null;
    const { scale, dx, dy, ax, ay } = this.sel.t;
    const f = (x: number, y: number) => ({ x: ax + (x - ax) * scale + dx, y: ay + (y - ay) * scale + dy });
    const p0 = f(b.x0, b.y0), p1 = f(b.x1, b.y1);
    return { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
  }

  private emitSelection() {
    const b = this.selBounds();
    if (!b || !this.sel) {
      if (this.lastSelKey !== '') { this.lastSelKey = ''; this.opts.onSelection?.(null); }
      return;
    }
    const v = this.view;
    const rect = { x: b.x0 * v.scale + v.tx, y: b.y0 * v.scale + v.ty, w: (b.x1 - b.x0) * v.scale, h: (b.y1 - b.y0) * v.scale };
    const key = `${this.sel.strokes.length}:${rect.x | 0}:${rect.y | 0}:${rect.w | 0}:${rect.h | 0}`;
    if (key !== this.lastSelKey) { this.lastSelKey = key; this.opts.onSelection?.({ count: this.sel.strokes.length, rect }); }
  }

  private drawLive() {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    applyView(ctx, this.view, this.dpr);
    const tool = this.opts.getTool();
    const sc = this.view.scale;
    if (this.mode === 'ink' && this.buf && this.buf.length) {
      if (this.snappedShape) {
        ctx.strokeStyle = tool.rainbow ? '#30D158' : tool.color;
        ctx.lineWidth = tool.width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        this.snappedShape.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else {
        const hl = tool.kind === 'highlighter';
        const sub = this.buf.data.subarray(0, this.buf.length * SAMPLE_STRIDE);
        const w = hl ? tool.hlWidth : tool.width;
        const style = !hl && tool.rainbow ? createRainbowStyle(ctx, sub, this.liveSeed, tool.color) : hl ? tool.hlColor : tool.color;
        ctx.globalAlpha = hl ? tool.hlOpacity : tool.opacity;
        if (!hl && tool.strokeStyle !== 'solid') {
          ctx.strokeStyle = style;
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          const u = Math.max(1.5, w);
          ctx.setLineDash(tool.strokeStyle === 'dashed' ? [u * 3, u * 2.2] : [u * 0.2, u * 2.2]);
          ctx.stroke(centerlinePath(sub));
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = style;
          ctx.fill(strokePath({ samples: sub, width: w, tool: hl ? 'highlighter' : tool.nib, smoothing: this.smoothing(tool) }, false));
        }
        ctx.globalAlpha = 1;
      }
    }
    if (this.mode === 'shape' && this.shapeA && this.shapeB) {
      ctx.strokeStyle = tool.color;
      ctx.lineWidth = tool.width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      shapePoints(tool.shape, this.shapeA, this.shapeB).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    if (this.mode === 'erase' && this.eraseAt) {
      ctx.strokeStyle = '#ffffffcc';
      ctx.lineWidth = 1.5 / sc;
      ctx.beginPath();
      ctx.arc(this.eraseAt.x, this.eraseAt.y, tool.eraserRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.lasso.length > 1) {
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1.5 / sc;
      ctx.setLineDash([6 / sc, 4 / sc]);
      ctx.beginPath();
      this.lasso.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const sb = this.selBounds();
    if (sb) {
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1.5 / sc;
      ctx.strokeRect(sb.x0, sb.y0, sb.x1 - sb.x0, sb.y1 - sb.y0);
      ctx.fillStyle = '#fff';
      const hs = 6 / sc;
      for (const [x, y] of [[sb.x0, sb.y0], [sb.x1, sb.y0], [sb.x0, sb.y1], [sb.x1, sb.y1]]) {
        ctx.beginPath();
        ctx.arc(x, y, hs, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (this.laserPts.length > 1) {
      const now = performance.now();
      ctx.lineCap = 'round';
      for (let i = 1; i < this.laserPts.length; i++) {
        const a = this.laserPts[i - 1], b = this.laserPts[i];
        ctx.globalAlpha = Math.max(0, 1 - (now - b.t) / 900);
        ctx.strokeStyle = '#ff3b30';
        ctx.lineWidth = 5 / sc;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (tool.rulerVisible && !this.opts.disableAutoFit) {
      ctx.save();
      ctx.translate(this.ruler.x, this.ruler.y);
      ctx.rotate(this.ruler.angle);
      ctx.fillStyle = '#ffffff26';
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1.5 / sc;
      ctx.fillRect(-160, -10, 320, 20);
      ctx.strokeRect(-160, -10, 320, 20);
      ctx.fillStyle = '#ffffffaa';
      ctx.font = `${10 / sc}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round((this.ruler.angle * 180) / Math.PI)}°`, 0, 4 / sc);
      ctx.restore();
    }
    const zr = this.opts.getZoomRect?.();
    if (zr && !this.opts.disableAutoFit) {
      ctx.strokeStyle = '#0a84ff';
      ctx.fillStyle = '#0a84ff14';
      ctx.lineWidth = 2 / sc;
      ctx.fillRect(zr.x, zr.y, zr.w, zr.h);
      ctx.strokeRect(zr.x, zr.y, zr.w, zr.h);
    }
    this.emitSelection();
  }

  private smoothing(tool: ToolSettings) {
    return 0.15 + tool.stabilizer * 0.75;
  }

  // ---------- selection API ----------
  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.drag = null;
    this.invalidate();
  }

  private applyEdit(label: string, remove: InkStroke[], add: InkStroke[]) {
    const rm = new Set(remove.map((s) => s.id));
    this.strokes = [...this.strokes.filter((s) => !rm.has(s.id)), ...add];
    this.opts.onEdit(label, remove, add);
    this.invalidate();
  }

  selectionAction(a: 'delete' | 'duplicate' | 'cut' | 'copy'): InkStroke[] {
    if (!this.sel || !this.page) return [];
    const cur = this.sel.strokes;
    if (a === 'copy') { this.opts.onCopy?.(cur); return cur; }
    if (a === 'cut') {
      this.opts.onCopy?.(cur);
      this.applyEdit('Cut', cur, []);
      this.clearSelection();
      return cur;
    }
    if (a === 'delete') {
      this.applyEdit('Delete', cur, []);
      this.clearSelection();
      return cur;
    }
    const copies = cur.map((s) => transformStroke(s, 1, 0, 0, 24, 24, crypto.randomUUID()));
    this.applyEdit('Duplicate', [], copies);
    this.select(copies);
    return cur;
  }

  getSelectedStrokes(): InkStroke[] {
    return this.sel?.strokes ?? [];
  }

  paste(list: InkStroke[]) {
    if (!this.page || !list.length) return;
    const layer = this.opts.activeLayerId() ?? this.page.layerIds[0];
    const pageId = this.page.id;
    const copies = list.map((s) => ({ ...transformStroke(s, 1, 0, 0, 24, 24, crypto.randomUUID()), pageId, layerId: layer }));
    this.applyEdit('Paste', [], copies);
    this.select(copies);
  }

  private select(list: InkStroke[]) {
    this.sel = list.length ? { ids: new Set(list.map((s) => s.id)), strokes: list, t: { ...ID_T } } : null;
    this.invalidate();
  }

  // ---------- input ----------
  private rect() {
    return this.live.getBoundingClientRect();
  }
  private doc(e: { clientX: number; clientY: number }): Pt {
    return clientToDoc(e.clientX, e.clientY, this.rect(), this.view);
  }

  private modeFor(tool: ToolSettings): Mode {
    switch (tool.kind) {
      case 'eraser': return 'erase';
      case 'lasso': return 'lasso';
      case 'shape': return 'shape';
      case 'hand': return 'pan';
      case 'laser': return 'laser';
      default: return 'ink';
    }
  }

  private onDown = (e: PointerEvent) => {
    this.opts.onActivate?.();
    if (e.pointerType === 'touch') this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const tool = this.opts.getTool();
    const mode = this.modeFor(tool);
    let action = arbitrate(e.pointerType, {
      penOnly: tool.penOnly,
      fingerDrawing: tool.fingerDrawing,
      penDown: this.penDown,
      sincePenUp: performance.now() - this.lastPenUp,
      guardMs: 250,
      touchCount: this.touches.size,
    });
    if (mode === 'pan' && e.pointerType === 'touch' && this.touches.size === 1 && !this.penDown) action = 'ink';
    if (e.pointerType === 'touch' && this.touches.size >= 2) {
      this.cancelSession();
      this.beginNav();
      return;
    }
    if (action !== 'ink' || this.activeId !== null) return;
    e.preventDefault();
    try { this.live.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.activeId = e.pointerId;
    this.activeType = e.pointerType;
    this.mode = mode;
    if (e.pointerType === 'pen') this.penDown = true;
    const d = this.doc(e);
    if (tool.rulerVisible && !this.opts.disableAutoFit) {
      const dx = Math.cos(this.ruler.angle), dy = Math.sin(this.ruler.angle);
      const vx = d.x - this.ruler.x, vy = d.y - this.ruler.y;
      const along = vx * dx + vy * dy, perp = -vx * dy + vy * dx;
      if (Math.abs(along) <= 160 && Math.abs(perp) <= 10) {
        this.rulerDrag = {
          kind: Math.abs(along) > 120 ? 'rotate' : 'move',
          startX: d.x, startY: d.y, rx: this.ruler.x, ry: this.ruler.y, a0: Math.atan2(vy, vx) - this.ruler.angle,
        };
        return;
      }
    }
    if (mode !== 'lasso' && this.sel) this.clearSelection();
    if (tool.kind === 'text') {
      this.activeId = null;
      this.penDown = false;
      this.opts.onCanvasTap?.(d);
      return;
    }
    switch (mode) {
      case 'ink':
        this.buf = new SampleBuffer();
        this.snappedShape = null;
        this.liveSeed = (Date.now() * 137) % 360;
        this.t0 = e.timeStamp;
        this.addSamples([e]);
        break;
      case 'pan':
        this.panLast = { x: e.clientX, y: e.clientY };
        break;
      case 'erase':
        this.eraseTouched.clear();
        this.eraseFrag.clear();
        this.eraseAt = d;
        this.eraseHit(d, tool);
        break;
      case 'shape':
        this.shapeA = d;
        this.shapeB = d;
        break;
      case 'laser':
        this.laserPts = [{ ...d, t: performance.now() }];
        this.schedule();
        break;
      case 'lasso':
        this.lassoDown(d);
        break;
    }
  };

  private addSamples(evs: PointerEvent[]) {
    if (!this.buf) return;
    const tool = this.opts.getTool();
    const r = this.rect();
    for (const ev of evs) {
      let d = clientToDoc(ev.clientX, ev.clientY, r, this.view);
      if (tool.rulerVisible) d = snapToRuler(d, this.ruler.x, this.ruler.y, this.ruler.angle);
      const p = resolvePressure(ev.pointerType, ev.pressure, tool.constantPressure);
      this.buf.push(d.x, d.y, p, ev.tiltX || 0, ev.tiltY || 0, ev.timeStamp - this.t0);
    }
    clearTimeout(this.holdTimer);
    if (this.snappedShape && evs.length) {
      const last = clientToDoc(evs[evs.length - 1].clientX, evs[evs.length - 1].clientY, r, this.view);
      const o = (this.buf.length - 1) * SAMPLE_STRIDE;
      if (Math.hypot(last.x - this.buf.data[o], last.y - this.buf.data[o + 1]) > 8) this.snappedShape = null;
    }
    if (tool.kind === 'pen' && tool.shapeSnap && !tool.rulerVisible && !this.snappedShape && this.buf.length >= 8) {
      this.holdTimer = window.setTimeout(() => {
        if (!this.buf || this.activeId === null) return;
        const fit = fitShape(this.buf.toArray());
        if (fit) {
          this.snappedShape = fit;
          this.liveDirty = true;
          this.schedule();
        }
      }, 420);
    }
    this.liveDirty = true;
    this.schedule();
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.navLast && this.touches.size >= 2) {
        this.updateNav();
        return;
      }
    }
    if (e.pointerId !== this.activeId) return;
    if (this.rulerDrag) {
      const d = this.doc(e);
      if (this.rulerDrag.kind === 'move') {
        this.ruler.x = this.rulerDrag.rx + (d.x - this.rulerDrag.startX);
        this.ruler.y = this.rulerDrag.ry + (d.y - this.rulerDrag.startY);
      } else {
        this.ruler.angle = Math.atan2(d.y - this.ruler.y, d.x - this.ruler.x) - this.rulerDrag.a0;
      }
      this.liveDirty = true;
      this.schedule();
      return;
    }
    const tool = this.opts.getTool();
    const evs = expandEvents(e);
    switch (this.mode) {
      case 'ink':
        this.addSamples(evs);
        break;
      case 'pan':
        if (this.panLast) {
          this.view = { ...this.view, tx: this.view.tx + e.clientX - this.panLast.x, ty: this.view.ty + e.clientY - this.panLast.y };
          this.panLast = { x: e.clientX, y: e.clientY };
          this.invalidate();
        }
        break;
      case 'erase':
        for (const ev of evs) {
          const d = this.doc(ev);
          this.eraseAt = d;
          this.eraseHit(d, tool);
        }
        this.liveDirty = true;
        this.schedule();
        break;
      case 'shape':
        this.shapeB = this.doc(e);
        this.liveDirty = true;
        this.schedule();
        break;
      case 'laser':
        for (const ev of evs) this.laserPts.push({ ...this.doc(ev), t: performance.now() });
        this.schedule();
        break;
      case 'lasso':
        this.lassoMove(this.doc(e), e);
        break;
    }
  };

  private onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.navLast = null;
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.lastPenUp = performance.now();
    }
    if (e.pointerId !== this.activeId) return;
    if (this.completed.has(e.pointerId)) return; // complete exactly once
    this.completed.add(e.pointerId);
    if (this.completed.size > 64) this.completed.clear();
    const mode = this.mode;
    this.activeId = null;
    clearTimeout(this.holdTimer);
    if (this.rulerDrag) {
      this.rulerDrag = null;
      this.liveDirty = true;
      this.schedule();
      return;
    }
    switch (mode) {
      case 'ink': this.finishInk(); break;
      case 'erase': this.finishErase(); break;
      case 'shape': this.finishShape(e); break;
      case 'lasso': this.finishLasso(); break;
      case 'pan': this.panLast = null; break;
      case 'laser': break;
    }
    this.liveDirty = true;
    this.schedule();
  };

  private onCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.navLast = null;
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.lastPenUp = performance.now();
    }
    if (e.pointerId === this.activeId) this.cancelSession();
  };

  /** Discard an incomplete gesture; committed content is preserved. */
  private cancelSession() {
    if (this.activeId === null) return;
    if (this.mode === 'erase' && this.eraseTouched.size) {
      // roll back the local, uncommitted erasure to the originals
      this.strokes = [...this.strokes.filter((s) => !this.eraseFrag.has(s.id)), ...this.eraseTouched.values()];
      this.eraseTouched.clear();
      this.eraseFrag.clear();
    }
    if (this.drag && this.sel) this.sel.t = { ...ID_T };
    clearTimeout(this.holdTimer);
    this.snappedShape = null;
    this.rulerDrag = null;
    this.activeId = null;
    this.buf = null;
    this.eraseAt = null;
    this.shapeA = this.shapeB = null;
    this.lasso = [];
    this.drag = null;
    this.panLast = null;
    this.invalidate();
  }

  // ---------- ink ----------
  private finishInk() {
    const buf = this.buf;
    const type = this.activeType;
    const snap = this.snappedShape;
    this.buf = null;
    this.snappedShape = null;
    if (!buf || !this.page || buf.length === 0) return;
    const tool = this.opts.getTool();
    const hl = tool.kind === 'highlighter';
    const width = hl ? tool.hlWidth : tool.width;
    if (snap && !hl) {
      const samples = new Float32Array(snap.pts.length * SAMPLE_STRIDE);
      snap.pts.forEach((p, i) => samples.set([p.x, p.y, 0.5, 0, 0, i], i * SAMPLE_STRIDE));
      this.opts.onStroke({
        kind: 'stroke', id: crypto.randomUUID(), pageId: this.page.id, layerId: this.opts.activeLayerId() ?? this.page.layerIds[0],
        tool: 'ballpoint', shape: snap.shape, color: tool.color, rainbowSeed: tool.rainbow ? this.liveSeed : undefined,
        width, opacity: tool.opacity, samples, bounds: boundsOf(samples, width), order: Date.now(), revision: 1,
      });
      return;
    }
    const samples = buf.toArray();
    if (type === 'pen') {
      const o = (buf.length - 1) * SAMPLE_STRIDE + 2;
      if (samples[o] <= 0) samples[o] = 0.05;
    }
    // scribble-to-erase: recognise before committing; fall back to ink when uncertain
    if (tool.kind === 'pen' && tool.scribbleErase) {
      const sc = detectScribble(samples);
      if (sc.isScribble) {
        const lm = this.layerMap();
        const hit = this.strokes.filter((s) => this.editable(s, lm) && this.strokeNear(s, sc.bbox, 6));
        if (hit.length) return this.applyEdit('Scribble erase', hit, []);
      }
    }
    this.opts.onStroke({
      kind: 'stroke',
      id: crypto.randomUUID(),
      pageId: this.page.id,
      layerId: this.opts.activeLayerId() ?? this.page.layerIds[0],
      tool: hl ? 'highlighter' : tool.nib,
      strokeStyle: hl ? 'solid' : tool.strokeStyle,
      color: hl ? tool.hlColor : tool.color,
      rainbowSeed: !hl && tool.rainbow ? this.liveSeed : undefined,
      width,
      opacity: hl ? tool.hlOpacity : tool.opacity,
      samples,
      bounds: boundsOf(samples, width),
      order: Date.now(),
      revision: 1,
    });
  }

  private strokeNear(s: InkStroke, b: { x0: number; y0: number; x1: number; y1: number }, pad: number) {
    for (let i = 0; i < s.samples.length; i += SAMPLE_STRIDE) {
      const x = s.samples[i], y = s.samples[i + 1];
      if (x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) return true;
    }
    return false;
  }

  // ---------- eraser ----------
  private eraseHit(c: Pt, tool: ToolSettings) {
    const lm = this.layerMap();
    const r = tool.eraserRadius;
    let changed = false;
    const next: InkStroke[] = [];
    for (const s of this.strokes) {
      if (!this.editable(s, lm) || !strokeHitsCircle(s, c.x, c.y, r)) { next.push(s); continue; }
      const frags = tool.eraserMode === 'pixel' ? eraseCircle(s, c.x, c.y, r, () => crypto.randomUUID()) : [];
      if (frags === null) { next.push(s); continue; }
      if (!this.eraseFrag.has(s.id)) this.eraseTouched.set(s.id, s);
      else this.eraseFrag.delete(s.id);
      for (const f of frags) { this.eraseFrag.add(f.id); next.push(f); }
      changed = true;
    }
    if (changed) {
      this.strokes = next;
      this.sceneDirty = true;
      this.schedule();
    }
  }

  private finishErase() {
    this.eraseAt = null;
    if (!this.eraseTouched.size) return;
    const remove = [...this.eraseTouched.values()];
    const add = this.strokes.filter((s) => this.eraseFrag.has(s.id));
    this.eraseTouched.clear();
    this.eraseFrag.clear();
    this.opts.onEdit('Erase', remove, add); // local list is already final
  }

  // ---------- shapes ----------
  private finishShape(e: PointerEvent) {
    const a = this.shapeA, tool = this.opts.getTool();
    const b = this.doc(e);
    this.shapeA = this.shapeB = null;
    if (!a || !this.page) return;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 3) return;
    const pts = shapePoints(tool.shape, a, b, e.shiftKey);
    const samples = new Float32Array(pts.length * SAMPLE_STRIDE);
    pts.forEach((p, i) => { samples.set([p.x, p.y, 0.5, 0, 0, i], i * SAMPLE_STRIDE); });
    this.opts.onStroke({
      kind: 'stroke', id: crypto.randomUUID(), pageId: this.page.id, layerId: this.opts.activeLayerId() ?? this.page.layerIds[0],
      tool: 'ballpoint', shape: tool.shape, color: tool.color, width: tool.width, opacity: tool.opacity,
      samples, bounds: boundsOf(samples, tool.width), order: Date.now(), revision: 1,
    });
  }

  // ---------- lasso ----------
  private lassoDown(d: Pt) {
    const sel = this.sel;
    const sb = this.selBounds();
    if (sel && sb) {
      const hr = 16 / this.view.scale;
      const corners: [number, number, number, number][] = [
        [sb.x0, sb.y0, sb.x1, sb.y1], [sb.x1, sb.y0, sb.x0, sb.y1], [sb.x0, sb.y1, sb.x1, sb.y0], [sb.x1, sb.y1, sb.x0, sb.y0],
      ];
      for (const [cx, cy, ox, oy] of corners) {
        if (Math.hypot(d.x - cx, d.y - cy) <= hr) {
          sel.t = { scale: 1, dx: 0, dy: 0, ax: ox, ay: oy };
          this.drag = { kind: 'scale', start: d, ax: ox, ay: oy, d0: Math.max(1, Math.hypot(d.x - ox, d.y - oy)) };
          return;
        }
      }
      if (d.x >= sb.x0 && d.x <= sb.x1 && d.y >= sb.y0 && d.y <= sb.y1) {
        sel.t = { ...ID_T };
        this.drag = { kind: 'move', start: d, ax: 0, ay: 0, d0: 1 };
        return;
      }
      this.clearSelection();
    }
    this.lasso = [d];
  }

  private lassoMove(d: Pt, _e: PointerEvent) {
    if (this.drag && this.sel) {
      if (this.drag.kind === 'move') {
        this.sel.t = { scale: 1, dx: d.x - this.drag.start.x, dy: d.y - this.drag.start.y, ax: 0, ay: 0 };
      } else {
        const s = Math.hypot(d.x - this.drag.ax, d.y - this.drag.ay) / this.drag.d0;
        this.sel.t = { scale: Math.min(10, Math.max(0.1, s)), dx: 0, dy: 0, ax: this.drag.ax, ay: this.drag.ay };
      }
      this.invalidate();
      return;
    }
    const last = this.lasso[this.lasso.length - 1];
    if (last && Math.hypot(d.x - last.x, d.y - last.y) < 1.5 / this.view.scale) return;
    this.lasso.push(d);
    this.liveDirty = true;
    this.schedule();
  }

  private finishLasso() {
    if (this.drag && this.sel) {
      const t = this.sel.t;
      this.drag = null;
      if (t.scale !== 1 || t.dx || t.dy) {
        const old = this.sel.strokes;
        const moved = old.map((s) => transformStroke(s, t.scale, t.ax, t.ay, t.dx, t.dy, crypto.randomUUID()));
        this.sel = { ids: new Set(moved.map((s) => s.id)), strokes: moved, t: { ...ID_T } };
        this.applyEdit('Transform', old, moved);
      }
      return;
    }
    const poly = this.lasso;
    this.lasso = [];
    if (poly.length < 3) return;
    const lm = this.layerMap();
    // whole-stroke selection when at least half of its samples are inside the polygon
    const picked = this.strokes.filter((s) => this.editable(s, lm) && bboxIntersectsPolygonBounds(s.bounds, poly) && insideFraction(s, poly) >= 0.5);
    this.select(picked);
  }

  // ---------- navigation ----------
  private navMetrics() {
    const pts = [...this.touches.values()].slice(0, 2);
    const r = this.rect();
    const cx = (pts[0].x + pts[1].x) / 2 - r.left;
    const cy = (pts[0].y + pts[1].y) / 2 - r.top;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    return { cx, cy, d };
  }
  private beginNav() {
    this.navLast = this.navMetrics();
  }
  private updateNav() {
    const m = this.navMetrics();
    const last = this.navLast!;
    let v: ViewMatrix = { ...this.view, tx: this.view.tx + (m.cx - last.cx), ty: this.view.ty + (m.cy - last.cy) };
    if (last.d > 4) v = zoomAbout(v, m.cx, m.cy, v.scale * (m.d / last.d));
    this.view = v;
    this.navLast = m;
    this.invalidate();
  }
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.rect();
    if (e.ctrlKey || e.metaKey) {
      this.view = zoomAbout(this.view, e.clientX - r.left, e.clientY - r.top, this.view.scale * Math.exp(-e.deltaY * 0.01));
    } else {
      this.view = { ...this.view, tx: this.view.tx - e.deltaX, ty: this.view.ty - e.deltaY };
    }
    this.invalidate();
  };
}
