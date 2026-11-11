import { useEffect, useState } from 'react';

export type SplashPhase = 'opening' | 'minimum-visible' | 'transitioning' | 'ready' | 'failed';

export const SPLASH_MIN_VISIBLE_MS = 1000;
export const SPLASH_FADE_MS = 230;

// Module-level singleton state so React StrictMode double-mounts or component re-renders
// never restart or replay the opening splash sequence within the same page load.
let launchStartedAt: number | null = null;
let launchCompletedOnce = false;

export function resetOpeningSplashStateForTests(): void {
  launchStartedAt = null;
  launchCompletedOnce = false;
}

export function computeRemainingSplashMs(
  firstPaintAt: number,
  now: number,
  minVisibleMs = SPLASH_MIN_VISIBLE_MS,
): number {
  const elapsed = Math.max(0, now - firstPaintAt);
  return Math.max(0, minVisibleMs - elapsed);
}

/**
 * Calm, visible opening screen:
 * - Shows a charcoal/near-black (`#151518`) full-screen splash with the notebook/pen icon and centered `My Notes` title.
 * - Remains visible for at least `1,000 ms` after first paint even when local data is already warm,
 *   then crossfades out over `230 ms` (`~1.23 s` total sequence).
 * - Plays once per fresh launch/reload; never replays on tab changes, settings, or BFCache restore.
 */
export function Opening({
  ready,
  error,
  onRetry,
}: {
  ready: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [phase, setPhase] = useState<SplashPhase>(() => {
    if (launchCompletedOnce) return 'ready';
    return 'opening';
  });

  useEffect(() => {
    // Do not replay if restored from browser back-forward cache (pageshow persisted)
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        launchCompletedOnce = true;
        setPhase('ready');
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  useEffect(() => {
    if (error) {
      setPhase('failed');
      return;
    }
    if (launchCompletedOnce) {
      setPhase('ready');
      return;
    }
    if (launchStartedAt === null) {
      launchStartedAt = performance.now();
    }
    setPhase('minimum-visible');
  }, [error]);

  useEffect(() => {
    if (error) {
      setPhase('failed');
      return;
    }
    if (!ready || launchCompletedOnce) return;

    const start = launchStartedAt ?? (launchStartedAt = performance.now());
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const waitMs = computeRemainingSplashMs(start, performance.now(), SPLASH_MIN_VISIBLE_MS);
    const fadeMs = reduceMotion ? 0 : SPLASH_FADE_MS;

    let fadeTimer = 0;
    const minTimer = window.setTimeout(() => {
      if (fadeMs === 0) {
        launchCompletedOnce = true;
        setPhase('ready');
        return;
      }
      setPhase('transitioning');
      fadeTimer = window.setTimeout(() => {
        launchCompletedOnce = true;
        setPhase('ready');
      }, fadeMs);
    }, waitMs);

    return () => {
      clearTimeout(minTimer);
      clearTimeout(fadeTimer);
    };
  }, [ready, error]);

  if (phase === 'ready') return null;

  return (
    <div
      className={`opening ${phase === 'transitioning' ? 'out' : ''}`}
      data-testid="opening-splash"
      data-splash-phase={phase}
      role="status"
      aria-live="polite"
      aria-hidden={phase === 'transitioning'}
    >
      <svg width="112" height="112" viewBox="0 0 120 120" aria-hidden="true">
        <rect x="26" y="14" width="68" height="92" rx="10" fill="#1c1c21" stroke="#f2f2f2" strokeWidth="3" />
        <path d="M38 14v92" stroke="#f2f2f2" strokeWidth="3" />
        <path
          className="pen-stroke"
          d="M50 44c10-10 18 10 28 0s8-8 8-8M50 68c14-8 22 8 34-2"
          fill="none"
          stroke="#0A84FF"
          strokeWidth="4"
          strokeLinecap="round"
          pathLength="1"
        />
      </svg>
      <div className="opening-title">My Notes</div>
      <div className="opening-sub">Local-First Tablet Notebook</div>
      {error ? (
        <div className="opening-error" role="alert">
          <p>Could not open local storage: {error}</p>
          <button
            type="button"
            onClick={() => {
              launchStartedAt = performance.now();
              onRetry();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        !ready && <span className="sr-only">Loading My Notes</span>
      )}
    </div>
  );
}
