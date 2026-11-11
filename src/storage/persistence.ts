export type PersistenceStatus = 'checking' | 'granted' | 'not-granted' | 'unsupported' | 'check-failed';

export interface StorageEstimateInfo {
  supported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  error?: string;
}

export interface StorageProtectionSnapshot {
  status: PersistenceStatus;
  requestPending: boolean;
  errorMessage: string | null;
  estimate: StorageEstimateInfo;
  lastCheckedAt: number | null;
}

export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

const DEFAULT_SNAPSHOT: StorageProtectionSnapshot = {
  status: 'checking',
  requestPending: false,
  errorMessage: null,
  estimate: {
    supported: false,
    usageBytes: null,
    quotaBytes: null,
  },
  lastCheckedAt: null,
};

let currentSnapshot: StorageProtectionSnapshot = { ...DEFAULT_SNAPSHOT };
const listeners = new Set<(snap: StorageProtectionSnapshot) => void>();
let inFlightCheck: Promise<StorageProtectionSnapshot> | null = null;
let inFlightRequest: Promise<StorageProtectionSnapshot> | null = null;
let lastResumeCheckMs = 0;

function emit(patch: Partial<StorageProtectionSnapshot>): StorageProtectionSnapshot {
  currentSnapshot = { ...currentSnapshot, ...patch };
  for (const fn of listeners) {
    try {
      fn(currentSnapshot);
    } catch {
      /* ignore listener error */
    }
  }
  return currentSnapshot;
}

export function getStorageProtectionSnapshot(): StorageProtectionSnapshot {
  return currentSnapshot;
}

export function subscribeStorageProtection(fn: (snap: StorageProtectionSnapshot) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function defaultStorageManager(): StorageManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.storage as StorageManagerLike | undefined;
}

/**
 * Queries `navigator.storage.estimate()` safely without throwing.
 * Reported values are approximate browser origin storage estimates, not guaranteed disk space.
 */
export async function queryStorageEstimate(
  storage: StorageManagerLike | undefined = defaultStorageManager(),
): Promise<StorageEstimateInfo> {
  if (!storage || typeof storage.estimate !== 'function') {
    return { supported: false, usageBytes: null, quotaBytes: null };
  }
  try {
    const est = await storage.estimate();
    return {
      supported: true,
      usageBytes: typeof est?.usage === 'number' && Number.isFinite(est.usage) ? est.usage : null,
      quotaBytes: typeof est?.quota === 'number' && Number.isFinite(est.quota) ? est.quota : null,
    };
  } catch (err: unknown) {
    return {
      supported: true,
      usageBytes: null,
      quotaBytes: null,
      error: err instanceof Error ? err.message : 'Could not read storage estimate',
    };
  }
}

/**
 * Feature-detects and queries `navigator.storage.persisted()` and `estimate()`.
 * Never calls `persist()` automatically so it does not loop permission prompts.
 * Represents `checking`, `granted`, `not-granted`, `unsupported`, and `check-failed` separately.
 */
export async function checkStorageProtection(
  storage: StorageManagerLike | undefined = defaultStorageManager(),
): Promise<StorageProtectionSnapshot> {
  if (inFlightCheck) return inFlightCheck;

  inFlightCheck = (async () => {
    emit({ status: 'checking', errorMessage: null });

    const estimate = await queryStorageEstimate(storage);

    if (!storage || typeof storage.persisted !== 'function') {
      return emit({
        status: 'unsupported',
        errorMessage: null,
        estimate,
        lastCheckedAt: Date.now(),
      });
    }

    try {
      const persisted = await storage.persisted();
      return emit({
        status: persisted ? 'granted' : 'not-granted',
        errorMessage: null,
        estimate,
        lastCheckedAt: Date.now(),
      });
    } catch (err: unknown) {
      return emit({
        status: 'check-failed',
        errorMessage: err instanceof Error ? err.message : 'Unable to check browser storage protection status',
        estimate,
        lastCheckedAt: Date.now(),
      });
    }
  })().finally(() => {
    inFlightCheck = null;
  });

  return inFlightCheck;
}

/**
 * Debounced recheck for window focus / visibilitychange resume events.
 */
export async function checkStorageProtectionOnResume(
  minIntervalMs = 15_000,
  storage: StorageManagerLike | undefined = defaultStorageManager(),
): Promise<StorageProtectionSnapshot> {
  const now = Date.now();
  if (now - lastResumeCheckMs < minIntervalMs && currentSnapshot.lastCheckedAt !== null) {
    return currentSnapshot;
  }
  lastResumeCheckMs = now;
  return checkStorageProtection(storage);
}

/**
 * User-triggered action to request persistent storage (`navigator.storage.persist()`),
 * followed by a recheck of `navigator.storage.persisted()` and `estimate()`.
 * Disables duplicate requests while one is pending.
 */
export async function requestStorageProtection(
  storage: StorageManagerLike | undefined = defaultStorageManager(),
): Promise<StorageProtectionSnapshot> {
  if (inFlightRequest) return inFlightRequest;

  inFlightRequest = (async () => {
    emit({ requestPending: true, errorMessage: null });

    const estimate = await queryStorageEstimate(storage);

    if (!storage || typeof storage.persist !== 'function') {
      return emit({
        status: typeof storage?.persisted === 'function' ? 'not-granted' : 'unsupported',
        requestPending: false,
        errorMessage: 'This browser does not support requesting persistent storage.',
        estimate,
        lastCheckedAt: Date.now(),
      });
    }

    try {
      const grantedByPersist = await storage.persist();
      let finalGranted = Boolean(grantedByPersist);
      if (typeof storage.persisted === 'function') {
        try {
          finalGranted = Boolean(await storage.persisted());
        } catch {
          finalGranted = Boolean(grantedByPersist);
        }
      }
      const updatedEstimate = await queryStorageEstimate(storage);
      return emit({
        status: finalGranted ? 'granted' : 'not-granted',
        requestPending: false,
        errorMessage: null,
        estimate: updatedEstimate,
        lastCheckedAt: Date.now(),
      });
    } catch (err: unknown) {
      const updatedEstimate = await queryStorageEstimate(storage);
      return emit({
        status: 'check-failed',
        requestPending: false,
        errorMessage: err instanceof Error ? err.message : 'Storage protection request failed',
        estimate: updatedEstimate,
        lastCheckedAt: Date.now(),
      });
    }
  })().finally(() => {
    inFlightRequest = null;
  });

  return inFlightRequest;
}

export function resetStorageProtectionStateForTests(): void {
  currentSnapshot = { ...DEFAULT_SNAPSHOT };
  inFlightCheck = null;
  inFlightRequest = null;
  lastResumeCheckMs = 0;
}

export function formatApproxBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type PlatformInstallHint = 'ios-safari' | 'android-chrome' | 'desktop-or-other';

export function detectPlatformInstallHint(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): PlatformInstallHint {
  const lower = ua.toLowerCase();
  const isIOS = /ipad|iphone|ipod/.test(lower) || (/macintosh/.test(lower) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios-safari';
  if (/android/.test(lower)) return 'android-chrome';
  return 'desktop-or-other';
}
