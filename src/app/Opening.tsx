import { useEffect, useState } from 'react';

/** Opening visual: shown once per launch, never delays a ready app, no fake progress. */
export function Opening({ ready, error, onRetry }: { ready: boolean; error: string | null; onRetry: () => void }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => setGone(true), reduce ? 0 : 350);
    return () => clearTimeout(t);
  }, [ready]);
  if (gone) return null;
  return (
    <div className={`opening ${ready ? 'out' : ''}`} role="status" aria-live="polite">
      <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
        <rect x="26" y="14" width="68" height="92" rx="10" fill="none" stroke="#f2f2f2" strokeWidth="3" />
        <path d="M38 14v92" stroke="#f2f2f2" strokeWidth="3" />
        <path className="pen-stroke" d="M50 44c10-10 18 10 28 0s8-8 8-8M50 68c14-8 22 8 34-2" fill="none" stroke="#0A84FF" strokeWidth="4" strokeLinecap="round" pathLength="1" />
      </svg>
      <div className="opening-title">My Notes</div>
      {error ? (
        <div className="opening-error">
          <p>Could not open local storage: {error}</p>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : (
        !ready && <span className="sr-only">Loading My Notes</span>
      )}
    </div>
  );
}
