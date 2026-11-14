import { useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Copy,
  Download,
  HardDrive,
  Info,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { actions, beginEssentialJob, useApp } from '../app/store';
import { WritingDiagnosticsModal } from './WritingDiagnosticsModal';
import {
  LOCAL_PACK_APPROX_LABEL,
  cancelLocalPackInstall,
  installLocalHandwritingPack,
  isLocalPackInstalled,
  removeLocalHandwritingPack,
} from '../recognition/provider';
import { detectPlatformInstallHint, formatApproxBytes } from '../storage/persistence';
import { checkForServiceWorkerUpdates } from './SafeUpdateBanner';

const loadBackupManager = () => import('../export/backup');

const BACKUP_REMINDER_DISMISSED_KEY = 'mynotes.backupReminderDismissedAt';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useApp();
  const sp = s.storageProtection;
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copiedVersion, setCopiedVersion] = useState(false);
  const [packInstalled, setPackInstalled] = useState(() => isLocalPackInstalled());
  const [packInstalling, setPackInstalling] = useState(false);
  const [packStatusMsg, setPackStatusMsg] = useState<string | null>(null);
  const [lastBackupTs, setLastBackupTs] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('mynotes_last_backup_at');
      return raw ? Number(raw) : null;
    } catch {
      return null;
    }
  });
  const [reminderDismissed, setReminderDismissed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(BACKUP_REMINDER_DISMISSED_KEY);
      if (!raw) return false;
      return Date.now() - Number(raw) < 7 * 24 * 3600 * 1000;
    } catch {
      return false;
    }
  });

  const buildId = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'v0.1.0 (local)';
  const builtAt = typeof __APP_BUILT_AT__ !== 'undefined' ? __APP_BUILT_AT__ : '';
  const platformHint = detectPlatformInstallHint();

  const statusBadge = (() => {
    switch (sp.status) {
      case 'checking':
        return { label: 'Checking…', color: '#8E8E93', bg: 'rgba(142, 142, 147, 0.16)' };
      case 'granted':
        return { label: 'Storage protection enabled', color: '#30D158', bg: 'rgba(48, 209, 88, 0.16)' };
      case 'not-granted':
        return { label: 'Not granted by browser', color: '#64D2FF', bg: 'rgba(100, 210, 255, 0.14)' };
      case 'unsupported':
        return { label: 'Not supported in this browser', color: '#8E8E93', bg: 'rgba(142, 142, 147, 0.16)' };
      case 'check-failed':
        return { label: 'Status check failed', color: '#FF9F0A', bg: 'rgba(255, 159, 10, 0.16)' };
    }
  })();

  const handleEnableProtection = async () => {
    await actions.requestStorageProtectionAction();
  };

  const handleExportBackup = async () => {
    setErrorMsg(null);
    setBusyMsg('Generating full offline backup (.tabletnotes.zip)…');
    const endJob = beginEssentialJob('backup-export');
    try {
      const { exportBackupArchiveFlow, getLastBackupTime } = await loadBackupManager();
      const ok = await exportBackupArchiveFlow();
      if (ok) {
        setLastBackupTs(getLastBackupTime());
      }
    } catch (err) {
      setErrorMsg(`Backup export failed: ${(err as Error).message}`);
    } finally {
      endJob();
      setBusyMsg(null);
    }
  };

  const handleRestoreBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setBusyMsg(`Restoring ${file.name}…`);
    const endJob = beginEssentialJob('backup-restore');
    try {
      const { restoreFromBackupZipBytes } = await loadBackupManager();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await restoreFromBackupZipBytes(bytes);
      await actions.refreshNotebooksAndFonts();
      setBusyMsg(`Restored ${res.restoredNotebooks} notebook(s) safely.`);
      setTimeout(() => setBusyMsg(null), 2500);
    } catch (err) {
      setErrorMsg(`Restore failed: ${(err as Error).message}`);
      setBusyMsg(null);
    } finally {
      endJob();
      e.target.value = '';
    }
  };

  const handleInstallHandwritingPack = async () => {
    setPackInstalling(true);
    setPackStatusMsg(`Starting download (${LOCAL_PACK_APPROX_LABEL})…`);
    try {
      await installLocalHandwritingPack((msg) => setPackStatusMsg(msg));
      setPackInstalled(true);
      setPackStatusMsg('Offline handwriting pack installed and ready for offline use.');
    } catch (err) {
      setPackStatusMsg((err as Error).message);
    } finally {
      setPackInstalling(false);
    }
  };

  const handleCancelHandwritingPack = () => {
    cancelLocalPackInstall();
    setPackInstalling(false);
    setPackStatusMsg('Offline handwriting pack download cancelled.');
  };

  const handleRemoveHandwritingPack = async () => {
    await removeLocalHandwritingPack();
    setPackInstalled(false);
    setPackStatusMsg('Offline handwriting pack removed from cache.');
  };

  const handleCopyVersion = async () => {
    try {
      await navigator.clipboard?.writeText(`My Notes ${buildId}${builtAt ? ` (${builtAt})` : ''}`);
      setCopiedVersion(true);
      setTimeout(() => setCopiedVersion(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const dismissBackupReminder = () => {
    setReminderDismissed(true);
    try {
      localStorage.setItem(BACKUP_REMINDER_DISMISSED_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="nn-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings, Storage & App Updates"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(580px, 95vw)', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <header className="nn-head">
          <button className="nn-close" aria-label="Close Settings" onClick={onClose}>
            <X size={20} />
          </button>
          <h2>Settings</h2>
          <div style={{ width: 34 }} />
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Section 1: Browser Storage Protection & Offline Backup */}
          <section
            aria-label="Browser Storage Protection"
            style={{
              background: '#141417',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <HardDrive size={18} color="#0A84FF" />
                <strong style={{ fontSize: 15 }}>Storage & Offline Backup</strong>
              </div>
              <span
                data-testid="storage-protection-status"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: statusBadge.color,
                  background: statusBadge.bg,
                  padding: '4px 10px',
                  borderRadius: 999,
                }}
              >
                {statusBadge.label}
              </span>
            </div>

            <p style={{ margin: 0, fontSize: 13, color: '#E5E5EA', lineHeight: 1.45 }}>
              <strong>Notes are saved on this device. Keep a backup.</strong>{' '}
              {sp.status === 'granted'
                ? 'Browser storage protection is active for this origin.'
                : sp.status === 'not-granted'
                  ? 'Your notes still save locally in IndexedDB/OPFS, even when browser storage protection is not granted.'
                  : sp.status === 'unsupported'
                    ? 'This browser does not expose the StorageManager persistence API, but your notes still save locally on this device.'
                    : sp.status === 'check-failed'
                      ? `Could not verify browser persistence status (${sp.errorMessage || 'API error'}). Your notes still save locally.`
                      : 'Checking browser storage protection status…'}
            </p>

            {/* Approximate Usage / Quota */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
                padding: '8px 10px',
                background: '#1C1C21',
                borderRadius: 10,
                fontSize: 12,
              }}
            >
              <span style={{ color: 'var(--muted)' }}>Estimated browser origin storage (approximate):</span>
              <strong data-testid="storage-estimate-readout">
                {sp.estimate.supported && sp.estimate.usageBytes !== null
                  ? `${formatApproxBytes(sp.estimate.usageBytes)}${
                      sp.estimate.quotaBytes !== null ? ` of ~${formatApproxBytes(sp.estimate.quotaBytes)}` : ''
                    }`
                  : 'Estimate unavailable in this browser'}
              </strong>
            </div>

            {/* Action buttons: Enable storage protection, Export Backup, Restore Backup */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {sp.status !== 'granted' && sp.status !== 'unsupported' && (
                <button
                  type="button"
                  className="chip"
                  data-testid="enable-storage-protection-btn"
                  disabled={sp.requestPending || sp.status === 'checking'}
                  onClick={() => void handleEnableProtection()}
                >
                  <ShieldCheck size={15} />{' '}
                  {sp.requestPending ? 'Requesting…' : 'Enable storage protection'}
                </button>
              )}

              <button
                type="button"
                className="nn-create"
                data-testid="settings-export-backup-btn"
                disabled={!!busyMsg}
                onClick={() => void handleExportBackup()}
              >
                <Download size={15} /> Export Backup
              </button>

              <button
                type="button"
                className="chip"
                disabled={!!busyMsg}
                onClick={() => restoreInputRef.current?.click()}
              >
                <Upload size={15} /> Restore Backup
              </button>

              <input
                ref={restoreInputRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: 'none' }}
                onChange={handleRestoreBackup}
              />
            </div>

            {busyMsg && <div style={{ fontSize: 12, color: '#0A84FF' }}>{busyMsg}</div>}
            {errorMsg && (
              <div
                role="alert"
                style={{
                  fontSize: 12,
                  color: '#FF453A',
                  background: 'rgba(255, 69, 58, 0.14)',
                  border: '1px solid rgba(255, 69, 58, 0.35)',
                  borderRadius: 10,
                  padding: '8px 10px',
                }}
              >
                {errorMsg}
              </div>
            )}

            {/* Last generated backup timestamp */}
            <div style={{ fontSize: 12, color: 'var(--muted)' }} data-testid="last-backup-readout">
              <strong>Last generated backup archive:</strong>{' '}
              {lastBackupTs
                ? `${new Date(lastBackupTs).toLocaleString()} (keep the downloaded .tabletnotes.zip file in Files, iCloud Drive, Google Drive, or external storage)`
                : 'No backup archive generated on this device yet.'}
            </div>

            {/* Dismissible reminder if no recent backup */}
            {!reminderDismissed && !lastBackupTs && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  background: 'rgba(10, 132, 255, 0.12)',
                  border: '1px solid rgba(10, 132, 255, 0.3)',
                  borderRadius: 10,
                  fontSize: 12,
                }}
              >
                <span>Tip: Export a `.tabletnotes.zip` backup periodically so you have a copy outside the browser.</span>
                <button type="button" className="icon xs" aria-label="Dismiss backup reminder" onClick={dismissBackupReminder}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Platform-appropriate guidance when permission remains ungranted */}
            {sp.status !== 'granted' && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  background: '#19191E',
                  padding: '8px 10px',
                  borderRadius: 10,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#E5E5EA', marginBottom: 3 }}>
                  <Smartphone size={14} />
                  <strong>How browser storage permission works</strong>
                </div>
                The browser—not the website—controls whether persistent storage is granted.{' '}
                {platformHint === 'ios-safari'
                  ? 'On iPadOS/iOS Safari, tapping Share → Add to Home Screen can help increase storage durability, though browser permission is never guaranteed.'
                  : platformHint === 'android-chrome'
                    ? 'On Android Chrome, installing the app to your Home Screen or bookmarking the site can help the browser grant persistence, though it is not guaranteed.'
                    : 'Installing the PWA to your Home Screen or desktop app launcher can help in some browsers, though permission is never guaranteed.'}
              </div>
            )}

            {/* Honest explanation of what persistence does and does not protect against */}
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>
              <Info size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              Persistence helps protect against automatic browser storage eviction under low disk space; it does{' '}
              <strong>not</strong> protect against explicit <em>Clear Website Data</em>, browser profile removal, or device
              loss. Do not clear browser data or uninstall the PWA if you want to keep local notes that have not been
              backed up.
            </p>
          </section>

          {/* Section 2: Writing Diagnostics */}
          <section
            aria-label="Writing Diagnostics"
            style={{
              background: '#141417',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div>
              <button
                type="button"
                className="chip"
                onClick={() => setShowDiagnostics(true)}
                style={{ gap: 6, color: '#64D2FF', borderColor: 'rgba(100, 210, 255, 0.3)' }}
              >
                <Activity size={14} /> Open Writing Diagnostics Board
              </button>
            </div>
          </section>

          {/* Section 3: Offline Handwriting Recognition Pack */}
          <section
            aria-label="Offline Handwriting Recognition Pack"
            style={{
              background: '#141417',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sparkles size={18} color="#BF5AF2" />
                <strong style={{ fontSize: 15 }}>Offline Handwriting Pack (TrOCR)</strong>
              </div>
              <span
                data-testid="htr-pack-status"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: packInstalled ? '#30D158' : packInstalling ? '#0A84FF' : '#8E8E93',
                  background: packInstalled
                    ? 'rgba(48, 209, 88, 0.16)'
                    : packInstalling
                      ? 'rgba(10, 132, 255, 0.16)'
                      : 'rgba(142, 142, 147, 0.16)',
                  padding: '4px 10px',
                  borderRadius: 999,
                }}
              >
                {packInstalled
                  ? 'Installed & ready offline'
                  : packInstalling
                    ? 'Downloading…'
                    : `Not installed (${LOCAL_PACK_APPROX_LABEL})`}
              </span>
            </div>

            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>
              Optional neural handwriting-to-text model (<code>Xenova/trocr-small-handwritten</code> + ONNX Runtime Web,{' '}
              <strong>{LOCAL_PACK_APPROX_LABEL}</strong>). Downloaded only when you choose to install it, and cached
              locally so handwriting conversion works 100% offline.
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {!packInstalling ? (
                <button
                  type="button"
                  className={packInstalled ? 'chip' : 'nn-create'}
                  data-testid="settings-install-htr-btn"
                  onClick={() => void handleInstallHandwritingPack()}
                >
                  <Sparkles size={15} />{' '}
                  {packInstalled
                    ? 'Verify / Repair Offline Pack'
                    : `Download Offline Pack (${LOCAL_PACK_APPROX_LABEL})`}
                </button>
              ) : (
                <button
                  type="button"
                  className="chip"
                  data-testid="settings-cancel-htr-btn"
                  onClick={handleCancelHandwritingPack}
                >
                  <X size={15} /> Cancel Download
                </button>
              )}

              {packInstalled && !packInstalling && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => void handleRemoveHandwritingPack()}
                >
                  <Trash2 size={15} /> Remove Cached Pack
                </button>
              )}
            </div>

            {packStatusMsg && (
              <div style={{ fontSize: 12, color: packInstalled ? '#30D158' : '#0A84FF' }}>{packStatusMsg}</div>
            )}
          </section>

          {/* Section 4: App Version & Safe Updates */}
          <section
            aria-label="App Version and Safe Updates"
            style={{
              background: '#141417',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RefreshCw size={18} color="#30D158" />
                <strong style={{ fontSize: 15 }}>App Version & Updates</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <code
                  data-testid="app-version-readout"
                  style={{
                    fontSize: 12,
                    background: '#1C1C21',
                    padding: '4px 8px',
                    borderRadius: 8,
                    color: '#E5E5EA',
                  }}
                >
                  {buildId}
                </code>
                <button
                  type="button"
                  className="icon xs"
                  aria-label="Copy version info for support"
                  title="Copy version info"
                  onClick={() => void handleCopyVersion()}
                >
                  {copiedVersion ? <CheckCircle2 size={14} color="#30D158" /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="chip"
                data-testid="check-for-updates-btn"
                disabled={s.updateCheckStatus === 'checking'}
                onClick={() => void checkForServiceWorkerUpdates({ userInitiated: true })}
              >
                <RefreshCw size={14} />{' '}
                {s.updateCheckStatus === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>

              {s.updateCheckMessage && (
                <span
                  data-testid="update-check-status-msg"
                  style={{
                    fontSize: 12,
                    color:
                      s.updateCheckStatus === 'available'
                        ? '#30D158'
                        : s.updateCheckStatus === 'offline-or-error'
                          ? '#FF9F0A'
                          : 'var(--muted)',
                  }}
                >
                  {s.updateCheckMessage}
                </span>
              )}
            </div>

            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>
              Installed PWAs discover new production deployments when online without reinstalling. When an update is
              downloaded, you can choose <strong>Update</strong> or <strong>Later</strong>—active strokes and local saves
              are completed before reloading, and offline devices continue using the installed version until they
              reconnect.
            </p>
          </section>
        </div>
      </div>

      {showDiagnostics && <WritingDiagnosticsModal onClose={() => setShowDiagnostics(false)} />}
    </div>
  );
}
