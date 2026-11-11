import { describe, expect, it } from 'vitest';
import { clientToDoc, docToClient, fitPage, zoomAbout } from '../src/domain/geometry';
import { AddPageCommand, AddStrokeCommand, History, ReplaceCommand, type StrokeTarget } from '../src/domain/history';
import { SampleBuffer, arbitrate, expandEvents, resolvePressure } from '../src/engine/input';
import {
  eraseCircle,
  fitShape,
  hitTestRuler,
  insideFraction,
  pointInPolygon,
  shapePoints,
  snapRulerAngle,
  snapToRuler,
  strokeHitsCircle,
  transformStroke,
} from '../src/engine/hit';
import {
  SWIPE_ADD_THRESHOLD_PX,
  SWIPE_MIN_DURATION_MS,
  SwipeToAddController,
} from '../src/engine/swipeAddPage';
import { detectScribble } from '../src/engine/scribble';
import { boundsOf } from '../src/engine/render';
import { SAMPLE_STRIDE, type InkStroke } from '../src/domain/types';

const rect = { left: 40, top: 20 };

describe('coordinates', () => {
  for (const scale of [0.25, 1, 4]) {
    it(`round-trips at ${scale * 100}%`, () => {
      const v = { scale, tx: 13.5, ty: -77 };
      const d = clientToDoc(300, 400, rect, v);
      const c = docToClient(d.x, d.y, rect, v);
      expect(c.x).toBeCloseTo(300, 6);
      expect(c.y).toBeCloseTo(400, 6);
    });
  }
  it('zoomAbout keeps the anchor document point fixed', () => {
    const v = { scale: 1, tx: 10, ty: 20 };
    const before = clientToDoc(200, 150, { left: 0, top: 0 }, v);
    const z = zoomAbout(v, 200, 150, 2.5);
    const after = clientToDoc(200, 150, { left: 0, top: 0 }, z);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
  it('fitPage centres the page', () => {
    const v = fitPage(1000, 800, 500, 400, 0);
    expect(v.scale).toBe(2);
    expect(v.tx).toBe(0);
  });
});

const mk = (id: string): InkStroke => ({
  kind: 'stroke', id, pageId: 'p', layerId: 'l', tool: 'ballpoint', color: '#fff', width: 1, opacity: 1,
  samples: new Float32Array(6), bounds: { x0: 0, y0: 0, x1: 1, y1: 1 }, order: 0, revision: 1,
});

function memTarget() {
  const list: string[] = [];
  const t: StrokeTarget = {
    addStroke: (s) => void list.push(s.id),
    removeStroke: (_p, id) => void list.splice(list.indexOf(id), 1),
    replace: (_p, rm, add) => { for (const r of rm) list.splice(list.indexOf(r.id), 1); for (const a of add) list.push(a.id); },
  };
  return { list, t };
}

describe('commands', () => {
  it('undo/redo are inverses', () => {
    const { list, t } = memTarget();
    const h = new History();
    h.run(new AddStrokeCommand(mk('a')), t);
    h.run(new AddStrokeCommand(mk('b')), t);
    h.undo(t);
    expect(list).toEqual(['a']);
    h.redo(t);
    expect(list).toEqual(['a', 'b']);
  });
  it('ignores duplicate completion of the same stroke', () => {
    const { list, t } = memTarget();
    const h = new History();
    expect(h.run(new AddStrokeCommand(mk('a')), t, 'a')).toBe(true);
    expect(h.run(new AddStrokeCommand(mk('a')), t, 'a')).toBe(false);
    expect(list).toEqual(['a']);
  });
  it('new edit clears redo', () => {
    const { t } = memTarget();
    const h = new History();
    h.run(new AddStrokeCommand(mk('a')), t);
    h.undo(t);
    h.run(new AddStrokeCommand(mk('b')), t);
    expect(h.canRedo).toBe(false);
  });
});

describe('input', () => {
  it('uses coalesced events when present, else the event itself', () => {
    const a: any = { id: 1 };
    const b: any = { id: 2, getCoalescedEvents: () => [] };
    const c: any = { id: 3, getCoalescedEvents: () => [{ id: 4 }, { id: 5 }] };
    expect(expandEvents(a)).toEqual([a]);
    expect(expandEvents(b)).toEqual([b]);
    expect(expandEvents(c).map((e: any) => e.id)).toEqual([4, 5]);
  });
  it('pressure defaults', () => {
    expect(resolvePressure('mouse', 0.5, 0.7)).toBe(0.7);
    expect(resolvePressure('touch', 1, 0.4)).toBe(0.4);
    expect(resolvePressure('pen', 0.8)).toBe(0.8);
    expect(resolvePressure('pen', 0, 0.5)).toBe(0.5);
  });
  const base = { penOnly: true, fingerDrawing: false, penDown: false, sincePenUp: 1e6, guardMs: 250, touchCount: 1 };
  it('pen-only rejects single finger ink', () => {
    expect(arbitrate('touch', base)).toBe('navigate');
    expect(arbitrate('touch', { ...base, touchCount: 0 })).toBe('ignore');
    expect(arbitrate('pen', base)).toBe('ink');
  });
  it('palm while pen down or in guard window is ignored', () => {
    expect(arbitrate('touch', { ...base, penDown: true, touchCount: 2 })).toBe('ignore');
    expect(arbitrate('touch', { ...base, sincePenUp: 50, touchCount: 2 })).toBe('ignore');
  });
  it('two fingers navigate, finger drawing inks single touch', () => {
    expect(arbitrate('touch', { ...base, penOnly: false, touchCount: 2 })).toBe('navigate');
    expect(arbitrate('touch', { ...base, penOnly: false, fingerDrawing: true })).toBe('ink');
  });
  it('SampleBuffer grows and packs', () => {
    const b = new SampleBuffer();
    for (let i = 0; i < 1000; i++) b.push(i, i, 0.5, 0, 0, i);
    expect(b.length).toBe(1000);
    expect(b.toArray()[6 * 999]).toBe(999);
  });
});

function mkLineStroke(id: string, x0: number, y0: number, x1: number, y1: number, steps = 20): InkStroke {
  const samples = new Float32Array((steps + 1) * SAMPLE_STRIDE);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    samples.set([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.5, 0, 0, i * 10], i * SAMPLE_STRIDE);
  }
  return {
    kind: 'stroke', id, pageId: 'p', layerId: 'l', tool: 'ballpoint', color: '#fff', width: 2, opacity: 1,
    samples, bounds: boundsOf(samples, 2), order: 0, revision: 1,
  };
}

describe('phase 2: lasso, eraser, shapes, scribble, zoom-window', () => {
  it('pointInPolygon and insideFraction select strokes inside polygon', () => {
    const poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(pointInPolygon(50, 50, poly)).toBe(true);
    expect(pointInPolygon(150, 50, poly)).toBe(false);
    const sIn = mkLineStroke('s1', 10, 20, 90, 80);
    const sOut = mkLineStroke('s2', 110, 20, 190, 80);
    expect(insideFraction(sIn, poly)).toBe(1);
    expect(insideFraction(sOut, poly)).toBe(0);
  });

  it('pixel erase splits a stroke into two fragments and Undo restores original', () => {
    const s = mkLineStroke('orig', 0, 50, 100, 50, 50);
    expect(strokeHitsCircle(s, 50, 50, 6)).toBe(true);
    let seq = 0;
    const frags = eraseCircle(s, 50, 50, 6, () => `frag-${++seq}`);
    expect(frags).not.toBeNull();
    expect(frags!.length).toBe(2);
    const { list, t } = memTarget();
    const h = new History();
    h.run(new AddStrokeCommand(s), t);
    h.run(new ReplaceCommand('Erase', 'p', [s], frags!), t);
    expect(list).toEqual(['frag-1', 'frag-2']);
    h.undo(t);
    expect(list).toEqual(['orig']);
  });

  it('transformStroke scales and translates in document space', () => {
    const s = mkLineStroke('t1', 10, 20, 30, 40, 2);
    const moved = transformStroke(s, 2, 10, 20, 5, -5, 't2');
    expect(moved.samples[0]).toBeCloseTo(15, 5);
    expect(moved.samples[1]).toBeCloseTo(15, 5);
    const last = (moved.samples.length / SAMPLE_STRIDE - 1) * SAMPLE_STRIDE;
    expect(moved.samples[last]).toBeCloseTo(10 + (30 - 10) * 2 + 5, 5);
    expect(moved.width).toBeCloseTo(4, 5);
  });

  it('detectScribble distinguishes dense zig-zag scribble from straight line or single hatch', () => {
    const line = mkLineStroke('l', 0, 0, 120, 0, 40);
    expect(detectScribble(line.samples).isScribble).toBe(false);
    // dense zig-zag with 8 reversals
    const b = new SampleBuffer();
    let t = 0;
    for (let rev = 0; rev < 8; rev++) {
      const xStart = rev % 2 === 0 ? 0 : 60;
      const xEnd = rev % 2 === 0 ? 60 : 0;
      for (let k = 0; k <= 10; k++) {
        const x = xStart + ((xEnd - xStart) * k) / 10;
        b.push(x, rev * 3, 0.5, 0, 0, (t += 8));
      }
    }
    const res = detectScribble(b.toArray());
    expect(res.isScribble).toBe(true);
    expect(res.reversals).toBeGreaterThanOrEqual(5);
  });

  it('fitShape snaps clean lines and rectangles but rejects open S-curves', () => {
    const line = mkLineStroke('l', 10, 10, 150, 30, 30);
    expect(fitShape(line.samples)?.shape).toBe('line');
    const rectPts = shapePoints('rect', { x: 20, y: 20 }, { x: 120, y: 90 });
    const rectBuf = new SampleBuffer();
    rectPts.forEach((p, i) => rectBuf.push(p.x, p.y, 0.5, 0, 0, i * 10));
    expect(fitShape(rectBuf.toArray())?.shape).toBe('rect');
    // open S-curve should not snap
    const sCurve = new SampleBuffer();
    for (let i = 0; i <= 40; i++) {
      const u = (i / 40) * Math.PI * 2;
      sCurve.push(i * 3, Math.sin(u) * 40, 0.5, 0, 0, i * 10);
    }
    expect(fitShape(sCurve.toArray())).toBeNull();
  });

  it('snapToRuler projects nearby points onto the ruler edge', () => {
    const snapped = snapToRuler({ x: 100, y: 105 }, 80, 100, 0, 18);
    expect(snapped.x).toBeCloseTo(100, 5);
    expect(snapped.y).toBeCloseTo(110, 5);
    const far = snapToRuler({ x: 100, y: 150 }, 80, 100, 0, 18);
    expect(far.y).toBeCloseTo(150, 5);
  });

  it('zoom window inverse view matrix maps strokes to exact source rectangle coordinates', () => {
    const zoomRect = { x: 40, y: 120, w: 200, h: 65, scale: 2.5 };
    const zView = { scale: zoomRect.scale, tx: -zoomRect.x * zoomRect.scale, ty: -zoomRect.y * zoomRect.scale };
    const docPt = clientToDoc(50, 25, { left: 0, top: 0 }, zView);
    expect(docPt.x).toBeCloseTo(40 + 50 / 2.5, 6);
    expect(docPt.y).toBeCloseTo(120 + 25 / 2.5, 6);
  });
});

import { detectFontFormat } from '../src/fonts/registry';
import { segmentStrokesIntoLines } from '../src/recognition/segmentation';
import { decryptJsonPayload, encryptJsonPayload } from '../src/security/passwordLock';

describe('phase 3–5: fonts, line segmentation, and AES-GCM password protection', () => {
  it('validates TTF and OTF magic bytes and rejects non-font files', () => {
    const ttf = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    const otf = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0, 0, 0, 0, 0]);
    const bad = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectFontFormat(ttf)).toBe('ttf');
    expect(detectFontFormat(otf)).toBe('otf');
    expect(detectFontFormat(bad)).toBeNull();
  });

  it('segments multi-line handwriting strokes into ordered lines', () => {
    const line1 = mkLineStroke('l1', 20, 40, 180, 42, 10);
    const line2 = mkLineStroke('l2', 20, 120, 180, 122, 10);
    const lines = segmentStrokesIntoLines([line2, line1]);
    expect(lines.length).toBe(2);
    expect(lines[0].strokes[0].id).toBe('l1');
    expect(lines[1].strokes[0].id).toBe('l2');
  });

  it('encrypts and decrypts notebook/page payloads with AES-GCM + PBKDF2 and rejects wrong passwords', async () => {
    const secret = { version: 1, text: 'Top secret personal note', strokes: [1, 2, 3] };
    const env = await encryptJsonPayload('correct-horse-battery', secret);
    expect(env.ciphertextB64).toBeTruthy();
    expect(env.ciphertextB64).not.toContain('Top secret');

    const roundTrip = await decryptJsonPayload<typeof secret>('correct-horse-battery', env);
    expect(roundTrip).toEqual(secret);

    await expect(decryptJsonPayload('wrong-password', env)).rejects.toThrow('Incorrect password.');
  });
});

describe('ruler geometry, angle snapping, and pen-vs-touch arbitration', () => {
  const ruler = { x: 200, y: 200, angle: 0 };

  it('snaps ruler angle near 0°, ±45°, ±90°, ±135°, and 180° unless freeRotate is active', () => {
    const near45 = (46.2 * Math.PI) / 180;
    const s1 = snapRulerAngle(near45);
    expect(s1.snapped).toBe(true);
    expect(s1.deg).toBe(45);

    const free = snapRulerAngle(near45, 2.5, true);
    expect(free.snapped).toBe(false);
    expect(free.deg).toBe(46);

    const near90 = (-88.4 * Math.PI) / 180;
    const s2 = snapRulerAngle(near90);
    expect(s2.snapped).toBe(true);
    expect(s2.deg).toBe(-90);
  });

  it('always treats pen along the ruler edge as straightedge ink (never ruler drag)', () => {
    // Point right on the top graduated edge (y = 200 - 26 = 174)
    const hitPen = hitTestRuler({ x: 210, y: 174 }, 'pen', ruler, 1);
    expect(hitPen).toBe('ink');

    // Even over the central body (outside control capsule), pen inks rather than moving the ruler
    const hitPenBody = hitTestRuler({ x: 120, y: 200 }, 'pen', ruler, 1);
    expect(hitPenBody).toBe('ink');

    // Touch or mouse on the ruler body drags the ruler
    const hitTouchBody = hitTestRuler({ x: 120, y: 200 }, 'touch', ruler, 1);
    expect(hitTouchBody).toBe('move');
  });

  it('detects rotate, reset, and close controls with >= 44px touch targets', () => {
    expect(hitTestRuler({ x: 200 - 34, y: 200 }, 'touch', ruler, 1)).toBe('rotate');
    expect(hitTestRuler({ x: 200 + 18, y: 200 }, 'touch', ruler, 1)).toBe('reset');
    expect(hitTestRuler({ x: 200 + 44, y: 200 }, 'touch', ruler, 1)).toBe('close');
    // Outer ends also rotate for touch/mouse
    expect(hitTestRuler({ x: 200 + 190, y: 200 }, 'touch', ruler, 1)).toBe('rotate');
  });
});

describe('deliberate swipe-to-add-page state machine & AddPageCommand', () => {
  it('commits exactly one page when dragged upward >= threshold and >= min duration', () => {
    const ctrl = new SwipeToAddController();
    const s0 = ctrl.start({
      pointerId: 1,
      pointerType: 'touch',
      clientY: 600,
      timeStamp: 100,
      activeTouchCount: 1,
      penDown: false,
      rulerDragging: false,
    });
    expect(s0.state).toBe('dragging');

    // Short pull below threshold stays 'dragging'
    const s1 = ctrl.move(1, 600 - (SWIPE_ADD_THRESHOLD_PX - 10));
    expect(s1.state).toBe('dragging');
    expect(s1.label).toBe('Swipe up to add a page');

    // Pull beyond threshold arms the handle
    const s2 = ctrl.move(1, 600 - (SWIPE_ADD_THRESHOLD_PX + 12));
    expect(s2.state).toBe('armed');
    expect(s2.label).toBe('Release to add page');

    // Release after sufficient duration commits once
    const res = ctrl.end(1, 100 + SWIPE_MIN_DURATION_MS + 40);
    expect(res.shouldAddPage).toBe(true);
    expect(res.snapshot.state).toBe('idle');

    // Duplicate pointerup for the same pointerId cannot commit a second page
    const dup = ctrl.end(1, 100 + SWIPE_MIN_DURATION_MS + 50);
    expect(dup.shouldAddPage).toBe(false);
  });

  it('rejects pen strokes, multi-touch pinch, ruler manipulation, and short bounces', () => {
    const ctrl = new SwipeToAddController();
    // Pen rejected immediately
    const penSnap = ctrl.start({
      pointerId: 2,
      pointerType: 'pen',
      clientY: 600,
      timeStamp: 0,
      activeTouchCount: 1,
      penDown: true,
      rulerDragging: false,
    });
    expect(penSnap.state).toBe('idle');

    // Multi-touch cancelled mid-gesture
    ctrl.start({
      pointerId: 3,
      pointerType: 'touch',
      clientY: 600,
      timeStamp: 0,
      activeTouchCount: 1,
      penDown: false,
      rulerDragging: false,
    });
    ctrl.move(3, 500);
    const cancelled = ctrl.move(3, 490, { activeTouchCount: 2 });
    expect(cancelled.state).toBe('idle');

    // Fast flick shorter than SWIPE_MIN_DURATION_MS does not add a page
    ctrl.start({
      pointerId: 4,
      pointerType: 'touch',
      clientY: 600,
      timeStamp: 1000,
      activeTouchCount: 1,
      penDown: false,
      rulerDragging: false,
    });
    ctrl.move(4, 500);
    const flick = ctrl.end(4, 1000 + 20);
    expect(flick.shouldAddPage).toBe(false);
  });

  it('AddPageCommand inserts after anchor page and undoes/redoes cleanly', () => {
    const pageOrder = ['p1', 'p2'];
    const t: StrokeTarget = {
      addStroke: () => {},
      removeStroke: () => {},
      replace: () => {},
      insertPage: (_nbId, page, _layer, afterId) => {
        const idx = afterId ? pageOrder.indexOf(afterId) : -1;
        if (idx >= 0) pageOrder.splice(idx + 1, 0, page.id);
        else pageOrder.push(page.id);
      },
      removeAddedPage: (_nbId, pageId) => {
        const idx = pageOrder.indexOf(pageId);
        if (idx >= 0) pageOrder.splice(idx, 1);
      },
    };
    const h = new History();
    const newPage = { id: 'p-mid', notebookId: 'nb1', width: 595, height: 842, layerIds: ['l1'], revision: 1 };
    const newLayer = { id: 'l1', pageId: 'p-mid', name: 'Ink', visible: true, locked: false, opacity: 1 };
    h.run(new AddPageCommand('nb1', newPage, newLayer, 'p1'), t, 'p-mid');
    expect(pageOrder).toEqual(['p1', 'p-mid', 'p2']);

    h.undo(t);
    expect(pageOrder).toEqual(['p1', 'p2']);

    h.redo(t);
    expect(pageOrder).toEqual(['p1', 'p-mid', 'p2']);
  });
});
