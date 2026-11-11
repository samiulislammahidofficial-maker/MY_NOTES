export const SWIPE_ADD_THRESHOLD_PX = 80;
export const SWIPE_MAX_PULL_PX = 128;
export const SWIPE_MIN_DURATION_MS = 80;

export type SwipeAddState = 'idle' | 'dragging' | 'armed';

export interface SwipeAddSnapshot {
  state: SwipeAddState;
  pointerId: number | null;
  pullPx: number;
  progress: number;
  label: 'Swipe up to add a page' | 'Release to add';
}

export interface SwipeStartContext {
  pointerId: number;
  pointerType: string;
  clientY: number;
  timeStamp: number;
  activeTouchCount: number;
  penDown: boolean;
  rulerDragging: boolean;
}

/**
 * Pure state machine for the deliberate "Swipe up to add a page" bottom-edge handle.
 * - Rejects pen strokes, multi-touch pinch/palm contacts, taps, and short bounces.
 * - Requires upward drag >= SWIPE_ADD_THRESHOLD_PX (82 CSS px) and duration >= SWIPE_MIN_DURATION_MS.
 * - Guarantees at-most-once commit per gesture and resets cleanly after release or cancel.
 */
export class SwipeToAddController {
  private state: SwipeAddState = 'idle';
  private pointerId: number | null = null;
  private startY = 0;
  private startTime = 0;
  private pullPx = 0;
  private gestureId = 0;
  private gestureCommitted = false;

  getSnapshot(): SwipeAddSnapshot {
    const progress = Math.max(0, Math.min(1, this.pullPx / SWIPE_ADD_THRESHOLD_PX));
    return {
      state: this.state,
      pointerId: this.pointerId,
      pullPx: this.pullPx,
      progress,
      label: this.state === 'armed' ? 'Release to add' : 'Swipe up to add a page',
    };
  }

  start(ctx: SwipeStartContext): SwipeAddSnapshot {
    // Reject pen, multi-touch/palm, active pen session, or active ruler manipulation
    if (
      ctx.pointerType === 'pen' ||
      ctx.penDown ||
      ctx.rulerDragging ||
      ctx.activeTouchCount > 1 ||
      this.state !== 'idle'
    ) {
      this.cancel();
      return this.getSnapshot();
    }
    this.state = 'dragging';
    this.pointerId = ctx.pointerId;
    this.startY = ctx.clientY;
    this.startTime = ctx.timeStamp;
    this.pullPx = 0;
    this.gestureId++;
    this.gestureCommitted = false;
    return this.getSnapshot();
  }

  move(
    pointerId: number,
    clientY: number,
    opts?: { activeTouchCount?: number; penDown?: boolean; rulerDragging?: boolean },
  ): SwipeAddSnapshot {
    if (this.state === 'idle' || pointerId !== this.pointerId) {
      return this.getSnapshot();
    }
    if (opts?.penDown || opts?.rulerDragging || (opts?.activeTouchCount ?? 1) > 1) {
      return this.cancel();
    }
    // Upward swipe means clientY decreases relative to startY
    const dyUp = Math.max(0, this.startY - clientY);
    this.pullPx = Math.min(SWIPE_MAX_PULL_PX, dyUp);
    this.state = this.pullPx >= SWIPE_ADD_THRESHOLD_PX ? 'armed' : 'dragging';
    return this.getSnapshot();
  }

  /**
   * Complete the gesture on pointerup.
   * Returns `true` if and only if a single page should be added.
   */
  end(pointerId: number, timeStamp: number): { shouldAddPage: boolean; snapshot: SwipeAddSnapshot } {
    if (this.state === 'idle' || pointerId !== this.pointerId) {
      return { shouldAddPage: false, snapshot: this.getSnapshot() };
    }
    if (this.gestureCommitted) {
      this.cancel();
      return { shouldAddPage: false, snapshot: this.getSnapshot() };
    }
    const duration = Math.max(0, timeStamp - this.startTime);
    const armed =
      this.state === 'armed' &&
      this.pullPx >= SWIPE_ADD_THRESHOLD_PX &&
      duration >= SWIPE_MIN_DURATION_MS;

    if (armed) {
      this.gestureCommitted = true;
    }
    this.cancel();
    return { shouldAddPage: armed, snapshot: this.getSnapshot() };
  }

  cancel(): SwipeAddSnapshot {
    this.state = 'idle';
    this.pointerId = null;
    this.startY = 0;
    this.startTime = 0;
    this.pullPx = 0;
    return this.getSnapshot();
  }
}
