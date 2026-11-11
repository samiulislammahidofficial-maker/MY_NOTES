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
    // Guard against duplicate or negative timestamps
    if (dtMs <= 0.05) {
      return this.xPrev + (x - this.xPrev) * 0.5;
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

export class StrokeStabilizer {
  private fx: OneEuroFilter1D | null = null;
  private fy: OneEuroFilter1D | null = null;
  private pPrev: number | null = null;

  constructor(readonly level: 'off' | 'low' | 'medium' = 'low') {
    if (level === 'low') {
      this.fx = new OneEuroFilter1D(2.2, 0.04, 1.0);
      this.fy = new OneEuroFilter1D(2.2, 0.04, 1.0);
    } else if (level === 'medium') {
      this.fx = new OneEuroFilter1D(1.35, 0.025, 1.0);
      this.fy = new OneEuroFilter1D(1.35, 0.025, 1.0);
    }
  }

  filterSample(x: number, y: number, p: number, tMs: number): { x: number; y: number; p: number } {
    const outX = this.fx ? this.fx.filter(x, tMs) : x;
    const outY = this.fy ? this.fy.filter(y, tMs) : y;
    const outP = this.pPrev === null ? p : this.pPrev * 0.35 + p * 0.65;
    this.pPrev = outP;
    return { x: outX, y: outY, p: outP };
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
  if (s.penDown || s.sincePenUp < s.guardMs) return 'ignore';
  if (s.touchCount >= 2) return 'navigate';
  if (s.penOnly) return s.touchCount >= 1 ? 'navigate' : 'ignore';
  return s.fingerDrawing ? 'ink' : 'ignore';
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
