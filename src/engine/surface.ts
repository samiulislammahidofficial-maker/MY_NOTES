import type { ImageBox, InkStroke, Page, Template, TextBox, ViewMatrix } from '../domain/types';
import { SAMPLE_STRIDE, isDark } from '../domain/types';
import { clientToDoc, constrainView, fitPage, fitWidth, zoomAbout } from '../domain/geometry';
import { SampleBuffer, StrokeStabilizer, arbitrate, expandEvents, resolvePressure } from './input';
import { applyView, boundsOf, centerlinePath, createRainbowStyle, strokePath } from './render';
import {
  type Pt,
  bboxIntersectsPolygonBounds,
  eraseCircle,
  fitShape,
  hitTestRuler,
  insideFraction,
  shapePoints,
  snapRulerAngle,
  snapToRuler,
  strokeHitsCircle,
  transformStroke,
  unionBounds,
} from './hit';
import { detectScribble } from './scribble';
import { writingDiagnostics } from './diagnostics';
import type { LayerInfo, PaperSpec, SelectionInfo, ToolSettings } from './tools';

export type { ToolSettings } from './tools';

export const RULER_HALF_LEN = 208.4; // 14 cm (~396.85 pt) + 10 pt end caps on each side
export const RULER_HALF_H = 26;

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
  /** If true, allow native scroll container to handle vertical scrolling when not drawing. */
  disableCanvasPanWheel?: boolean;
  /** If true, fit page to fill the host width & height exactly (used in Continuous Scroll). */
  fitFullHost?: boolean;
  getTexts?(): TextBox[];
  getSelectedTextId?(): string | null;
  getImages?(): ImageBox[];
  getSelectedImageId?(): string | null;
  onCanvasTap?(docPt: { x: number; y: number }): void;
  onTextSelect?(tb: TextBox): void;
  onImageSelect?(img: ImageBox | null): void;
  onImageCommit?(prev: ImageBox, next: ImageBox): void;
  onViewChange?(v: ViewMatrix, relativeScale: number): void;
  onPinchZoom?(factor: number, ended: boolean): void;
  onCloseRuler?(): void;
  onStrokeStart?(): void;
  getRuler?(): { x: number; y: number; angle: number };
  onRulerChange?(r: { x: number; y: number; angle: number }): void;
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

  // diagnostics counters (in-memory only, no private text or telemetry)
  private debugCounters = {
    down: 0,
    up: 0,
    cancel: 0,
    lostCapture: 0,
    accepted: 0,
    rejected: 0,
    completed: 0,
    lastGapMs: 0,
    minPressure: 1,
    maxPressure: 0,
    sampleCount: 0,
  };
  private touches = new Map<number, { x: number; y: number }>();
  private activeId: number | null = null;
  private activeType = '';
  private sessionCounter = 0;
  private activeSessionToken = 0;
  private mode: Mode = 'ink';
  private buf: SampleBuffer | null = null;
  private stabilizerFilter: StrokeStabilizer | null = null;
  private activeStrokeRect: DOMRect | null = null;
  private activeStrokeView: ViewMatrix | null = null;
  private t0 = 0;
  private penDown = false;
  private lastPenUp = -1e9;
  private navLast: { cx: number; cy: number; d: number } | null = null;
  /** Touch contacts rejected as palms (never eligible for navigation). */
  private palmIds = new Set<number>();
  /** event.timeStamp of the pointerdown that started the current session. */
  private sessionStartTs = 0;
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
  private rulerSnapped = true;
  private rulerDrag: {
    kind: 'move' | 'rotate';
    startX: number;
    startY: number;
    rx: number;
    ry: number;
    a0: number;
  } | null = null;
  private rulerTwoFinger: { cx: number; cy: number; angle: number; rx: number; ry: number; ra: number } | null = null;
  private bgCanvas: HTMLCanvasElement | HTMLImageElement | null = null;
  private bgPageKey = '';
  private imageElements = new Map<string, HTMLImageElement>();
  private imageDrag: {
    kind: 'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br';
    img: ImageBox;
    initialBounds: { x0: number; y0: number; x1: number; y1: number };
    startDoc: Pt;
  } | null = null;

  readonly diagnosticId = writingDiagnostics.notifySurfaceMounted();

  constructor(private host: HTMLElement, private opts: SurfaceOptions) {
    host.style.userSelect = 'none';
    host.style.webkitUserSelect = 'none';
    for (const c of [this.scene, this.live]) {
      c.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;display:block;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none';
      host.appendChild(c);
    }
    // Always use touch-action: none on the live canvas so iPadOS/Android browsers never
    // hijack vertical pen strokes or finger-drawing strokes with native pan-y scrolling.
    // In Continuous Scroll mode, 1-finger touch panning scrolls the parent .continuous-scroll-pane.
    this.live.style.touchAction = 'none';
    this.live.addEventListener('pointerdown', this.onDown);
    this.live.addEventListener('pointermove', this.onMove);
    this.live.addEventListener('pointerup', this.onUp);
    this.live.addEventListener('pointercancel', this.onCancel);
    this.live.addEventListener('lostpointercapture', this.onLostPointerCapture);
    this.live.addEventListener('wheel', this.onWheel, { passive: false });
    this.live.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mynotes:quiesce-for-update', this.onQuiesceForUpdate);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  private onQuiesceForUpdate = () => {
    this.completeOrCancelActiveGestureSafely();
  };

  private async loadImageAsset(assetId: string) {
    if (this.imageElements.has(assetId)) return;
    try {
      const { blobStore } = await import('../storage/blobStore');
      const bytes = await blobStore.get(assetId);
      if (!bytes) return;
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        this.imageElements.set(assetId, img);
        this.invalidate();
      };
      img.src = url;
    } catch {
      /* ignore */
    }
  }

  destroy() {
    clearTimeout(this.holdTimer);
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('mynotes:quiesce-for-update', this.onQuiesceForUpdate);
    this.host.replaceChildren();
  }

  /**
   * Safely finishes or cancels an in-progress gesture before a user-confirmed app update.
   */
  completeOrCancelActiveGestureSafely() {
    if (this.activeId === null && !this.penDown && !this.rulerDrag && !this.rulerTwoFinger) return;
    clearTimeout(this.holdTimer);
    if (this.rulerDrag || this.rulerTwoFinger) {
      this.rulerDrag = null;
      this.rulerTwoFinger = null;
      this.activeId = null;
      this.penDown = false;
      this.liveDirty = true;
      this.schedule();
      return;
    }
    const mode = this.mode;
    this.activeId = null;
    this.penDown = false;
    if (mode === 'ink' && this.buf && this.buf.length > 0) {
      this.finishInk();
    } else if (mode === 'erase' && this.eraseTouched.size > 0) {
      this.finishErase();
    } else {
      this.cancelSession();
    }
    this.liveDirty = true;
    this.schedule();
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
      activePointerType: this.activeType || 'none',
      activeSessionToken: this.activeSessionToken,
      surfaceLifecycles: writingDiagnostics.getLifecycleCount(),
      debug: { ...this.debugCounters },
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
      import('../pdf/pdfManager')
        .then(({ renderPdfPageBackground }) => renderPdfPageBackground(page.pdfAssetId!, page.pdfPageIndex!, 1.5))
        .then((bmp) => {
          if (this.bgPageKey === key && bmp) {
            this.bgCanvas = bmp;
            this.invalidate();
          }
        })
        .catch(() => {});
    } else if (page.imageAssetId) {
      import('../pdf/pdfManager')
        .then(({ getScannedImageElement }) => getScannedImageElement(page.imageAssetId!))
        .then((img) => {
          if (this.bgPageKey === key && img) {
            this.bgCanvas = img;
            this.invalidate();
          }
        })
        .catch(() => {});
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
    this.view = this.applyBounds(v);
    this.opts.onViewChange?.(this.view, this.getRelativeScale());
    this.invalidate();
  }
  isStrokeActive() {
    return this.activeId !== null || this.penDown;
  }

  getFitScale(): number {
    if (!this.page || this.cssW <= 8) return 1;
    if (this.opts.fitFullHost) {
      return this.cssW / Math.max(1, this.page.width);
    }
    return this.applyBounds(fitWidth(this.cssW, this.cssH, this.page.width, this.page.height, 20, 16)).scale;
  }

  getRelativeScale(): number {
    const fitS = this.getFitScale();
    return fitS > 0 ? this.view.scale / fitS : 1;
  }

  snapToFitWidth() {
    if (!this.page) return;
    if (this.opts.fitFullHost) {
      this.fitWidthView();
      return;
    }
    const fw = this.applyBounds(fitWidth(this.cssW, this.cssH, this.page.width, this.page.height, 20, 16));
    const zoomed = zoomAbout(this.view, this.cssW / 2, this.cssH / 2, fw.scale);
    const next = this.applyBounds({ scale: fw.scale, tx: fw.tx, ty: zoomed.ty });
    this.view = next;
    this.opts.onViewChange?.(this.view, 1);
    this.invalidate();
  }

  private applyBounds(v: ViewMatrix): ViewMatrix {
    if (this.opts.fitFullHost || this.opts.disableAutoFit || !this.page || this.cssW <= 8) {
      return v;
    }
    return constrainView(v, this.cssW, this.cssH, this.page.width, this.page.height, 16);
  }

  fitWidthView() {
    if (!this.page) return;
    if (this.opts.fitFullHost) {
      const scale = this.cssW / Math.max(1, this.page.width);
      this.view = { scale, tx: 0, ty: 0 };
    } else {
      this.view = this.applyBounds(fitWidth(this.cssW, this.cssH, this.page.width, this.page.height, 20, 16));
    }
    this.opts.onViewChange?.(this.view, 1);
    this.invalidate();
  }

  fitPageView() {
    if (!this.page) return;
    if (this.opts.fitFullHost) {
      const scale = this.cssW / Math.max(1, this.page.width);
      this.view = { scale, tx: 0, ty: 0 };
    } else {
      this.view = this.applyBounds(fitPage(this.cssW, this.cssH, this.page.width, this.page.height));
    }
    this.opts.onViewChange?.(this.view, this.getRelativeScale());
    this.invalidate();
  }

  zoomByFactor(factor: number) {
    const fitS = this.getFitScale();
    const targetScale = this.view.scale * factor;
    if (fitS > 0 && Math.abs(targetScale / fitS - 1) <= 0.05) {
      this.snapToFitWidth();
      return;
    }
    this.commitView(zoomAbout(this.view, this.cssW / 2, this.cssH / 2, targetScale));
  }

  fit() {
    this.fitWidthView();
  }
  invalidate() {
    this.sceneDirty = true;
    this.liveDirty = true;
    this.schedule();
  }

  private maybeFit() {
    if (this.opts.disableAutoFit) return;
    if (!this.fitted && this.page && this.cssW > 8) {
      this.fitWidthView();
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
      if (this.opts.fitFullHost && this.page) {
        const scale = this.cssW / Math.max(1, this.page.width);
        this.view = { scale, tx: 0, ty: 0 };
      } else {
        this.view = this.applyBounds({
          ...this.view,
          tx: this.view.tx + (this.cssW - oldW) / 2,
          ty: this.view.ty + (this.cssH - oldH) / 2,
        });
      }
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
    ctx.save();
    ctx.globalAlpha = s.opacity * layerOpacity;
    const style = s.rainbowSeed !== undefined ? createRainbowStyle(ctx, s.samples, s.rainbowSeed, s.color) : s.color;
    // highlighter: one filled outline composited once -> no self-overlap blotches
    ctx.globalCompositeOperation = s.tool === 'highlighter' ? (dark ? 'screen' : 'multiply') : 'source-over';
    const isCompat = s.ballpointModel === 'compatibility' || (!s.ballpointModel && s.tool === 'ballpoint' && this.opts.getTool().ballpointModel === 'compatibility');
    if (isCompat && s.tool !== 'highlighter') {
      ctx.setLineDash([]);
      ctx.strokeStyle = style;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(centerlinePath(s.samples, s.id, s.revision));
    } else if (s.strokeStyle && s.strokeStyle !== 'solid' && s.tool !== 'highlighter') {
      ctx.strokeStyle = style;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const w = Math.max(1.5, s.width);
      ctx.setLineDash(s.strokeStyle === 'dashed' ? [w * 3, w * 2.2] : [w * 0.2, w * 2.2]);
      ctx.stroke(centerlinePath(s.samples, s.id, s.revision));
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = style;
      ctx.fill(strokePath(s));
    }
    ctx.restore();
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

    const lm = this.layerMap();
    // Draw user-inserted Question / Exercise photos underneath or at their layer level
    const pageImages = this.opts.getImages?.() ?? [];
    for (const img of pageImages) {
      const l = lm.get(img.layerId);
      if (l && !l.visible) continue;
      const cached = this.imageElements.get(img.assetId);
      const w = img.bounds.x1 - img.bounds.x0;
      const h = img.bounds.y1 - img.bounds.y0;
      ctx.globalAlpha = (img.opacity ?? 1) * (l?.opacity ?? 1);
      if (cached && cached.complete && cached.naturalWidth > 0) {
        ctx.drawImage(cached, img.bounds.x0, img.bounds.y0, w, h);
      } else {
        // Placeholder outline while async loading from IndexedDB blobStore
        ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)';
        ctx.fillRect(img.bounds.x0, img.bounds.y0, w, h);
        ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)';
        ctx.lineWidth = 1 / this.view.scale;
        ctx.strokeRect(img.bounds.x0, img.bounds.y0, w, h);
        if (!cached) {
          void this.loadImageAsset(img.assetId);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = paper.line;
    ctx.lineWidth = 1 / this.view.scale;
    ctx.strokeRect(0, 0, this.page.width, this.page.height);
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
    const selTextId = this.opts.getSelectedTextId?.() ?? null;
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
      let maxMeasuredW = 0;
      lines.forEach((line) => {
        maxMeasuredW = Math.max(maxMeasuredW, ctx.measureText(line).width);
      });
      // Update dynamic bounds width/height in place for accurate hit testing
      tb.bounds.x1 = Math.max(tb.bounds.x1, tb.bounds.x0 + maxMeasuredW + 8);
      tb.bounds.y1 = Math.max(tb.bounds.y1, tb.bounds.y0 + Math.max(1, lines.length) * lh + 4);
      const ax = tb.align === 'center' ? (tb.bounds.x0 + tb.bounds.x1) / 2 : tb.align === 'right' ? tb.bounds.x1 : tb.bounds.x0;
      lines.forEach((line, idx) => {
        ctx.fillText(line, ax, tb.bounds.y0 + idx * lh);
      });
      if (selTextId === tb.id) {
        ctx.save();
        ctx.strokeStyle = '#0A84FF';
        ctx.lineWidth = 1.5 / this.view.scale;
        ctx.setLineDash([4 / this.view.scale, 3 / this.view.scale]);
        ctx.strokeRect(tb.bounds.x0 - 4, tb.bounds.y0 - 4, tb.bounds.x1 - tb.bounds.x0 + 8, tb.bounds.y1 - tb.bounds.y0 + 8);
        ctx.setLineDash([]);
        ctx.fillStyle = '#0A84FF';
        const hs = 4.5 / this.view.scale;
        for (const [hx, hy] of [
          [tb.bounds.x0 - 4, tb.bounds.y0 - 4],
          [tb.bounds.x1 + 4, tb.bounds.y0 - 4],
          [tb.bounds.x0 - 4, tb.bounds.y1 + 4],
          [tb.bounds.x1 + 4, tb.bounds.y1 + 4],
        ]) {
          ctx.beginPath();
          ctx.arc(hx, hy, hs, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
    const selImgId = this.opts.getSelectedImageId?.() ?? null;
    if (selImgId) {
      const selectedImg = pageImages.find((im) => im.id === selImgId);
      if (selectedImg) {
        ctx.save();
        ctx.strokeStyle = '#0A84FF';
        ctx.lineWidth = 1.8 / this.view.scale;
        ctx.setLineDash([5 / this.view.scale, 3.5 / this.view.scale]);
        ctx.strokeRect(
          selectedImg.bounds.x0 - 2,
          selectedImg.bounds.y0 - 2,
          selectedImg.bounds.x1 - selectedImg.bounds.x0 + 4,
          selectedImg.bounds.y1 - selectedImg.bounds.y0 + 4,
        );
        ctx.setLineDash([]);
        const hs = 6.5 / this.view.scale;
        for (const [hx, hy] of [
          [selectedImg.bounds.x0, selectedImg.bounds.y0],
          [selectedImg.bounds.x1, selectedImg.bounds.y0],
          [selectedImg.bounds.x0, selectedImg.bounds.y1],
          [selectedImg.bounds.x1, selectedImg.bounds.y1],
        ]) {
          ctx.beginPath();
          ctx.arc(hx, hy, hs, 0, Math.PI * 2);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.strokeStyle = '#0A84FF';
          ctx.lineWidth = 2 / this.view.scale;
          ctx.stroke();
        }
        ctx.restore();
      }
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
        const isCompat = !hl && tool.nib === 'ballpoint' && tool.ballpointModel === 'compatibility';
        if (isCompat) {
          ctx.setLineDash([]);
          ctx.strokeStyle = style;
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke(centerlinePath(sub));
        } else if (!hl && tool.strokeStyle !== 'solid') {
          ctx.strokeStyle = style;
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          const u = Math.max(1.5, w);
          ctx.setLineDash(tool.strokeStyle === 'dashed' ? [u * 3, u * 2.2] : [u * 0.2, u * 2.2]);
          ctx.stroke(centerlinePath(sub));
          ctx.setLineDash([]);
        } else {
          ctx.setLineDash([]);
          ctx.fillStyle = style;
          ctx.fill(strokePath({ samples: sub, width: w, tool: hl ? 'highlighter' : tool.nib, smoothing: this.smoothing(tool), streamline: this.smoothing(tool) }, false));
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
    if (tool.rulerVisible) {
      if (this.opts.getRuler) {
        const ext = this.opts.getRuler();
        this.ruler.x = ext.x;
        this.ruler.y = ext.y;
        this.ruler.angle = ext.angle;
      }
      this.drawPhysicalRuler(ctx, sc, tool);
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

  private drawPhysicalRuler(ctx: CanvasRenderingContext2D, sc: number, tool: ToolSettings) {
    const darkPaper = isDark(this.opts.getPaper().color);
    const units = tool.rulerUnits ?? 'metric';
    const halfLen = RULER_HALF_LEN;
    const halfH = RULER_HALF_H;
    const w = halfLen * 2;
    const h = halfH * 2;

    ctx.save();
    ctx.translate(this.ruler.x, this.ruler.y);
    ctx.rotate(this.ruler.angle);

    // Restrained drop shadow
    ctx.save();
    ctx.shadowColor = darkPaper ? 'rgba(0, 0, 0, 0.52)' : 'rgba(15, 23, 42, 0.22)';
    ctx.shadowBlur = 10 / sc;
    ctx.shadowOffsetY = 2.5 / sc;
    ctx.beginPath();
    ctx.roundRect(-halfLen, -halfH, w, h, 7);
    ctx.fillStyle = darkPaper ? 'rgba(32, 36, 44, 0.86)' : 'rgba(246, 248, 252, 0.88)';
    ctx.fill();
    ctx.restore();

    // Fine border & active straightedge highlight along top & bottom edges
    ctx.beginPath();
    ctx.roundRect(-halfLen, -halfH, w, h, 7);
    ctx.lineWidth = 1 / sc;
    ctx.strokeStyle = darkPaper ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.22)';
    ctx.stroke();

    // Subtle blue straightedge guide along top and bottom ink edges
    ctx.strokeStyle = this.rulerSnapped ? 'rgba(10, 132, 255, 0.88)' : 'rgba(10, 132, 255, 0.58)';
    ctx.lineWidth = 1.4 / sc;
    ctx.beginPath();
    ctx.moveTo(-halfLen + 6, -halfH);
    ctx.lineTo(halfLen - 6, -halfH);
    ctx.moveTo(-halfLen + 6, halfH);
    ctx.lineTo(halfLen - 6, halfH);
    ctx.stroke();

    // Graduated ticks & major interval labels
    const tickColorMajor = darkPaper ? 'rgba(248, 250, 252, 0.95)' : 'rgba(15, 23, 42, 0.92)';
    const tickColorMinor = darkPaper ? 'rgba(203, 213, 225, 0.68)' : 'rgba(51, 65, 85, 0.62)';
    const labelColor = darkPaper ? '#F1F5F9' : '#0F172A';

    ctx.font = `600 ${Math.max(5.5, 7.5)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    if (units === 'metric') {
      // 14 cm total (140 mm), 1 mm = 72 / 25.4 pt ≈ 2.83464567 pt
      const mmPt = 72 / 25.4;
      const startX = -70 * mmPt; // -198.425 pt
      for (let mm = 0; mm <= 140; mm++) {
        const x = startX + mm * mmPt;
        const isCm = mm % 10 === 0;
        const isHalfCm = mm % 5 === 0 && !isCm;
        const topTickLen = isCm ? 9.5 : isHalfCm ? 6.2 : 3.4;
        const botTickLen = isCm ? 7.2 : isHalfCm ? 4.8 : 2.6;

        ctx.strokeStyle = isCm ? tickColorMajor : tickColorMinor;
        ctx.lineWidth = (isCm ? 1.15 : 0.75) / sc;
        ctx.beginPath();
        // Top graduated edge
        ctx.moveTo(x, -halfH);
        ctx.lineTo(x, -halfH + topTickLen);
        // Bottom graduated edge
        ctx.moveTo(x, halfH);
        ctx.lineTo(x, halfH - botTickLen);
        ctx.stroke();

        if (isCm) {
          const cmVal = mm / 10;
          // Skip labels that would collide with the compact center capsule (cm 5..9) only on the bottom; keep top numbers clear!
          ctx.fillStyle = labelColor;
          ctx.fillText(cmVal === 0 ? '0 cm' : String(cmVal), x, -halfH + 10.5);
        }
      }
    } else {
      // Imperial: 5.5 inches = 88 sixteenths, 1/16 in = 4.5 pt
      const stepPt = 72 / 16;
      const startX = -44 * stepPt; // -198 pt
      for (let s16 = 0; s16 <= 88; s16++) {
        const x = startX + s16 * stepPt;
        const isInch = s16 % 16 === 0;
        const isHalf = s16 % 8 === 0 && !isInch;
        const isQuarter = s16 % 4 === 0 && !isInch && !isHalf;
        const topTickLen = isInch ? 9.5 : isHalf ? 7.0 : isQuarter ? 5.0 : 3.0;
        const botTickLen = isInch ? 7.2 : isHalf ? 5.2 : isQuarter ? 3.8 : 2.2;

        ctx.strokeStyle = isInch ? tickColorMajor : tickColorMinor;
        ctx.lineWidth = (isInch ? 1.15 : 0.75) / sc;
        ctx.beginPath();
        ctx.moveTo(x, -halfH);
        ctx.lineTo(x, -halfH + topTickLen);
        ctx.moveTo(x, halfH);
        ctx.lineTo(x, halfH - botTickLen);
        ctx.stroke();

        if (isInch) {
          const inVal = s16 / 16;
          ctx.fillStyle = labelColor;
          ctx.fillText(inVal === 0 ? '0 in' : String(inVal), x, -halfH + 10.5);
        }
      }
    }

    // Central drag grip dots (left of capsule, away from ink edges)
    ctx.fillStyle = darkPaper ? 'rgba(255, 255, 255, 0.35)' : 'rgba(15, 23, 42, 0.32)';
    for (const gx of [-92, -86, -80]) {
      for (const gy of [-2.2, 2.8]) {
        ctx.beginPath();
        ctx.arc(gx, gy, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Tidy contextual control capsule along perp = 0 (away from top/bottom ink edges)
    const capBg = darkPaper ? 'rgba(18, 20, 26, 0.92)' : 'rgba(255, 255, 255, 0.94)';
    const capBorder = darkPaper ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)';
    ctx.beginPath();
    ctx.roundRect(-68, -9.5, 146, 19, 9.5);
    ctx.fillStyle = capBg;
    ctx.fill();
    ctx.lineWidth = 0.9 / sc;
    ctx.strokeStyle = capBorder;
    ctx.stroke();

    const deg = snapRulerAngle(this.ruler.angle, 2.5, true).deg;
    ctx.textBaseline = 'middle';
    ctx.font = `600 7.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

    // 1. Rotate handle (-52, 0)
    ctx.fillStyle = '#0A84FF';
    ctx.beginPath();
    ctx.arc(-52, 0, 6.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('↻', -52, 0.5);

    // 2. Angle readout (-16, 0)
    ctx.fillStyle = this.rulerSnapped ? '#0A84FF' : labelColor;
    ctx.fillText(`${deg}°`, -16, 0.5);

    // 3. Reset 0° button (+26, 0)
    ctx.fillStyle = darkPaper ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.08)';
    ctx.beginPath();
    ctx.roundRect(12, -6.5, 28, 13, 6.5);
    ctx.fill();
    ctx.fillStyle = labelColor;
    ctx.font = `600 6.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText('0°', 26, 0.5);

    // 4. Close button (+62, 0)
    ctx.fillStyle = darkPaper ? 'rgba(255, 69, 58, 0.22)' : 'rgba(255, 69, 58, 0.16)';
    ctx.beginPath();
    ctx.arc(62, 0, 6.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FF453A';
    ctx.font = `700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText('×', 62, 0.5);

    ctx.restore();
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
    // Palm rejection BEFORE any gesture recognition: while a pen owns the surface (or within
    // the short post-pen guard), touch contacts are recorded as ignored palms and never enter
    // the navigation contact registry, so they cannot cancel ink or later form a pinch.
    if (e.pointerType === 'touch') {
      if (this.penDown || performance.now() - this.lastPenUp < 250) {
        this.palmIds.add(e.pointerId);
        this.debugCounters.rejected++;
        writingDiagnostics.record({
          surfaceId: this.diagnosticId,
          type: 'reject',
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          pressure: e.pressure,
          reason: 'palm-rejection (pen down or guard window)',
        });
        return;
      }
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    this.opts.onActivate?.();
    this.debugCounters.down++;
    writingDiagnostics.record({
      surfaceId: this.diagnosticId,
      type: 'down',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      pressure: e.pressure,
    });
    if (e.pointerType === 'pen') {
      // Pen takes ownership: drop any in-progress finger navigation state.
      this.navLast = null;
      this.rulerTwoFinger = null;
      if (this.mode === 'pan' && this.activeType === 'touch' && this.activeId !== null) {
        this.cancelSession();
      }
      const now = performance.now();
      if (this.lastPenUp > 0) {
        this.debugCounters.lastGapMs = Math.round(now - this.lastPenUp);
      }
    }
    const tool = this.opts.getTool();
    const mode = this.modeFor(tool);
    const d = this.doc(e);

    // Two-finger gesture: check if both touches are on the ruler body for two-finger ruler rotation/move
    if (e.pointerType === 'touch' && this.touches.size >= 2) {
      this.cancelSession();
      if (tool.rulerVisible && !this.opts.disableAutoFit) {
        const pts = [...this.touches.values()].slice(0, 2);
        const d0 = this.doc({ clientX: pts[0].x, clientY: pts[0].y });
        const d1 = this.doc({ clientX: pts[1].x, clientY: pts[1].y });
        const h0 = hitTestRuler(d0, 'touch', this.ruler, this.view.scale, RULER_HALF_LEN, RULER_HALF_H);
        const h1 = hitTestRuler(d1, 'touch', this.ruler, this.view.scale, RULER_HALF_LEN, RULER_HALF_H);
        if (h0 && h1) {
          this.rulerTwoFinger = {
            cx: (d0.x + d1.x) / 2,
            cy: (d0.y + d1.y) / 2,
            angle: Math.atan2(d1.y - d0.y, d1.x - d0.x),
            rx: this.ruler.x,
            ry: this.ruler.y,
            ra: this.ruler.angle,
          };
          return;
        }
      }
      this.beginNav();
      return;
    }

    // Check ruler controls/manipulation before pen-only touch rejection so finger/mouse can move/rotate/close the ruler,
    // while a pen moving along the ruler edge always creates ink ('ink') and never drags the ruler.
    if (tool.rulerVisible && !this.opts.disableAutoFit && this.activeId === null && !this.penDown) {
      const rHit = hitTestRuler(d, e.pointerType, this.ruler, this.view.scale, RULER_HALF_LEN, RULER_HALF_H);
      if (rHit === 'close') {
        e.preventDefault();
        this.touches.delete(e.pointerId);
        this.opts.onCloseRuler?.();
        return;
      }
      if (rHit === 'reset') {
        e.preventDefault();
        this.touches.delete(e.pointerId);
        this.ruler.angle = 0;
        this.rulerSnapped = true;
        this.opts.onRulerChange?.({ ...this.ruler });
        this.liveDirty = true;
        this.schedule();
        return;
      }
      if (rHit === 'move' || rHit === 'rotate') {
        e.preventDefault();
        try {
          this.live.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        this.activeId = e.pointerId;
        this.activeSessionToken = ++this.sessionCounter;
        this.sessionStartTs = e.timeStamp;
        this.activeType = e.pointerType;
        const vx = d.x - this.ruler.x,
          vy = d.y - this.ruler.y;
        this.rulerDrag = {
          kind: rHit,
          startX: d.x,
          startY: d.y,
          rx: this.ruler.x,
          ry: this.ruler.y,
          a0: Math.atan2(vy, vx) - this.ruler.angle,
        };
        return;
      }
    }

    // Image manipulation (resize handles or drag to move selected image)
    const selImgId = this.opts.getSelectedImageId?.();
    if (selImgId && this.activeId === null && !this.penDown) {
      const pageImgs = this.opts.getImages?.() ?? [];
      const selectedImg = pageImgs.find((im) => im.id === selImgId);
      if (selectedImg) {
        const b = selectedImg.bounds;
        const cornerR = Math.max(16, 20 / this.view.scale);
        let dragKind: 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br' | 'move' | null = null;
        if (Math.hypot(d.x - b.x0, d.y - b.y0) <= cornerR) dragKind = 'resize-tl';
        else if (Math.hypot(d.x - b.x1, d.y - b.y0) <= cornerR) dragKind = 'resize-tr';
        else if (Math.hypot(d.x - b.x0, d.y - b.y1) <= cornerR) dragKind = 'resize-bl';
        else if (Math.hypot(d.x - b.x1, d.y - b.y1) <= cornerR) dragKind = 'resize-br';
        else if (
          (tool.kind === 'text' || tool.kind === 'lasso' || tool.kind === 'hand') &&
          d.x >= b.x0 && d.x <= b.x1 && d.y >= b.y0 && d.y <= b.y1
        ) {
          dragKind = 'move';
        }

        if (dragKind) {
          e.preventDefault();
          try {
            this.live.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic */
          }
          this.activeId = e.pointerId;
          this.activeSessionToken = ++this.sessionCounter;
          this.sessionStartTs = e.timeStamp;
          this.activeType = e.pointerType;
          this.imageDrag = {
            kind: dragKind,
            img: selectedImg,
            initialBounds: { ...selectedImg.bounds },
            startDoc: d,
          };
          return;
        }
      }
    }

    let action = arbitrate(e.pointerType, {
      penOnly: tool.penOnly,
      fingerDrawing: tool.fingerDrawing,
      penDown: this.penDown,
      sincePenUp: performance.now() - this.lastPenUp,
      guardMs: 250,
      touchCount: this.touches.size,
    });
    if (mode === 'pan' && e.pointerType === 'touch' && this.touches.size === 1 && !this.penDown) {
      action = 'ink';
    }

    // 1-finger scrolling/panning in Pen-only mode (or when finger drawing is off)
    if (action === 'navigate' && e.pointerType === 'touch' && this.touches.size === 1 && !this.penDown) {
      e.preventDefault();
      try { this.live.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.activeId = e.pointerId;
      this.activeSessionToken = ++this.sessionCounter;
      this.sessionStartTs = e.timeStamp;
      this.activeType = e.pointerType;
      this.mode = 'pan';
      this.panLast = { x: e.clientX, y: e.clientY };
      return;
    }

    if (action !== 'ink') {
      this.debugCounters.rejected++;
      writingDiagnostics.record({
        surfaceId: this.diagnosticId,
        type: 'reject',
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        pressure: e.pressure,
        reason: `arbitration-${action}`,
      });
      return;
    }

    // For pen strokes, if another stroke was somehow still active (rapid pen strokes), finalize it immediately
    if (e.pointerType === 'pen' && this.activeId !== null) {
      if (this.mode === 'ink' && this.buf && this.buf.length > 0) {
        this.finishInk();
      } else {
        this.cancelSession();
      }
    } else if (this.activeId !== null) {
      this.debugCounters.rejected++;
      writingDiagnostics.record({
        surfaceId: this.diagnosticId,
        type: 'reject',
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        pressure: e.pressure,
        reason: `activeId-busy-${this.activeId}`,
      });
      return;
    }

    e.preventDefault();
    try { this.live.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.activeId = e.pointerId;
    this.activeSessionToken = ++this.sessionCounter;
    this.sessionStartTs = e.timeStamp;
    this.activeType = e.pointerType;
    this.mode = mode;
    this.debugCounters.accepted++;
    writingDiagnostics.record({
      surfaceId: this.diagnosticId,
      type: 'accept',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      pressure: e.pressure,
      sessionToken: this.activeSessionToken,
    });
    if (e.pointerType === 'pen') this.penDown = true;
    this.opts.onStrokeStart?.();
    if (mode !== 'lasso' && this.sel) this.clearSelection();
    if (tool.kind === 'text') {
      this.activeId = null;
      this.penDown = false;
      const texts = this.opts.getTexts?.() ?? [];
      const lm = this.layerMap();
      const pad = 6;
      const hitTb = [...texts].reverse().find((tb) => {
        const l = lm.get(tb.layerId);
        if (l && (!l.visible || l.locked)) return false;
        return (
          d.x >= tb.bounds.x0 - pad &&
          d.x <= tb.bounds.x1 + pad &&
          d.y >= tb.bounds.y0 - pad &&
          d.y <= tb.bounds.y1 + pad
        );
      });
      if (hitTb && this.opts.onTextSelect) {
        this.opts.onTextSelect(hitTb);
        return;
      }

      // Check if user clicked an inserted image to select/edit/resize/move it
      const images = this.opts.getImages?.() ?? [];
      const hitImg = [...images].reverse().find((im) => {
        const l = lm.get(im.layerId);
        if (l && (!l.visible || l.locked)) return false;
        return (
          d.x >= im.bounds.x0 - pad &&
          d.x <= im.bounds.x1 + pad &&
          d.y >= im.bounds.y0 - pad &&
          d.y <= im.bounds.y1 + pad
        );
      });
      if (hitImg && this.opts.onImageSelect) {
        this.opts.onImageSelect(hitImg);
        return;
      }

      this.opts.onCanvasTap?.(d);
      return;
    }
    switch (mode) {
      case 'ink':
        this.buf = new SampleBuffer();
        this.stabilizerFilter = new StrokeStabilizer(tool.penSmoothing ?? 'low');
        this.activeStrokeRect = this.rect();
        this.activeStrokeView = { ...this.view };
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
    const r = this.activeStrokeRect ?? this.rect();
    const v = this.activeStrokeView ?? this.view;
    for (const ev of evs) {
      let d = clientToDoc(ev.clientX, ev.clientY, r, v);
      const tMs = Math.max(0, ev.timeStamp - this.t0);
      const rawP = resolvePressure(ev.pointerType, ev.pressure, tool.constantPressure, this.buf.length > 0);
      let p = rawP;
      if (tool.rulerVisible) {
        if (this.opts.getRuler) {
          const ext = this.opts.getRuler();
          this.ruler.x = ext.x;
          this.ruler.y = ext.y;
          this.ruler.angle = ext.angle;
        }
        d = snapToRuler(d, this.ruler.x, this.ruler.y, this.ruler.angle, 18, RULER_HALF_H, RULER_HALF_LEN);
      } else if (this.stabilizerFilter) {
        const filtered = this.stabilizerFilter.filterSample(d.x, d.y, rawP, tMs);
        d = { x: filtered.x, y: filtered.y };
        p = filtered.p;
      }
      // Deduplicate identical zero-movement samples except the very first point
      if (this.buf.length > 0) {
        const prevOff = (this.buf.length - 1) * SAMPLE_STRIDE;
        const dx = d.x - this.buf.data[prevOff];
        const dy = d.y - this.buf.data[prevOff + 1];
        if (Math.hypot(dx, dy) < 0.08 && Math.abs(tMs - this.buf.data[prevOff + 5]) < 2) {
          continue;
        }
      }
      this.buf.push(d.x, d.y, p, ev.tiltX || 0, ev.tiltY || 0, tMs);
      this.debugCounters.sampleCount++;
      if (p > 0) {
        this.debugCounters.minPressure = Math.min(this.debugCounters.minPressure, p);
        this.debugCounters.maxPressure = Math.max(this.debugCounters.maxPressure, p);
      }
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
    if (this.palmIds.has(e.pointerId)) return;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.rulerTwoFinger && this.touches.size >= 2) {
        const pts = [...this.touches.values()].slice(0, 2);
        const d0 = this.doc({ clientX: pts[0].x, clientY: pts[0].y });
        const d1 = this.doc({ clientX: pts[1].x, clientY: pts[1].y });
        const cx = (d0.x + d1.x) / 2;
        const cy = (d0.y + d1.y) / 2;
        const rawAngle = this.rulerTwoFinger.ra + (Math.atan2(d1.y - d0.y, d1.x - d0.x) - this.rulerTwoFinger.angle);
        const snapped = snapRulerAngle(rawAngle, 2.5, e.shiftKey || e.altKey);
        this.ruler.x = this.rulerTwoFinger.rx + (cx - this.rulerTwoFinger.cx);
        this.ruler.y = this.rulerTwoFinger.ry + (cy - this.rulerTwoFinger.cy);
        this.ruler.angle = snapped.angle;
        this.rulerSnapped = snapped.snapped;
        this.opts.onRulerChange?.({ ...this.ruler });
        this.liveDirty = true;
        this.schedule();
        return;
      }
      if (this.navLast && this.touches.size >= 2) {
        this.updateNav();
        return;
      }
    }
    if (e.pointerId !== this.activeId) return;
    if (this.imageDrag) {
      const d = this.doc(e);
      const dx = d.x - this.imageDrag.startDoc.x;
      const dy = d.y - this.imageDrag.startDoc.y;
      const init = this.imageDrag.initialBounds;
      const ar = this.imageDrag.img.aspectRatio || Math.max(0.1, (init.x1 - init.x0) / Math.max(1, init.y1 - init.y0));
      const pW = this.page?.width ?? 600;
      const pH = this.page?.height ?? 800;

      if (this.imageDrag.kind === 'move') {
        const w = init.x1 - init.x0;
        const h = init.y1 - init.y0;
        const nx0 = Math.max(0, Math.min(pW - w, init.x0 + dx));
        const ny0 = Math.max(0, Math.min(pH - h, init.y0 + dy));
        this.imageDrag.img.bounds = { x0: nx0, y0: ny0, x1: nx0 + w, y1: ny0 + h };
      } else if (this.imageDrag.kind === 'resize-br') {
        let w = Math.max(60, Math.min(pW - init.x0, init.x1 - init.x0 + dx));
        let h = w / ar;
        if (init.y0 + h > pH) {
          h = pH - init.y0;
          w = h * ar;
        }
        this.imageDrag.img.bounds = { x0: init.x0, y0: init.y0, x1: init.x0 + w, y1: init.y0 + h };
      } else if (this.imageDrag.kind === 'resize-bl') {
        let w = Math.max(60, Math.min(init.x1, init.x1 - (init.x0 + dx)));
        let h = w / ar;
        if (init.y0 + h > pH) {
          h = pH - init.y0;
          w = h * ar;
        }
        this.imageDrag.img.bounds = { x0: init.x1 - w, y0: init.y0, x1: init.x1, y1: init.y0 + h };
      } else if (this.imageDrag.kind === 'resize-tr') {
        let w = Math.max(60, Math.min(pW - init.x0, init.x1 - init.x0 + dx));
        let h = w / ar;
        if (init.y1 - h < 0) {
          h = init.y1;
          w = h * ar;
        }
        this.imageDrag.img.bounds = { x0: init.x0, y0: init.y1 - h, x1: init.x0 + w, y1: init.y1 };
      } else if (this.imageDrag.kind === 'resize-tl') {
        let w = Math.max(60, Math.min(init.x1, init.x1 - (init.x0 + dx)));
        let h = w / ar;
        if (init.y1 - h < 0) {
          h = init.y1;
          w = h * ar;
        }
        this.imageDrag.img.bounds = { x0: init.x1 - w, y0: init.y1 - h, x1: init.x1, y1: init.y1 };
      }
      this.invalidate();
      return;
    }
    if (this.rulerDrag) {
      const d = this.doc(e);
      if (this.rulerDrag.kind === 'move') {
        this.ruler.x = this.rulerDrag.rx + (d.x - this.rulerDrag.startX);
        this.ruler.y = this.rulerDrag.ry + (d.y - this.rulerDrag.startY);
      } else {
        const rawAngle = Math.atan2(d.y - this.ruler.y, d.x - this.ruler.x) - this.rulerDrag.a0;
        const snapped = snapRulerAngle(rawAngle, 2.5, e.shiftKey || e.altKey);
        this.ruler.angle = snapped.angle;
        this.rulerSnapped = snapped.snapped;
      }
      this.opts.onRulerChange?.({ ...this.ruler });
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
          const dx = e.clientX - this.panLast.x;
          const dy = e.clientY - this.panLast.y;
          if (this.opts.disableCanvasPanWheel) {
            const scrollEl = this.host.closest('.continuous-scroll-pane') as HTMLElement | null;
            if (scrollEl) {
              scrollEl.scrollTop -= dy;
              scrollEl.scrollLeft -= dx;
            }
          } else {
            this.view = this.applyBounds({
              ...this.view,
              tx: this.view.tx + dx,
              ty: this.view.ty + dy,
            });
            this.invalidate();
          }
          this.panLast = { x: e.clientX, y: e.clientY };
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

  /** True if this event predates the pointerdown of the current session (stale, same reused id). */
  private isStaleForSession(e: PointerEvent) {
    return this.activeId === e.pointerId && this.activeSessionToken > 0 && e.timeStamp < this.sessionStartTs;
  }

  private onUp = (e: PointerEvent) => {
    if (this.palmIds.delete(e.pointerId)) return;
    if (this.isStaleForSession(e)) return;
    this.touches.delete(e.pointerId);
    this.debugCounters.up++;
    if (this.touches.size < 2) {
      if (this.navLast) {
        if (this.opts.disableCanvasPanWheel && this.opts.onPinchZoom) {
          this.opts.onPinchZoom(1, true);
        } else if (Math.abs(this.getRelativeScale() - 1) <= 0.05) {
          this.snapToFitWidth();
        }
      }
      this.navLast = null;
      this.rulerTwoFinger = null;
    }
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.lastPenUp = performance.now();
    }
    if (e.pointerId !== this.activeId || this.activeSessionToken <= 0) return;
    this.debugCounters.completed++;
    writingDiagnostics.record({
      surfaceId: this.diagnosticId,
      type: 'up',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      pressure: e.pressure,
      sessionToken: this.activeSessionToken,
    });
    const mode = this.mode;
    this.activeId = null;
    this.activeSessionToken = 0;
    clearTimeout(this.holdTimer);
    if (this.rulerDrag) {
      this.rulerDrag = null;
      this.liveDirty = true;
      this.schedule();
      return;
    }
    if (this.imageDrag) {
      const prev = { ...this.imageDrag.img, bounds: { ...this.imageDrag.initialBounds } };
      const next = { ...this.imageDrag.img, bounds: { ...this.imageDrag.img.bounds }, revision: this.imageDrag.img.revision + 1 };
      this.imageDrag = null;
      if (
        Math.abs(next.bounds.x0 - prev.bounds.x0) > 0.5 ||
        Math.abs(next.bounds.y0 - prev.bounds.y0) > 0.5 ||
        Math.abs(next.bounds.x1 - prev.bounds.x1) > 0.5 ||
        Math.abs(next.bounds.y1 - prev.bounds.y1) > 0.5
      ) {
        this.opts.onImageCommit?.(prev, next);
      }
      this.liveDirty = true;
      this.schedule();
      return;
    }
    switch (mode) {
      case 'ink':
        // Append the real pointerup endpoint if it moved from the last recorded sample
        if (this.buf && this.buf.length > 0 && !this.snappedShape) {
          this.addSamples([e]);
        }
        this.finishInk();
        break;
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
    if (this.palmIds.delete(e.pointerId)) return;
    if (this.isStaleForSession(e)) return;
    this.touches.delete(e.pointerId);
    this.debugCounters.cancel++;
    if (this.touches.size < 2) {
      if (this.navLast) {
        if (this.opts.disableCanvasPanWheel && this.opts.onPinchZoom) {
          this.opts.onPinchZoom(1, true);
        } else if (Math.abs(this.getRelativeScale() - 1) <= 0.05) {
          this.snapToFitWidth();
        }
      }
      this.navLast = null;
      this.rulerTwoFinger = null;
    }
    if (e.pointerType === 'pen' && (this.activeId === null || this.activeId === e.pointerId)) {
      this.penDown = false;
      this.lastPenUp = performance.now();
    }
    // Only cancel the session if the event belongs to the current active pointer
    if (e.pointerId === this.activeId) {
      writingDiagnostics.record({
        surfaceId: this.diagnosticId,
        type: 'cancel',
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        pressure: e.pressure,
        sessionToken: this.activeSessionToken,
      });
      this.cancelSession();
    }
  };

  private onLostPointerCapture = (e: PointerEvent) => {
    // A normal release of an already-finalized session is ignored (activeId was cleared on pointerup).
    if (e.pointerId !== this.activeId || this.activeSessionToken <= 0) return;
    // Stale loss from an earlier session that reused this pointerId: the new session started after it,
    // or the new session currently still holds capture.
    if (e.timeStamp < this.sessionStartTs) return;
    try {
      if (this.live.hasPointerCapture?.(e.pointerId)) return;
    } catch {
      /* synthetic pointer */
    }
    this.debugCounters.lostCapture++;
    writingDiagnostics.record({
      surfaceId: this.diagnosticId,
      type: 'lostcapture',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      pressure: e.pressure,
      sessionToken: this.activeSessionToken,
      reason: 'genuine-lost-pointer-capture',
    });
    this.onCancel(e);
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
    if (this.imageDrag) {
      this.imageDrag.img.bounds = { ...this.imageDrag.initialBounds };
      this.imageDrag = null;
    }
    clearTimeout(this.holdTimer);
    this.snappedShape = null;
    this.rulerDrag = null;
    this.rulerTwoFinger = null;
    this.activeId = null;
    this.activeSessionToken = 0;
    this.buf = null;
    this.stabilizerFilter = null;
    this.activeStrokeRect = null;
    this.activeStrokeView = null;
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
    this.stabilizerFilter = null;
    this.activeStrokeRect = null;
    this.activeStrokeView = null;
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
    const isCompat = !hl && tool.nib === 'ballpoint' && tool.ballpointModel === 'compatibility';
    this.opts.onStroke({
      kind: 'stroke',
      id: crypto.randomUUID(),
      pageId: this.page.id,
      layerId: this.opts.activeLayerId() ?? this.page.layerIds[0],
      tool: hl ? 'highlighter' : tool.nib,
      ballpointModel: isCompat ? 'compatibility' : 'normal',
      streamline: this.smoothing(tool),
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
    this.navLast = m;
    if (this.opts.disableCanvasPanWheel && this.opts.onPinchZoom) {
      if (last.d > 4) {
        this.opts.onPinchZoom(m.d / last.d, false);
      }
      return;
    }
    let v: ViewMatrix = { ...this.view, tx: this.view.tx + (m.cx - last.cx), ty: this.view.ty + (m.cy - last.cy) };
    if (last.d > 4) v = zoomAbout(v, m.cx, m.cy, v.scale * (m.d / last.d));
    this.commitView(v);
  }
  /** Single entry point for gesture-driven view changes: validate bounds, notify, repaint. */
  private commitView(v: ViewMatrix) {
    this.view = this.applyBounds(v);
    this.opts.onViewChange?.(this.view, this.getRelativeScale());
    this.invalidate();
  }
  private onWheel = (e: WheelEvent) => {
    if (this.opts.disableCanvasPanWheel && !e.ctrlKey && !e.metaKey) {
      return;
    }
    e.preventDefault();
    const r = this.rect();
    if (e.ctrlKey || e.metaKey) {
      this.commitView(zoomAbout(this.view, e.clientX - r.left, e.clientY - r.top, this.view.scale * Math.exp(-e.deltaY * 0.01)));
    } else {
      this.commitView({ ...this.view, tx: this.view.tx - e.deltaX, ty: this.view.ty - e.deltaY });
    }
  };
}
