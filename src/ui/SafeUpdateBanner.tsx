import { useEffect, useState } from 'react';
import { DownloadCloud, RefreshCw, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { flushPendingWrites, hasPendingWrites, useApp } from '../app/store';

const SESSION_SNAPSHOT_KEY = 'mynotes.safeUpdateSnapshot';

export function restoreSafeUpdateSnapshotIfAny(): void {
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
    if (snap.mode && snap.panes?.length) {
      useApp.setState({
        mode: snap.mode,
        tabs: snap.tabs ?? [],
        panes: snap.panes,
        activePane: snap.activePane ?? 0,
        pageViewMode: snap.pageViewMode ?? useApp.getState().pageViewMode,
      });
    }
  } catch {
    /* ignore */
  }
}

export function SafeUpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      // Periodically check for updates only when online and idle (every 30 mins)
      if (r) {
        setInterval(() => {
          if (navigator.onLine && !hasPendingWrites()) {
            void r.update();
          }
        }, 30 * 60 * 1000);
      }
    },
  });

  const [updating, setUpdating] = useState(false);
  const [deferMsg, setDeferMsg] = useState<string | null>(null);
  const [chunkError, setChunkError] = useState(false);

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
      await flushPendingWrites();
      const st = useApp.getState();
      if (st.save === 'failed' || hasPendingWrites()) {
        setDeferMsg('Update deferred: local changes are still saving or need attention. Your notes were not reloaded.');
        setUpdating(false);
        return;
      }
      // Snapshot open tabs/panes/pageViewMode across the controlled reload
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
          <strong>Update available — your notes will be saved before updating.</strong>
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
            <RefreshCw size={14} /> {updating ? 'Saving & Updating…' : 'Update safely'}
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
