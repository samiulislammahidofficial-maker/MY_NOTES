export interface DiagnosticPointerEvent {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
}

export interface DiagnosticTouchEvent {
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel';
  identifier: number;
  touchType?: string;
  clientX: number;
  clientY: number;
  force?: number;
  timeStamp: number;
}

export type TraceEvent =
  | ({ stream: 'pointer' } & DiagnosticPointerEvent)
  | ({ stream: 'touch' } & DiagnosticTouchEvent)
  | {
      stream: 'system';
      type: 'dot_rendered' | 'stroke_started' | 'stroke_ended' | 'stroke_fallback';
      source: 'pointer' | 'stylus_fallback';
      dotIndex: number;
      x: number;
      y: number;
      timeStamp: number;
    };

export interface DiagnosticCounters {
  penPointerDown: number;
  penPointerMove: number;
  penPointerUp: number;
  penPointerCancel: number;
  touchPointerDown: number;
  stylusTouchStart: number;
  stylusTouchEnd: number;
  stylusTouchCancel: number;
  fingerTouchStart: number;
  strokesCreated: number;
  renderedDots: number;
  fallbackStrokes: number;
  lostContactsWithoutEvents: number;
}

export class PenDiagnosticEngine {
  counters: DiagnosticCounters = {
    penPointerDown: 0,
    penPointerMove: 0,
    penPointerUp: 0,
    penPointerCancel: 0,
    touchPointerDown: 0,
    stylusTouchStart: 0,
    stylusTouchEnd: 0,
    stylusTouchCancel: 0,
    fingerTouchStart: 0,
    strokesCreated: 0,
    renderedDots: 0,
    fallbackStrokes: 0,
    lostContactsWithoutEvents: 0,
  };

  trace: TraceEvent[] = [];
  renderedDotsList: Array<{ x: number; y: number; index: number; source: string; timeStamp: number }> = [];

  // Active pen pointer tracking
  private activePenPointerId: number | null = null;
  private penDownHandledForTouch = new Map<number, number>(); // touch identifier -> timestamp
  private recentPointerTimes: number[] = [];

  onRenderDot?: (dot: { x: number; y: number; index: number; source: string; pressure: number }) => void;

  reset() {
    this.counters = {
      penPointerDown: 0,
      penPointerMove: 0,
      penPointerUp: 0,
      penPointerCancel: 0,
      touchPointerDown: 0,
      stylusTouchStart: 0,
      stylusTouchEnd: 0,
      stylusTouchCancel: 0,
      fingerTouchStart: 0,
      strokesCreated: 0,
      renderedDots: 0,
      fallbackStrokes: 0,
      lostContactsWithoutEvents: 0,
    };
    this.trace = [];
    this.renderedDotsList = [];
    this.activePenPointerId = null;
    this.penDownHandledForTouch.clear();
    this.recentPointerTimes = [];
  }

  handlePointerEvent(e: DiagnosticPointerEvent) {
    this.trace.push({ stream: 'pointer', ...e });

    if (e.pointerType === 'pen') {
      if (e.type === 'pointerdown') {
        this.counters.penPointerDown++;
        this.activePenPointerId = e.pointerId;
        this.recentPointerTimes.push(e.timeStamp);
        if (this.recentPointerTimes.length > 50) this.recentPointerTimes.shift();

        // Register stroke & dot
        this.registerStrokeAndDot(e.clientX, e.clientY, e.pressure, 'pointer', e.timeStamp);
      } else if (e.type === 'pointermove') {
        this.counters.penPointerMove++;
      } else if (e.type === 'pointerup') {
        this.counters.penPointerUp++;
        if (this.activePenPointerId === e.pointerId) {
          this.activePenPointerId = null;
          this.trace.push({
            stream: 'system',
            type: 'stroke_ended',
            source: 'pointer',
            dotIndex: this.counters.renderedDots,
            x: e.clientX,
            y: e.clientY,
            timeStamp: e.timeStamp,
          });
        }
      } else if (e.type === 'pointercancel') {
        this.counters.penPointerCancel++;
        if (this.activePenPointerId === e.pointerId) {
          this.activePenPointerId = null;
        }
      }
    } else if (e.pointerType === 'touch') {
      if (e.type === 'pointerdown') {
        this.counters.touchPointerDown++;
      }
    }
  }

  handleTouchEvent(e: DiagnosticTouchEvent) {
    this.trace.push({ stream: 'touch', ...e });

    const isStylus = e.touchType === 'stylus';

    if (isStylus) {
      if (e.type === 'touchstart') {
        this.counters.stylusTouchStart++;

        // Deduplication & fallback check:
        // A single physical pen tap on iPad emits BOTH touchstart (touchType: 'stylus')
        // AND pointerdown (pointerType: 'pen').
        // Check if a pointerdown with pointerType 'pen' already occurred within the matching window (±35ms)
        const matchedRecentPointer = this.recentPointerTimes.some(
          (t) => Math.abs(t - e.timeStamp) <= 35
        );

        if (!matchedRecentPointer) {
          // If no pen pointerdown occurred, this stylus touchstart is a candidate for fallback.
          // Store it so if pointerdown never arrives (e.g. lost/swallowed), fallback can recover it.
          this.penDownHandledForTouch.set(e.identifier, e.timeStamp);
          // Fallback recovers stroke:
          this.counters.fallbackStrokes++;
          this.registerStrokeAndDot(e.clientX, e.clientY, e.force ?? 0.5, 'stylus_fallback', e.timeStamp);
        } else {
          this.penDownHandledForTouch.set(e.identifier, e.timeStamp);
        }
      } else if (e.type === 'touchend') {
        this.counters.stylusTouchEnd++;
        this.penDownHandledForTouch.delete(e.identifier);
      } else if (e.type === 'touchcancel') {
        this.counters.stylusTouchCancel++;
        this.penDownHandledForTouch.delete(e.identifier);
      }
    } else {
      if (e.type === 'touchstart') {
        this.counters.fingerTouchStart++;
      }
    }
  }

  private registerStrokeAndDot(
    x: number,
    y: number,
    pressure: number,
    source: 'pointer' | 'stylus_fallback',
    timeStamp: number
  ) {
    this.counters.strokesCreated++;
    this.counters.renderedDots++;
    const dotIndex = this.counters.renderedDots;

    this.renderedDotsList.push({ x, y, index: dotIndex, source, timeStamp });

    this.trace.push({
      stream: 'system',
      type: source === 'pointer' ? 'stroke_started' : 'stroke_fallback',
      source,
      dotIndex,
      x,
      y,
      timeStamp,
    });

    this.trace.push({
      stream: 'system',
      type: 'dot_rendered',
      source,
      dotIndex,
      x,
      y,
      timeStamp,
    });

    this.onRenderDot?.({ x, y, index: dotIndex, source, pressure });
  }

  exportTraceJson(attemptedMarks?: number): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        attemptedMarks: attemptedMarks ?? null,
        counters: { ...this.counters },
        dotsCount: this.renderedDotsList.length,
        dots: this.renderedDotsList,
        traceEventsCount: this.trace.length,
        trace: this.trace,
      },
      null,
      2
    );
  }
}
