import { SAMPLE_STRIDE } from '../domain/types';

/** Use nonempty coalesced events when available, else the event itself (never duplicated). */
export function expandEvents<T extends { getCoalescedEvents?: () => T[] }>(e: T): T[] {
  const c = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : undefined;
  return c && c.length > 0 ? c : [e];
}

/**
 * Pressure for a sample:
 * - Preserves valid zero pressure (`pressure === 0`) when the pen reports a real zero or lift-off taper,
 *   while falling back to `fallback` only when pressure is negative/NaN or from mouse/touch without pressure hardware.
 * - For pen contact where browser reports exactly `0` on `pointerdown` because hardware pressure is unsupported,
 *   `isUnsupportedPenZero` can be passed to use `fallback`.
 */
export function resolvePressure(
  pointerType: string,
  pressure: number,
  fallback = 0.5,
  allowZeroPenPressure = false,
): number {
  if (pointerType === 'pen') {
    if (!Number.isFinite(pressure) || pressure < 0) return fallback;
    if (pressure === 0) return allowZeroPenPressure ? 0 : fallback;
    return Math.min(1, pressure);
  }
  return fallback;
}

/**
 * Lightweight 1D One-Euro adaptive low-pass filter for low-latency handwriting stabilization.
 * Reduces slow-line jitter while keeping fast curves responsive with near-zero lag.
 */
export class OneEuroFilter1D {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(
    private minCutoff = 1.6,
    private beta = 0.035,
    private dCutoff = 1.0,
  ) {}

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  private alpha(cutoff: number, dtSec: number): number {
    const tau = 1 / (2 * Math.PI * Math.max(1e-4, cutoff));
    return 1 / (1 + tau / Math.max(1e-4, dtSec));
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dtMs = tMs - this.tPrev;
    // Guard against duplicate or negative timestamps while advancing state cleanly
    if (dtMs <= 0.25) {
      const xHat = this.xPrev + (x - this.xPrev) * 0.5;
      this.xPrev = xHat;
      this.tPrev = Math.max(this.tPrev, tMs);
      return xHat;
    }
    const dtSec = Math.min(0.1, dtMs / 1000);
    this.tPrev = tMs;

    const dx = (x - this.xPrev) / dtSec;
    const edx = this.dxPrev + this.alpha(this.dCutoff, dtSec) * (dx - this.dxPrev);
    this.dxPrev = edx;

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const a = this.alpha(cutoff, dtSec);
    const xHat = this.xPrev + a * (x - this.xPrev);
    this.xPrev = xHat;
    return xHat;
  }
}

export function normalizeCoalescedTimestamps(
  evs: ReadonlyArray<{ timeStamp?: number }>,
  lastTMs: number | null,
  t0: number,
): number[] {
  const n = evs.length;
  if (n === 0) return [];
  const raw = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const ts = evs[i]?.timeStamp;
    raw[i] = typeof ts === 'number' && Number.isFinite(ts) ? ts - t0 : (lastTMs ?? 0);
  }
  const out = new Array<number>(n);
  let prevT = lastTMs;
  let i = 0;
  while (i < n) {
    const v = raw[i];
    let runEnd = i;
    while (runEnd + 1 < n && Math.abs(raw[runEnd + 1] - v) <= 0.05) {
      runEnd++;
    }
    const count = runEnd - i + 1;
    if (prevT === null) {
      for (let j = 0; j < count; j++) {
        out[i + j] = v + j * 0.5;
      }
    } else if (v > prevT + 0.25) {
      const span = v - prevT;
      for (let j = 0; j < count; j++) {
        out[i + j] = prevT + ((j + 1) / count) * span;
      }
    } else {
      for (let j = 0; j < count; j++) {
        out[i + j] = prevT + (j + 1) * 2.0;
      }
    }
    prevT = out[runEnd];
    i = runEnd + 1;
  }
  return out;
}

function oneEuroAlpha(cutoff: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSec);
}

/**
 * Isotropic 2D One-Euro stabilizer.
 * Uses scalar vector speed |v| so X and Y always share the same smoothing cutoff,
 * eliminating diagonal axis lag and sideways spikes while keeping corners crisp.
 */
export class StrokeStabilizer {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private xPrev: number | null = null;
  private yPrev: number | null = null;
  private dxPrev = 0;
  private dyPrev = 0;
  private tPrev: number | null = null;
  private pPrev: number | null = null;

  constructor(readonly level: 'off' | 'low' | 'medium' = 'low') {
    if (level === 'low') {
      this.minCutoff = 2.6;
      this.beta = 0.045;
      this.dCutoff = 1.4;
    } else if (level === 'medium') {
      this.minCutoff = 1.55;
      this.beta = 0.028;
      this.dCutoff = 1.1;
    } else {
      this.minCutoff = 0;
      this.beta = 0;
      this.dCutoff = 1;
    }
  }

  filterSample(
    x: number,
    y: number,
    p: number,
    tMs: number,
    viewScale = 1,
  ): { x: number; y: number; p: number } {
    const outP = this.pPrev === null ? p : this.pPrev * 0.35 + p * 0.65;
    this.pPrev = outP;
    if (this.level === 'off') {
      return { x, y, p: outP };
    }
    if (this.xPrev === null || this.yPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.yPrev = y;
      this.tPrev = tMs;
      return { x, y, p: outP };
    }
    const dtMs = tMs - this.tPrev;
    if (dtMs <= 0.25) {
      const xHat = this.xPrev + (x - this.xPrev) * 0.5;
      const yHat = this.yPrev + (y - this.yPrev) * 0.5;
      this.xPrev = xHat;
      this.yPrev = yHat;
      this.tPrev = Math.max(this.tPrev, tMs);
      return { x: xHat, y: yHat, p: outP };
    }
    const dtSec = Math.min(0.1, dtMs / 1000);
    this.tPrev = tMs;

    const vx = (x - this.xPrev) / dtSec;
    const vy = (y - this.yPrev) / dtSec;
    const da = oneEuroAlpha(this.dCutoff, dtSec);
    this.dxPrev = this.dxPrev + da * (vx - this.dxPrev);
    this.dyPrev = this.dyPrev + da * (vy - this.dyPrev);

    const scale = Number.isFinite(viewScale) ? Math.max(0.5, Math.min(4, viewScale)) : 1;
    const speed = Math.hypot(this.dxPrev, this.dyPrev) * scale;
    const cutoff = this.minCutoff + this.beta * speed;
    const a = oneEuroAlpha(cutoff, dtSec);

    const xHat = this.xPrev + a * (x - this.xPrev);
    const yHat = this.yPrev + a * (y - this.yPrev);
    this.xPrev = xHat;
    this.yPrev = yHat;
    return { x: xHat, y: yHat, p: outP };
  }
}

export type InputAction = 'ink' | 'navigate' | 'ignore';

export interface ArbitrationState {
  penOnly: boolean;
  fingerDrawing: boolean;
  penDown: boolean;
  /** ms since last pen-up */
  sincePenUp: number;
  guardMs: number;
  touchCount: number;
}

/**
 * Decide what a newly-started contact does.
 * Pen: ink. Touch while pen is down or within the guard window: ignored (palm).
 * Touch: navigate with 2+ contacts; single touch inks only in finger-drawing mode.
 */
export function arbitrate(pointerType: string, s: ArbitrationState): InputAction {
  if (pointerType === 'pen') return 'ink';
  if (pointerType === 'mouse') return 'ink';
  // While pen is active or within palm guard window, reject finger/palm contact
  if (s.penDown || s.sincePenUp < s.guardMs) return 'ignore';
  if (s.touchCount >= 2) return 'navigate';
  // In Pen-only mode (or whenever finger drawing is off), 1 finger navigates/scrolls
  if (s.penOnly || !s.fingerDrawing) return 'navigate';
  return 'ink';
}

/** Append a sample to a growable Float32 buffer. */
export class SampleBuffer {
  data = new Float32Array(SAMPLE_STRIDE * 256);
  length = 0; // sample count
  push(x: number, y: number, p: number, tx: number, ty: number, t: number) {
    if ((this.length + 1) * SAMPLE_STRIDE > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    const o = this.length * SAMPLE_STRIDE;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = p;
    this.data[o + 3] = tx;
    this.data[o + 4] = ty;
    this.data[o + 5] = t;
    this.length++;
  }
  toArray(): Float32Array {
    return this.data.slice(0, this.length * SAMPLE_STRIDE);
  }
}
