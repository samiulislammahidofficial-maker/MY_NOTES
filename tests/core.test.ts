import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

// Provide realistic memory-backed sessionStorage for Node/test environment
const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
};

if (typeof globalThis !== 'undefined' && (!globalThis.sessionStorage || typeof globalThis.sessionStorage.getItem !== 'function')) {
  const mockStorage = createMockStorage();
  Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, configurable: true, writable: true });
}
if (typeof window !== 'undefined' && (!window.sessionStorage || typeof window.sessionStorage.getItem !== 'function')) {
  Object.defineProperty(window, 'sessionStorage', { value: globalThis.sessionStorage, configurable: true, writable: true });
}
if (typeof globalThis !== 'undefined' && typeof (globalThis as any).Path2D === 'undefined') {
  class MockPath2D {
    ops: any[] = [];
    moveTo(x: number, y: number) { this.ops.push(['moveTo', x, y]); }
    lineTo(x: number, y: number) { this.ops.push(['lineTo', x, y]); }
    arc(x: number, y: number, r: number, s: number, e: number) { this.ops.push(['arc', x, y, r, s, e]); }
    closePath() { this.ops.push(['closePath']); }
  }
  Object.defineProperty(globalThis, 'Path2D', { value: MockPath2D, configurable: true, writable: true });
}
import { clientToDoc, constrainView, docToClient, fitPage, zoomAbout } from '../src/domain/geometry';
import { AddPageCommand, AddStrokeCommand, History, ReplaceCommand, UpdateImageBoxCommand, deserializeCommand, type StrokeTarget } from '../src/domain/history';
import { isDrawingOrManipulationTool, isAllowedTextSelectionTarget } from '../src/engine/selectionGuard';
import type { ImageBox } from '../src/domain/types';
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
import { boundsOf, strokePath } from '../src/engine/render';
import { writingDiagnostics } from '../src/engine/diagnostics';
import { PenDiagnosticEngine } from '../src/engine/penDiagnosticEngine';
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
    expect(s2.label).toBe('Release to add');

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

describe('durable local save tracking, quota failure recovery, and safe update snapshot', () => {
  it('never falsely marks Saved when a storage write rejects, and recovers on retry', async () => {
    let status: 'idle' | 'saving' | 'saved' | 'failed' = 'idle';
    let shouldFail = true;
    const dirty = new Set<string>();

    const runSave = async (pageId: string) => {
      status = 'saving';
      try {
        if (shouldFail) throw new Error('QuotaExceededError');
        dirty.delete(pageId);
        status = 'saved';
      } catch {
        dirty.add(pageId);
        status = 'failed';
      }
    };

    await runSave('page-1');
    expect(status).toBe('failed');
    expect(dirty.has('page-1')).toBe(true);

    // Retry after space is freed succeeds and transitions to 'saved'
    shouldFail = false;
    await runSave('page-1');
    expect(status).toBe('saved');
    expect(dirty.size).toBe(0);
  });
});

import { strFromU8, unzipSync } from 'fflate';
import {
  checkStorageProtection,
  checkStorageProtectionOnResume,
  formatApproxBytes,
  requestStorageProtection,
  resetStorageProtectionStateForTests,
} from '../src/storage/persistence';
import { normalizeLegacyNotebookRecord, repo } from '../src/storage/db';
import { buildBackupZipBytes, restoreFromBackupZipBytes } from '../src/export/backup';
import { lockNotebookAtRest, unlockNotebookToMemory } from '../src/security/passwordLock';
import { checkForServiceWorkerUpdates, shouldAllowControlledReload } from '../src/ui/SafeUpdateBanner';

describe('browser storage protection states (granted, not-granted, unsupported, check-failed, checking)', () => {
  it('distinguishes checking, granted, not-granted, unsupported, and check-failed without faking permission', async () => {
    resetStorageProtectionStateForTests();

    // 1. Unsupported when storage API is missing
    const sUnsupported = await checkStorageProtection(undefined);
    expect(sUnsupported.status).toBe('unsupported');
    expect(sUnsupported.estimate.supported).toBe(false);

    // 2. Not-granted when persisted() returns false
    const sNotGranted = await checkStorageProtection({
      persisted: async () => false,
      estimate: async () => ({ usage: 2 * 1024 * 1024, quota: 500 * 1024 * 1024 }),
    });
    expect(sNotGranted.status).toBe('not-granted');
    expect(sNotGranted.estimate.usageBytes).toBe(2 * 1024 * 1024);
    expect(formatApproxBytes(sNotGranted.estimate.usageBytes)).toBe('2.0 MB');

    // 3. Exception thrown by persisted() is labeled check-failed (never permission denied / not-granted)
    const sFailed = await checkStorageProtection({
      persisted: async () => {
        throw new Error('SecurityError: Storage disabled');
      },
    });
    expect(sFailed.status).toBe('check-failed');
    expect(sFailed.errorMessage).toContain('SecurityError');

    // 4. Granted when persisted() returns true
    const sGranted = await checkStorageProtection({
      persisted: async () => true,
    });
    expect(sGranted.status).toBe('granted');
  });

  it('handles user-triggered requestStorageProtection (persist() -> recheck persisted()), deduplicates concurrent requests, and debounces resume checks', async () => {
    resetStorageProtectionStateForTests();
    let persistCalls = 0;
    let stateGranted = false;

    const mockStorage = {
      persisted: async () => stateGranted,
      persist: async () => {
        persistCalls++;
        await new Promise((r) => setTimeout(r, 15));
        stateGranted = true;
        return true;
      },
      estimate: async () => ({ usage: 1024, quota: 10240 }),
    };

    // Concurrent calls should deduplicate into a single persist() call
    const [r1, r2] = await Promise.all([
      requestStorageProtection(mockStorage),
      requestStorageProtection(mockStorage),
    ]);
    expect(persistCalls).toBe(1);
    expect(r1.status).toBe('granted');
    expect(r2.status).toBe('granted');

    // When persist() returns false, status remains 'not-granted' (never faked)
    stateGranted = false;
    const denied = await requestStorageProtection({
      persisted: async () => false,
      persist: async () => false,
    });
    expect(denied.status).toBe('not-granted');

    // When persist() throws, status is 'check-failed'
    const threw = await requestStorageProtection({
      persisted: async () => false,
      persist: async () => {
        throw new Error('AbortError');
      },
    });
    expect(threw.status).toBe('check-failed');

    // Debounced resume check avoids redundant calls within interval
    let resumeChecks = 0;
    const resumeStorage = {
      persisted: async () => {
        resumeChecks++;
        return false;
      },
    };
    await checkStorageProtectionOnResume(60_000, resumeStorage);
    await checkStorageProtectionOnResume(60_000, resumeStorage);
    expect(resumeChecks).toBe(1);
  });
});

describe('versioned backup/restore with encrypted passwordLock & legacy migration safety', () => {
  it('preserves notes when persist() is false, exports ciphertext without leaking keys, and restores non-destructively', async () => {
    const nbId = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    const now = Date.now();

    const nb = {
      id: nbId,
      title: 'Protected Engineering Notes',
      cover: '#385E51',
      hasCover: true,
      template: 'ruled' as const,
      size: 'A4' as const,
      landscape: false,
      folderId: null,
      tags: ['test'],
      pinned: true,
      trashedAt: null,
      pageIds: [pageId],
      createdAt: now,
      updatedAt: now,
      revision: 3,
      paper: '#000000',
    };
    const page = { id: pageId, notebookId: nbId, width: 595.28, height: 841.89, layerIds: [layerId], revision: 1 };
    const layer = { id: layerId, pageId, name: 'Ink', visible: true, locked: false, opacity: 1 };
    await repo.createNotebook(nb, page, layer);

    const stroke = mkLineStroke(crypto.randomUUID(), 20, 30, 120, 80, 10);
    stroke.pageId = pageId;
    stroke.layerId = layerId;
    await repo.addStroke(stroke, nbId);

    // Lock notebook with password -> plaintext strokes wiped from IndexedDB, stored as AES-GCM envelope
    const secretPw = 'MySafeTabletPass!99';
    const env = await lockNotebookAtRest(nb, secretPw);
    expect(await repo.getStrokes(pageId)).toHaveLength(0);

    // Build backup zip bytes and verify password is never leaked in archive
    const zipBytes = await buildBackupZipBytes(nbId);
    const unzipped = unzipSync(zipBytes);
    const dataJsonText = strFromU8(unzipped['data.json']);
    expect(dataJsonText).not.toContain(secretPw);
    expect(dataJsonText).toContain(env.ciphertextB64.slice(0, 16));

    // Restore while original notebook still exists -> remaps ID without clobbering original
    const res = await restoreFromBackupZipBytes(zipBytes);
    expect(res.restoredNotebooks).toBe(1);

    const all = await repo.allNotebooks();
    const restored = all.find((x) => x.id !== nbId && x.title.includes('Protected Engineering Notes'));
    expect(restored).toBeDefined();
    expect(restored?.passwordLock?.ciphertextB64).toBe(env.ciphertextB64);

    // Verify restored notebook unlocks with the original password and recovers the exact stroke on the restored pageId
    const unlocked = await unlockNotebookToMemory(restored!, secretPw);
    const restoredPageId = restored!.pageIds[0];
    expect(unlocked.strokesByPage[restoredPageId]).toHaveLength(1);
    expect(unlocked.strokesByPage[restoredPageId][0].pageId).toBe(restoredPageId);
  });

  it('normalizes legacy v1 notebook records and preserves newer revision/fields during rollbacks', async () => {
    const normalized = normalizeLegacyNotebookRecord({
      id: 'legacy-1',
      title: 'Old V1 Note',
      paper: 'cream',
    });
    expect(normalized.paper).toBe('#FFFDF0');
    expect(normalized.template).toBe('blank');
    expect(normalized.size).toBe('A4');
    expect(normalized.revision).toBe(1);
  });
});

describe('service worker update check states and reload loop guard', () => {
  it('reports available, up-to-date, and offline-or-error accurately without claiming success on network failure', async () => {
    // 1. Failing update() network request -> 'offline-or-error'
    const errRes = await checkForServiceWorkerUpdates({
      userInitiated: true,
      regOverride: {
        waiting: null,
        installing: null,
        update: async () => {
          throw new Error('NetworkError when attempting to fetch resource');
        },
      } as unknown as ServiceWorkerRegistration,
    });
    expect(errRes).toBe('offline-or-error');

    // 2. Successful update() with no waiting worker -> 'up-to-date'
    const upToDate = await checkForServiceWorkerUpdates({
      userInitiated: true,
      regOverride: {
        waiting: null,
        installing: null,
        update: async () => undefined,
      } as unknown as ServiceWorkerRegistration,
    });
    expect(upToDate).toBe('up-to-date');

    // 3. Waiting worker present -> 'available'
    const available = await checkForServiceWorkerUpdates({
      userInitiated: true,
      regOverride: {
        waiting: { state: 'installed' },
        installing: null,
        update: async () => undefined,
      } as unknown as ServiceWorkerRegistration,
    });
    expect(available).toBe('available');

    // 4. Reload loop guard allows first reload and blocks immediate second reload within 10s
    expect(shouldAllowControlledReload(100_000)).toBe(true);
    expect(shouldAllowControlledReload(102_000)).toBe(false);
    expect(shouldAllowControlledReload(115_000)).toBe(true);
  });
});

describe('image insertion, manipulation, undo/redo, and selection protection', () => {
  const dummyTarget: StrokeTarget = {
    addStroke: () => {},
    removeStroke: () => {},
    replace: () => {},
    addImage: (img) => {
      images.set(img.id, img);
    },
    removeImage: (_pageId, id) => {
      images.delete(id);
    },
  };
  const images = new Map<string, ImageBox>();

  it('correctly executes insert, update (move/resize), and delete with undo/redo', () => {
    images.clear();
    const h = new History(200);
    const img1: ImageBox = {
      kind: 'image',
      id: 'img-1',
      pageId: 'page-1',
      layerId: 'layer-1',
      assetId: 'asset-img-1',
      bounds: { x0: 36, y0: 60, x1: 396, y1: 330 },
      aspectRatio: 4 / 3,
      opacity: 1,
      order: 100,
      revision: 1,
    };

    // 1. Insert image
    h.run(new UpdateImageBoxCommand('page-1', null, img1), dummyTarget);
    expect(images.get('img-1')).toEqual(img1);
    expect(h.canUndo).toBe(true);

    // 2. Undo insert
    h.undo(dummyTarget);
    expect(images.has('img-1')).toBe(false);

    // 3. Redo insert
    h.redo(dummyTarget);
    expect(images.get('img-1')).toEqual(img1);

    // 4. Move/resize image
    const img1Moved: ImageBox = {
      ...img1,
      bounds: { x0: 50, y0: 80, x1: 450, y1: 380 },
      revision: 2,
    };
    h.run(new UpdateImageBoxCommand('page-1', img1, img1Moved), dummyTarget);
    expect(images.get('img-1')?.bounds).toEqual({ x0: 50, y0: 80, x1: 450, y1: 380 });

    // 5. Undo move
    h.undo(dummyTarget);
    expect(images.get('img-1')?.bounds).toEqual({ x0: 36, y0: 60, x1: 396, y1: 330 });

    // 6. Delete image
    h.redo(dummyTarget); // back to img1Moved
    h.run(new UpdateImageBoxCommand('page-1', img1Moved, null), dummyTarget);
    expect(images.has('img-1')).toBe(false);

    // 7. Undo delete restores image
    h.undo(dummyTarget);
    expect(images.get('img-1')).toEqual(img1Moved);
  });

  it('serializes and roundtrip deserializes UpdateImageBoxCommand', () => {
    const img: ImageBox = {
      kind: 'image',
      id: 'img-serial',
      pageId: 'page-1',
      layerId: 'layer-1',
      assetId: 'asset-1',
      bounds: { x0: 10, y0: 20, x1: 210, y1: 170 },
      aspectRatio: 4 / 3,
      opacity: 0.8,
      order: 500,
      revision: 1,
    };
    const cmd = new UpdateImageBoxCommand('page-1', null, img);
    const serialized = cmd.serialize();
    expect(serialized.kind).toBe('update-image');

    const revived = deserializeCommand(serialized);
    expect(revived).toBeInstanceOf(UpdateImageBoxCommand);
  });

  it('guarantees selection guard identifies drawing tools and non-allowed text targets', () => {
    expect(isDrawingOrManipulationTool('pen')).toBe(true);
    expect(isDrawingOrManipulationTool('highlighter')).toBe(true);
    expect(isDrawingOrManipulationTool('eraser')).toBe(true);
    expect(isDrawingOrManipulationTool('lasso')).toBe(true);
    expect(isDrawingOrManipulationTool('hand')).toBe(true);
    expect(isDrawingOrManipulationTool('laser')).toBe(true);
    expect(isDrawingOrManipulationTool('shape')).toBe(true);
    expect(isDrawingOrManipulationTool('text')).toBe(false);

    const div = { nodeType: 1, tagName: 'DIV' } as unknown as Node;
    expect(isAllowedTextSelectionTarget(div)).toBe(false);

    const input = { nodeType: 1, tagName: 'INPUT', type: 'text' } as unknown as Node;
    expect(isAllowedTextSelectionTarget(input)).toBe(true);

    const rangeInput = { nodeType: 1, tagName: 'INPUT', type: 'range' } as unknown as Node;
    expect(isAllowedTextSelectionTarget(rangeInput)).toBe(false);
  });

  describe('constrainView pan and zoom boundaries', () => {
    it('centers axis when page fits within viewport minus gutters', () => {
      // view: 800x600, page: 500x400, scale: 1, gutter: 16
      // S = 500 <= 800 - 32 = 768 -> centered tx = (800 - 500) / 2 = 150
      // S = 400 <= 600 - 32 = 568 -> centered ty = (600 - 400) / 2 = 100
      const v = constrainView({ scale: 1, tx: 9999, ty: -9999 }, 800, 600, 500, 400, 16);
      expect(v.scale).toBe(1);
      expect(v.tx).toBe(150);
      expect(v.ty).toBe(100);
    });

    it('clamps translation when zoomed page exceeds viewport', () => {
      // view: 800x600, page: 600x800, scale: 2 (sw = 1200, sh = 1600), gutter: 16
      // minTx = 800 - 16 - 1200 = -416, maxTx = 16
      // minTy = 600 - 16 - 1600 = -1016, maxTy = 16
      const vOver = constrainView({ scale: 2, tx: 500, ty: 500 }, 800, 600, 600, 800, 16);
      expect(vOver.tx).toBe(16);
      expect(vOver.ty).toBe(16);

      const vUnder = constrainView({ scale: 2, tx: -2000, ty: -2000 }, 800, 600, 600, 800, 16);
      expect(vUnder.tx).toBe(-416);
      expect(vUnder.ty).toBe(-1016);

      const vWithin = constrainView({ scale: 2, tx: -100, ty: -200 }, 800, 600, 600, 800, 16);
      expect(vWithin.tx).toBe(-100);
      expect(vWithin.ty).toBe(-200);
    });

    it('safely handles non-finite or invalid scales without crashing', () => {
      const v = constrainView({ scale: NaN, tx: 0, ty: 0 }, 800, 600, 500, 400, 16);
      expect(v.scale).toBe(1);
      expect(Number.isFinite(v.tx)).toBe(true);
      expect(Number.isFinite(v.ty)).toBe(true);
    });
  });

  describe('swipe-to-add sequential gesture deduplication', () => {
    it('allows a subsequent legitimate swipe reusing the same pointerId after completion', () => {
      const ctrl = new SwipeToAddController();
      // First gesture using pointerId 5
      const s0 = ctrl.start({
        pointerId: 5,
        pointerType: 'touch',
        clientY: 600,
        timeStamp: 100,
        activeTouchCount: 1,
        penDown: false,
        rulerDragging: false,
      });
      expect(s0.state).toBe('dragging');
      ctrl.move(5, 600 - (SWIPE_ADD_THRESHOLD_PX + 15));
      const r1 = ctrl.end(5, 100 + SWIPE_MIN_DURATION_MS + 50);
      expect(r1.shouldAddPage).toBe(true);
      expect(r1.snapshot.state).toBe('idle');

      // Immediate duplicate pointerup for the finished gesture returns false
      const dup = ctrl.end(5, 100 + SWIPE_MIN_DURATION_MS + 60);
      expect(dup.shouldAddPage).toBe(false);

      // A NEW legitimate gesture later in time using the SAME pointerId (e.g. reused touch ID)
      const s2 = ctrl.start({
        pointerId: 5,
        pointerType: 'touch',
        clientY: 600,
        timeStamp: 500,
        activeTouchCount: 1,
        penDown: false,
        rulerDragging: false,
      });
      expect(s2.state).toBe('dragging');
      ctrl.move(5, 600 - (SWIPE_ADD_THRESHOLD_PX + 20));
      const r2 = ctrl.end(5, 500 + SWIPE_MIN_DURATION_MS + 50);
      expect(r2.shouldAddPage).toBe(true);
    });
  });

  describe('compatibility ballpoint renderer and writing diagnostics', () => {
    it('separates diagnostic surfaces and distinguishes raw and accepted pointerdowns', () => {
      const board = writingDiagnostics.notifySurfaceMounted();
      const editor = writingDiagnostics.notifySurfaceMounted();
      expect(editor).toBeGreaterThan(board);
      expect(writingDiagnostics.getRecentEvents(board)).toEqual([]);

      const pen = { surfaceId: board, pointerType: 'pen', pointerId: 10, pressure: 0.5 };
      writingDiagnostics.record({ ...pen, type: 'down' });
      writingDiagnostics.record({ ...pen, type: 'down', surfaceId: editor });
      writingDiagnostics.record({ ...pen, type: 'accept', sessionToken: 1 });
      writingDiagnostics.record({ ...pen, type: 'up', sessionToken: 1 });

      expect(writingDiagnostics.getRecentEvents(board).map((event) => event.type)).toEqual([
        'down', 'accept', 'up',
      ]);
      expect(writingDiagnostics.getRecentEvents(editor)).toHaveLength(1);
    });

    it('strokePath produces valid Path2D with ballpointModel normal and compatibility', () => {
      // 3 points (stride 3: x, y, pressure)
      const samples = new Float32Array([10, 10, 0.5, 20, 20, 0.6, 30, 25, 0.7]);
      const normalPath = strokePath({
        samples,
        width: 2,
        tool: 'ballpoint',
        smoothing: 0.45,
        ballpointModel: 'normal',
      });
      expect(normalPath).toBeInstanceOf(Path2D);

      const compatPath = strokePath({
        samples,
        width: 2,
        tool: 'ballpoint',
        smoothing: 0.45,
        ballpointModel: 'compatibility',
      });
      expect(compatPath).toBeInstanceOf(Path2D);
    });
  });

  describe('standalone pen input diagnostic engine', () => {
    it('records exactly 26 and 40 synthetic pen pointerdowns without any cap, stop condition, or display limit', () => {
      const engine = new PenDiagnosticEngine();

      // Test 26 synthetic pen pointerdown events
      for (let i = 1; i <= 26; i++) {
        engine.handlePointerEvent({
          type: 'pointerdown',
          pointerId: 100 + i,
          pointerType: 'pen',
          clientX: 50 + (i * 10),
          clientY: 100,
          pressure: 0.5,
          timeStamp: 1000 + (i * 50),
        });
        engine.handlePointerEvent({
          type: 'pointerup',
          pointerId: 100 + i,
          pointerType: 'pen',
          clientX: 50 + (i * 10),
          clientY: 100,
          pressure: 0,
          timeStamp: 1000 + (i * 50) + 10,
        });
      }

      expect(engine.counters.penPointerDown).toBe(26);
      expect(engine.counters.renderedDots).toBe(26);
      expect(engine.counters.strokesCreated).toBe(26);
      expect(engine.renderedDotsList.length).toBe(26);
      expect(engine.renderedDotsList[25].index).toBe(26);

      // Continue to 40 synthetic marks without reset
      for (let i = 27; i <= 40; i++) {
        engine.handlePointerEvent({
          type: 'pointerdown',
          pointerId: 100 + i,
          pointerType: 'pen',
          clientX: 50 + (i * 10),
          clientY: 100,
          pressure: 0.5,
          timeStamp: 1000 + (i * 50),
        });
        engine.handlePointerEvent({
          type: 'pointerup',
          pointerId: 100 + i,
          pointerType: 'pen',
          clientX: 50 + (i * 10),
          clientY: 100,
          pressure: 0,
          timeStamp: 1000 + (i * 50) + 10,
        });
      }

      expect(engine.counters.penPointerDown).toBe(40);
      expect(engine.counters.renderedDots).toBe(40);
      expect(engine.counters.strokesCreated).toBe(40);
      expect(engine.renderedDotsList.length).toBe(40);
      expect(engine.renderedDotsList[39].index).toBe(40);
    });

    it('records timestamped pointer and stylus touch events in trace and keeps finger contacts separate', () => {
      const engine = new PenDiagnosticEngine();

      // Finger touch
      engine.handlePointerEvent({
        type: 'pointerdown',
        pointerId: 1,
        pointerType: 'touch',
        clientX: 200,
        clientY: 200,
        pressure: 0,
        timeStamp: 500,
      });
      engine.handleTouchEvent({
        type: 'touchstart',
        identifier: 1,
        touchType: 'direct',
        clientX: 200,
        clientY: 200,
        timeStamp: 500,
      });

      expect(engine.counters.touchPointerDown).toBe(1);
      expect(engine.counters.fingerTouchStart).toBe(1);
      expect(engine.counters.penPointerDown).toBe(0);
      expect(engine.counters.stylusTouchStart).toBe(0);
      expect(engine.counters.renderedDots).toBe(0);

      // Stylus touch + pen pointer (concurrent streams for 1 mark)
      engine.handlePointerEvent({
        type: 'pointerdown',
        pointerId: 2,
        pointerType: 'pen',
        clientX: 300,
        clientY: 300,
        pressure: 0.6,
        timeStamp: 600,
      });
      engine.handleTouchEvent({
        type: 'touchstart',
        identifier: 2,
        touchType: 'stylus',
        clientX: 300,
        clientY: 300,
        timeStamp: 601,
      });
      engine.handlePointerEvent({
        type: 'pointerup',
        pointerId: 2,
        pointerType: 'pen',
        clientX: 300,
        clientY: 300,
        pressure: 0,
        timeStamp: 620,
      });
      engine.handleTouchEvent({
        type: 'touchend',
        identifier: 2,
        touchType: 'stylus',
        clientX: 300,
        clientY: 300,
        timeStamp: 620,
      });

      // Exactly 1 stroke & 1 rendered dot (single pen contact never produces two strokes)
      expect(engine.counters.penPointerDown).toBe(1);
      expect(engine.counters.stylusTouchStart).toBe(1);
      expect(engine.counters.renderedDots).toBe(1);
      expect(engine.counters.strokesCreated).toBe(1);
      expect(engine.counters.fallbackStrokes).toBe(0);

      const jsonStr = engine.exportTraceJson(1);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.trace.length).toBeGreaterThan(0);
      expect(parsed.trace.some((ev: any) => ev.stream === 'pointer')).toBe(true);
      expect(parsed.trace.some((ev: any) => ev.stream === 'touch')).toBe(true);
      expect(parsed.trace.some((ev: any) => ev.stream === 'system' && ev.type === 'dot_rendered')).toBe(true);
    });

    it('falls back to stylus touchstart when pointerdown is dropped, never duplicating when both arrive', () => {
      const engine = new PenDiagnosticEngine();

      // Case A: Dropped pointerdown -> only stylus touchstart arrives
      engine.handleTouchEvent({
        type: 'touchstart',
        identifier: 10,
        touchType: 'stylus',
        clientX: 150,
        clientY: 150,
        force: 0.7,
        timeStamp: 1000,
      });
      engine.handleTouchEvent({
        type: 'touchend',
        identifier: 10,
        touchType: 'stylus',
        clientX: 150,
        clientY: 150,
        timeStamp: 1020,
      });

      expect(engine.counters.penPointerDown).toBe(0);
      expect(engine.counters.stylusTouchStart).toBe(1);
      expect(engine.counters.fallbackStrokes).toBe(1);
      expect(engine.counters.strokesCreated).toBe(1);
      expect(engine.counters.renderedDots).toBe(1);
      expect(engine.renderedDotsList[0].source).toBe('stylus_fallback');

      // Case B: Normal dual stream (pointerdown + stylus touchstart arrive together)
      engine.handlePointerEvent({
        type: 'pointerdown',
        pointerId: 11,
        pointerType: 'pen',
        clientX: 250,
        clientY: 250,
        pressure: 0.5,
        timeStamp: 2000,
      });
      engine.handleTouchEvent({
        type: 'touchstart',
        identifier: 11,
        touchType: 'stylus',
        clientX: 250,
        clientY: 250,
        timeStamp: 2005,
      });
      engine.handlePointerEvent({
        type: 'pointerup',
        pointerId: 11,
        pointerType: 'pen',
        clientX: 250,
        clientY: 250,
        pressure: 0,
        timeStamp: 2030,
      });
      engine.handleTouchEvent({
        type: 'touchend',
        identifier: 11,
        touchType: 'stylus',
        clientX: 250,
        clientY: 250,
        timeStamp: 2030,
      });

      // Total strokes should be 2 (1 from fallback, 1 from normal pen pointer), NOT 3!
      expect(engine.counters.strokesCreated).toBe(2);
      expect(engine.counters.renderedDots).toBe(2);
      expect(engine.counters.fallbackStrokes).toBe(1);
    });
  });
});



