import { SAMPLE_STRIDE } from '../domain/types';

/** Use nonempty coalesced events when available, else the event itself (never duplicated). */
export function expandEvents<T extends { getCoalescedEvents?: () => T[] }>(e: T): T[] {
  const c = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : undefined;
  return c && c.length > 0 ? c : [e];
}

/** Pressure for a sample: real pen pressure when valid, else a configurable constant. */
export function resolvePressure(pointerType: string, pressure: number, fallback = 0.5): number {
  if (pointerType === 'pen' && pressure > 0) return pressure;
  return fallback;
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
