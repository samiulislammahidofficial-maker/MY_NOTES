export interface WritingDiagnosticEvent {
  time: number;
  type: 'down' | 'move' | 'up' | 'cancel' | 'lostcapture' | 'reject';
  pointerId: number;
  pointerType: string;
  pressure: number;
  reason?: string;
  sessionToken?: number;
}

export interface WritingDiagnosticStats {
  down: number;
  accepted: number;
  rejected: number;
  completed: number;
  canceled: number;
  lostCapture: number;
  lastGapMs: number;
  minPressure: number;
  maxPressure: number;
  sampleCount: number;
  activePointerType: string;
  activeSessionToken: number;
  surfaceLifecycles: number;
}

const MAX_RING_BUFFER = 200;
const ringBuffer: WritingDiagnosticEvent[] = [];
let lifecycleCounter = 0;

export const writingDiagnostics = {
  record(ev: Omit<WritingDiagnosticEvent, 'time'>) {
    const entry: WritingDiagnosticEvent = { ...ev, time: performance.now() };
    ringBuffer.push(entry);
    if (ringBuffer.length > MAX_RING_BUFFER) {
      ringBuffer.shift();
    }
  },

  getRecentEvents(): readonly WritingDiagnosticEvent[] {
    return ringBuffer;
  },

  clearEvents() {
    ringBuffer.length = 0;
  },

  notifySurfaceMounted(): number {
    return ++lifecycleCounter;
  },

  getLifecycleCount(): number {
    return lifecycleCounter;
  },
};
