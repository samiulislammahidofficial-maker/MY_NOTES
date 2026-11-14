import { useEffect, useState } from 'react';
import { DownloadCloud, RefreshCw, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { actions, coordinateMultiTabUpdateReadiness, hasPendingWrites, useApp } from '../app/store';
import { repo } from '../storage/db';

const SESSION_SNAPSHOT_KEY = 'mynotes.safeUpdateSnapshot';
const RELOAD_GUARD_KEY = 'mynotes.safeUpdateReloadAt';
const RELOAD_GUARD_WINDOW_MS = 10_000;

let activeSwRegistration: ServiceWorkerRegistration | undefined;
let lastResumeUpdateCheckAt = 0;

export function getActiveServiceWorkerRegistration(): ServiceWorkerRegistration | undefined {
  return activeSwRegistration;
}

export function setActiveServiceWorkerRegistrationForTests(reg: ServiceWorkerRegistration | undefined): void {
  activeSwRegistration = reg;
}

/**
 * User-triggered or throttled resume check for Service Worker updates.
 * Handles offline / fetch failures gracefully and reports accurate status:
 * `checking` -> `available` | `up-to-date` | `offline-or-error`.
 */
export async function checkForServiceWorkerUpdates(options?: {
  userInitiated?: boolean;
  regOverride?: ServiceWorkerRegistration;
}): Promise<'available' | 'up-to-date' | 'offline-or-error'> {
  const userInitiated = options?.userInitiated ?? false;
  if (userInitiated) {
    useApp.setState({ updateCheckStatus: 'checking', updateCheckMessage: 'Checking for updates…' });
  }

  // navigator.onLine is a hint, not proof of connectivity, so only fast-fail if explicitly false AND no registration
  const reg =
    options?.regOverride ??
    activeSwRegistration ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration().catch(() => undefined)
      : undefined);

  if (!reg) {
    const isOfflineHint = typeof navigator !== 'undefined' && navigator.onLine === false;
    const msg = isOfflineHint
      ? 'Unable to check while offline. Your installed version continues to work offline.'
      : 'Service worker update check is unavailable in this environment.';
    if (userInitiated) {
      useApp.setState({ updateCheckStatus: 'offline-or-error', updateCheckMessage: msg });
    }
    return 'offline-or-error';
  }

  if (reg.waiting) {
    useApp.setState({
      updateCheckStatus: 'available',
      updateCheckMessage: 'Update available — ready to activate safely when you choose.',
    });
    return 'available';
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (userInitiated) {
      useApp.setState({
        updateCheckStatus: 'offline-or-error',
        updateCheckMessage: 'Unable to check while offline. Your installed version continues to work offline.',
      });
    }
    return 'offline-or-error';
  }

  try {
    const UPDATE_TIMEOUT_MS = 4500;
    await Promise.race([
      reg.update(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Update check timed out')), UPDATE_TIMEOUT_MS),
      ),
    ]);
    if (reg.waiting || reg.installing) {
      if (reg.installing && !reg.waiting) {
        await new Promise<void>((resolve) => {
          const worker = reg.installing!;
          const onState = () => {
            if (worker.state === 'installed' || worker.state === 'redundant' || worker.state === 'activated') {
              worker.removeEventListener('statechange', onState);
              resolve();
            }
          };
          worker.addEventListener('statechange', onState);
          setTimeout(() => {
            worker.removeEventListener('statechange', onState);
            resolve();
          }, 1500);
        });
      }
    }
    if (reg.waiting) {
      useApp.setState({
        updateCheckStatus: 'available',
        updateCheckMessage: 'Update available — ready to activate safely when you choose.',
      });
      return 'available';
    }
    if (userInitiated) {
      useApp.setState({
        updateCheckStatus: 'up-to-date',
        updateCheckMessage: 'No new update found. You are running the latest installed version.',
      });
    }
    return 'up-to-date';
  } catch (err: unknown) {
    if (userInitiated) {
      useApp.setState({
        updateCheckStatus: 'offline-or-error',
        updateCheckMessage:
          err instanceof Error && err.message
            ? `Unable to check for updates (${err.message}). Continue working offline safely.`
            : 'Unable to check for updates (offline or network unreachable).',
      });
    }
    return 'offline-or-error';
  }
}

export async function restoreSafeUpdateSnapshotIfAny(): Promise<void> {
  try {
    const raw = sessionStorage.getItem(SESSION_SNAPSHOT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(SESSION_SNAPSHOT_KEY);
    const snap = JSON.parse(raw) as {
      mode?: 'welcome' | 'library' | 'editor';
      tabs?: string[];
      panes?: Array<{ notebookId: string; pageId: string }>;
      activePane?: number;
      pageViewMode?: 'single' | 'continuous';
    };
    if (snap.mode === 'editor' && snap.panes?.length) {
      const allNbs = await repo.allNotebooks();
      const validPanes: Array<{ notebookId: string; pageId: string }> = [];
      const validTabs: string[] = [];
      for (const tid of snap.tabs ?? []) {
        const nb = allNbs.find((n) => n.id === tid);
        // Never persist or auto-unlock decrypted keys across reload; if notebook is locked, reopen Library so user sees lock screen
        if (nb && !nb.passwordLock) {
          await useApp.getState();
          validTabs.push(tid);
        }
      }
      for (const pn of snap.panes) {
        const nb = allNbs.find((n) => n.id === pn.notebookId);
        if (nb && !nb.passwordLock) {
          validPanes.push(pn);
        }
      }
      if (validPanes.length > 0) {
        for (const tid of validTabs) {
          await actions.loadNotebook(tid);
        }
        useApp.setState({
          mode: 'editor',
          tabs: validTabs.length ? validTabs : [validPanes[0].notebookId],
          panes: validPanes,
          activePane: Math.min(snap.activePane ?? 0, validPanes.length - 1),
          pageViewMode: snap.pageViewMode ?? useApp.getState().pageViewMode,
        });
      } else {
        // Locked notebook was open before update: open Library safely without exposing plaintext or keys
        useApp.setState({
          mode: 'library',
          pageViewMode: snap.pageViewMode ?? useApp.getState().pageViewMode,
        });
      }
    } else if (snap.mode) {
      useApp.setState({
        mode: snap.mode,
        pageViewMode: snap.pageViewMode ?? useApp.getState().pageViewMode,
      });
    }
  } catch {
    /* ignore */
  }
}

export function shouldAllowControlledReload(now = Date.now()): boolean {
  try {
    const prev = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || '0');
    if (prev > 0 && now - prev < RELOAD_GUARD_WINDOW_MS) {
      return false;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

export function SafeUpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      activeSwRegistration = r;
      if (r) {
        // Startup check when online
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
          void checkForServiceWorkerUpdates({ userInitiated: false, regOverride: r });
        }
        // Periodically check for updates only when online and idle (every 30 mins)
        setInterval(() => {
          if (navigator.onLine && !hasPendingWrites()) {
            void checkForServiceWorkerUpdates({ userInitiated: false, regOverride: r });
          }
        }, 30 * 60 * 1000);
      }
    },
    onNeedRefresh() {
      useApp.setState({
        updateCheckStatus: 'available',
        updateCheckMessage: 'New update available — ready to activate safely.',
      });
    },
  });

  const [updating, setUpdating] = useState(false);
  const [deferMsg, setDeferMsg] = useState<string | null>(null);
  const [chunkError, setChunkError] = useState(false);

  // Throttled resume/focus update check (at most once every 5 minutes when online and not writing)
  useEffect(() => {
    const onResume = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastResumeUpdateCheckAt < 5 * 60 * 1000) return;
      if (navigator.onLine !== false && !hasPendingWrites()) {
        lastResumeUpdateCheckAt = now;
        void checkForServiceWorkerUpdates({ userInitiated: false });
      }
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, []);

  // Guard against failed lazy chunk loads without entering a reload loop
  useEffect(() => {
    const onPreloadErr = (e: Event) => {
      e.preventDefault();
      setChunkError(true);
    };
    window.addEventListener('vite:preloadError', onPreloadErr);
    return () => window.removeEventListener('vite:preloadError', onPreloadErr);
  }, []);

  const handleSafeUpdate = async () => {
    setUpdating(true);
    setDeferMsg(null);
    try {
      const readiness = await coordinateMultiTabUpdateReadiness();
      if (!readiness.ok) {
        setDeferMsg(
          readiness.reason ||
            'Update deferred: local changes are still saving or need attention. Your notes were not reloaded.',
        );
        setUpdating(false);
        return;
      }

      const st = useApp.getState();
      // Save safe identifiers only (never decrypted content or keys)
      try {
        sessionStorage.setItem(
          SESSION_SNAPSHOT_KEY,
          JSON.stringify({
            mode: st.mode,
            tabs: st.tabs,
            panes: st.panes,
            activePane: st.activePane,
            pageViewMode: st.pageViewMode,
          }),
        );
      } catch {
        /* ignore */
      }

      if (!shouldAllowControlledReload()) {
        setDeferMsg('Reload guard active to prevent a refresh loop. You can continue working safely.');
        setUpdating(false);
        return;
      }

      if (chunkError && !needRefresh) {
        window.location.reload();
        return;
      }

      await updateServiceWorker(true);
    } catch {
      setDeferMsg('Could not activate update right now. Continue working safely offline.');
      setUpdating(false);
    }
  };

  if (!needRefresh && !offlineReady && !chunkError) return null;

  return (
    <div
      className="safe-update-toast"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 18,
        transform: 'translateX(-50%)',
        zIndex: 80,
        background: '#1c1c20',
        border: '1px solid #383842',
        borderRadius: 16,
        padding: '10px 16px',
        boxShadow: '0 14px 40px rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        maxWidth: 'min(580px, 94vw)',
        fontSize: 13,
      }}
    >
      <DownloadCloud size={18} color="#0A84FF" />
      <div style={{ flex: 1, minWidth: 180 }}>
        {chunkError ? (
          <strong>A new version of My Notes was deployed. Save and reload when ready.</strong>
        ) : needRefresh ? (
          <strong>New update available — your notes will be saved before updating.</strong>
        ) : (
          <span>My Notes is cached and ready for 100% offline use.</span>
        )}
        {deferMsg && <div style={{ color: '#FF9F0A', fontSize: 12, marginTop: 4 }}>{deferMsg}</div>}
      </div>

      {(needRefresh || chunkError) && (
        <>
          <button
            type="button"
            className="chip"
            disabled={updating}
            onClick={() => {
              setNeedRefresh(false);
              setChunkError(false);
              setDeferMsg(null);
            }}
          >
            Later
          </button>
          <button
            type="button"
            className="nn-create"
            disabled={updating}
            onClick={() => void handleSafeUpdate()}
          >
            <RefreshCw size={14} /> {updating ? 'Saving & Updating…' : 'Update'}
          </button>
        </>
      )}

      {offlineReady && !needRefresh && !chunkError && (
        <button
          type="button"
          className="icon xs"
          aria-label="Dismiss offline ready notification"
          onClick={() => setOfflineReady(false)}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
