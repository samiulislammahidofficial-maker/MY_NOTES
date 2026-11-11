import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  BookOpen,
  Check,
  CheckSquare,
  CircleDashed,
  Download,
  FolderOpen,
  HelpCircle,
  Import,
  Info,
  KeyRound,
  LayoutGrid,
  List,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pin,
  Plus,
  ScanLine,
  Search,
  Settings2,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { actions, useApp, type Filter } from './store';
import { db, repo } from '../storage/db';
import { blobStore } from '../storage/blobStore';
import type { Notebook } from '../domain/types';
import { NewNotebookDialog, templateStyle } from './NewNotebook';
import { importPdfAsNotebook, importScannedImageAsNotebook } from '../pdf/pdfManager';
import { buildBackupZipBytes, restoreFromBackupZipBytes, saveOrShareFileBytes } from '../export/backup';
import { isDocumentUnlockedInSession } from '../security/passwordLock';
import { PasswordModal, type PasswordModalMode } from '../ui/PasswordModal';

function age(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 604800 * 1) return `${Math.round(s / 86400)}d`;
  if (s < 2592000) return `${Math.round(s / 604800)}w`;
  if (s < 31536000) return `${Math.round(s / 2592000)}M`;
  return `${Math.round(s / 31536000)}y`;
}

export function Library() {
  const s = useApp();
  const [menu, setMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [pwModal, setPwModal] = useState<{ mode: PasswordModalMode; notebook: Notebook } | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  // Load custom cover photo URLs from local storage
  useEffect(() => {
    let active = true;
    const urlsToRevoke: string[] = [];
    (async () => {
      const next: Record<string, string> = {};
      for (const n of s.notebooks) {
        if (!n.coverAssetId) continue;
        try {
          const asset = await db.assets.get(n.coverAssetId);
          if (!asset) continue;
          const bytes = await blobStore.get(asset.id);
          if (!bytes) continue;
          const blob = new Blob([bytes as unknown as BlobPart], { type: asset.mimeType || 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          urlsToRevoke.push(url);
          next[n.id] = url;
        } catch {
          /* ignore */
        }
      }
      if (active) setCoverUrls(next);
    })();
    return () => {
      active = false;
      for (const u of urlsToRevoke) URL.revokeObjectURL(u);
    };
  }, [s.notebooks]);

  const counts = useMemo(() => {
    const live = s.notebooks.filter((n) => !n.trashedAt);
    return {
      untagged: live.filter((n) => n.tags.length === 0).length,
      unfiled: live.filter((n) => !n.folderId).length,
      trashed: s.notebooks.filter((n) => n.trashedAt).length,
    };
  }, [s.notebooks]);

  const list = useMemo(() => {
    let l = s.notebooks.filter((n) => (s.filter === 'trashed' ? !!n.trashedAt : !n.trashedAt));
    if (s.filter === 'untagged') l = l.filter((n) => n.tags.length === 0);
    if (s.filter === 'unfiled') l = l.filter((n) => !n.folderId);
    if (s.filter === 'pinned') l = l.filter((n) => n.pinned);
    if (s.query.trim()) l = l.filter((n) => n.title.toLowerCase().includes(s.query.toLowerCase()));
    const cmp: Record<string, (a: Notebook, b: Notebook) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...l].sort(cmp[s.sort]);
  }, [s.notebooks, s.filter, s.query, s.sort]);

  const nav = (f: Filter, label: string, icon: React.ReactNode, count?: number) => (
    <button
      className={`nav-row ${s.filter === f ? 'active' : ''}`}
      onClick={() => useApp.setState({ filter: f })}
      aria-current={s.filter === f}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && <em>{count}</em>}
    </button>
  );

  const onOpen = (n: Notebook) => {
    if (s.selecting) {
      useApp.setState({
        selected: s.selected.includes(n.id) ? s.selected.filter((x) => x !== n.id) : [...s.selected, n.id],
      });
      return;
    }
    if (n.trashedAt) return;
    if (n.passwordLock && !isDocumentUnlockedInSession(n.id)) {
      setPwModal({ mode: 'unlock', notebook: n });
      return;
    }
    void actions.openNotebook(n.id);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusyMsg(`Importing ${file.name}…`);
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await restoreFromBackupZipBytes(bytes);
        await actions.refreshNotebooksAndFonts();
      } else {
        const nbId = await importPdfAsNotebook(file);
        await actions.refreshNotebooksAndFonts();
        await actions.openNotebook(nbId);
      }
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    } finally {
      setBusyMsg(null);
      e.target.value = '';
    }
  };

  const handleScanImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusyMsg(`Importing scan ${file.name}…`);
    try {
      const nbId = await importScannedImageAsNotebook(file);
      await actions.refreshNotebooksAndFonts();
      await actions.openNotebook(nbId);
    } catch (err) {
      alert(`Scan import failed: ${(err as Error).message}`);
    } finally {
      setBusyMsg(null);
      e.target.value = '';
    }
  };

  const handleExportAllBackup = async () => {
    setBusyMsg('Creating full offline backup (.tabletnotes.zip)…');
    try {
      const bytes = await buildBackupZipBytes();
      await saveOrShareFileBytes(bytes, `MyNotes-Backup-${new Date().toISOString().slice(0, 10)}.tabletnotes.zip`, 'application/zip');
    } catch (err) {
      alert(`Backup failed: ${(err as Error).message}`);
    } finally {
      setBusyMsg(null);
    }
  };

  const sorts: ['updated' | 'title' | 'created', string][] = [
    ['updated', 'Recent'],
    ['created', 'Created'],
    ['title', 'Title'],
  ];

  return (
    <div className="library">
      <aside className="sidebar">
        <div className="brand">
          <BookOpen size={22} aria-hidden /> <span>My Notes</span>
        </div>
        <nav>
          {nav('all', 'Notebooks', <BookOpen size={20} />)}
          <div className="sub">
            {nav('untagged', 'Untagged', <CircleDashed size={20} />, counts.untagged)}
            {nav('unfiled', 'Unfiled', <FolderOpen size={20} />, counts.unfiled)}
            {nav('trashed', 'Trashed', <Trash2 size={20} />, counts.trashed)}
          </div>
          {nav('pinned', 'Pinned', <Pin size={20} />)}
          <button
            className="nav-row"
            onClick={() => void handleExportAllBackup()}
            title="Export complete local backup (.tabletnotes.zip)"
          >
            <Download size={20} />
            <span>Export Backup</span>
          </button>
          <button
            className="nav-row"
            onClick={() => restoreInputRef.current?.click()}
            title="Restore from .tabletnotes.zip backup"
          >
            <Upload size={20} />
            <span>Restore Backup</span>
          </button>
          <button
            className="nav-row"
            onClick={() => actions.openWelcome('how-it-works')}
            title="Watch demo and installation guide"
          >
            <HelpCircle size={20} />
            <span>How It Works</span>
          </button>
          <button
            className="nav-row"
            onClick={() => actions.openWelcome('about-us')}
            title="About My Notes & Creator"
          >
            <Info size={20} />
            <span>About Us</span>
          </button>
        </nav>
        {s.persisted !== null && (
          <p className="persist">
            {s.persisted ? 'Persistent storage granted' : 'Persistent storage not granted – back up regularly'}
          </p>
        )}
      </aside>
      <main className="lib-main">
        <header className="lib-head">
          <h1>
            <BookOpen size={28} aria-hidden />{' '}
            {s.filter === 'trashed' ? 'Trashed' : s.filter === 'pinned' ? 'Pinned' : 'Notebooks'}
          </h1>
          <div className="tools">
            {busyMsg && <span className="chip">{busyMsg}</span>}
            {searchOpen && (
              <input
                autoFocus
                className="search"
                placeholder="Search"
                value={s.query}
                onChange={(e) => useApp.setState({ query: e.target.value })}
                aria-label="Search notebooks"
              />
            )}
            <button
              className="icon"
              aria-label="Search"
              onClick={() => {
                setSearchOpen(!searchOpen);
                if (searchOpen) useApp.setState({ query: '' });
              }}
            >
              <Search size={22} />
            </button>
            <button
              className="icon"
              aria-label={s.layout === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
              onClick={() => useApp.setState({ layout: s.layout === 'grid' ? 'list' : 'grid' })}
            >
              {s.layout === 'grid' ? <List size={22} /> : <LayoutGrid size={22} />}
            </button>
            <button
              className="icon"
              aria-label={`Sort: ${s.sort}`}
              onClick={() => useApp.setState({ sort: sorts[(sorts.findIndex((x) => x[0] === s.sort) + 1) % 3][0] })}
            >
              <ArrowUpDown size={22} />
              <span className="tip">{sorts.find((x) => x[0] === s.sort)![1]}</span>
            </button>
            <button
              className={`icon ${s.selecting ? 'on' : ''}`}
              aria-label="Select notebooks"
              aria-pressed={s.selecting}
              onClick={() => useApp.setState({ selecting: !s.selecting, selected: [] })}
            >
              <CheckSquare size={22} />
            </button>
            {s.selecting && s.selected.length > 0 && (
              <button
                className="icon"
                aria-label="Trash selected"
                onClick={async () => {
                  for (const id of s.selected) await actions.patchNotebook(id, { trashedAt: Date.now() });
                  useApp.setState({ selected: [], selecting: false });
                }}
              >
                <Trash2 size={22} />
              </button>
            )}
          </div>
        </header>

        <input
          ref={importInputRef}
          type="file"
          accept=".pdf,.zip,application/pdf,application/zip"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
        <input
          ref={scanInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleScanImage}
        />
        <input
          ref={restoreInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />

        {list.length === 0 ? (
          <div className="empty">
            <p>
              {s.query
                ? 'No notebooks match your search.'
                : s.filter === 'trashed'
                  ? 'Trash is empty.'
                  : 'No notebooks here yet.'}
            </p>
            {s.filter !== 'trashed' && (
              <button className="primary" onClick={() => setDialog(true)}>
                Create notebook
              </button>
            )}
          </div>
        ) : (
          <div className={s.layout === 'grid' ? 'grid' : 'rows'}>
            {list.map((n) => {
              const customCoverUrl = coverUrls[n.id];
              const isLocked = !!n.passwordLock;
              const isUnlockedInSession = isLocked && isDocumentUnlockedInSession(n.id);
              const coverStyle =
                n.hasCover === false
                  ? templateStyle(n.template ?? 'blank', n.paper)
                  : customCoverUrl
                    ? {
                        backgroundImage: `url(${customCoverUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }
                    : { background: n.cover };

              return (
                <div key={n.id} className="nb">
                  <button
                    className="cover-btn"
                    onClick={() => onOpen(n)}
                    aria-label={`Open ${n.title}${isLocked ? ' (Password protected)' : ''}`}
                  >
                    <div className={`cover ${n.hasCover === false ? 'paper-cover' : ''}`} style={coverStyle}>
                      {n.hasCover !== false && <div className="band" />}
                      <span className="age">{age(n.updatedAt)}</span>
                      {n.pinned && <Pin size={14} className="pinmark" aria-label="Pinned" />}
                      {isLocked && (
                        <span
                          className="lockmark"
                          title={isUnlockedInSession ? 'Password protected (Unlocked)' : 'Password protected (Locked)'}
                          style={{
                            position: 'absolute',
                            top: 8,
                            left: 8,
                            background: 'rgba(0,0,0,0.65)',
                            color: '#fff',
                            borderRadius: 999,
                            padding: '4px 6px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                          }}
                        >
                          {isUnlockedInSession ? <LockOpen size={12} /> : <Lock size={12} />}
                        </span>
                      )}
                      {s.selecting && (
                        <span className={`check ${s.selected.includes(n.id) ? 'on' : ''}`}>
                          {s.selected.includes(n.id) && <Check size={14} />}
                        </span>
                      )}
                    </div>
                  </button>
                  {renaming === n.id ? (
                    <input
                      className="rename"
                      autoFocus
                      defaultValue={n.title}
                      aria-label="Notebook title"
                      onBlur={(e) => {
                        void actions.renameNotebook(n.id, e.target.value.trim() || 'Untitled');
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                    />
                  ) : (
                    <div className="nb-title">
                      <span>{n.title}</span>
                      <button
                        className="icon sm"
                        aria-label={`Actions for ${n.title}`}
                        onClick={() => setRowMenu(rowMenu === n.id ? null : n.id)}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </div>
                  )}
                  {rowMenu === n.id && (
                    <div className="popover row-menu" role="menu">
                      {n.trashedAt ? (
                        <>
                          <button
                            role="menuitem"
                            onClick={() => {
                              void actions.patchNotebook(n.id, { trashedAt: null });
                              setRowMenu(null);
                            }}
                          >
                            Restore
                          </button>
                          <button
                            role="menuitem"
                            onClick={async () => {
                              if (confirm('Delete permanently?')) {
                                await repo.deleteNotebook(n.id);
                                useApp.setState({ notebooks: await repo.allNotebooks() });
                              }
                              setRowMenu(null);
                            }}
                          >
                            Delete forever
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setRenaming(n.id);
                              setRowMenu(null);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              void actions.patchNotebook(n.id, { pinned: !n.pinned });
                              setRowMenu(null);
                            }}
                          >
                            {n.pinned ? 'Unpin' : 'Pin'}
                          </button>
                          {!isLocked ? (
                            <button
                              role="menuitem"
                              onClick={() => {
                                setPwModal({ mode: 'set', notebook: n });
                                setRowMenu(null);
                              }}
                            >
                              <Lock size={15} /> Set Password
                            </button>
                          ) : (
                            <>
                              {isUnlockedInSession && (
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    void actions.lockNotebookNow(n.id);
                                    setRowMenu(null);
                                  }}
                                >
                                  <Lock size={15} /> Lock Now
                                </button>
                              )}
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setPwModal({ mode: 'change', notebook: n });
                                  setRowMenu(null);
                                }}
                              >
                                <KeyRound size={15} /> Change Password
                              </button>
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setPwModal({ mode: 'remove', notebook: n });
                                  setRowMenu(null);
                                }}
                              >
                                <LockOpen size={15} /> Remove Password
                              </button>
                            </>
                          )}
                          <button
                            role="menuitem"
                            onClick={() => {
                              void actions.patchNotebook(n.id, { trashedAt: Date.now() });
                              setRowMenu(null);
                            }}
                          >
                            Move to trash
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <button className="fab" aria-label="Create" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Plus size={26} />
        </button>
        {menu && (
          <>
            <div className="scrim" onClick={() => setMenu(false)} />
            <div className="popover create-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setDialog(true);
                }}
              >
                <BookOpen size={20} /> Notebook
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  void actions.createNotebook('Quick note');
                }}
              >
                <Zap size={20} /> Quick Create <Settings2 size={18} className="end" aria-hidden />
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  importInputRef.current?.click();
                }}
              >
                <Import size={20} /> Import File
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  scanInputRef.current?.click();
                }}
              >
                <ScanLine size={20} /> Scan Documents
              </button>
            </div>
          </>
        )}
      </main>
      {dialog && <NewNotebookDialog onClose={() => setDialog(false)} />}
      {pwModal && (
        <PasswordModal
          mode={pwModal.mode}
          targetName={pwModal.notebook.title}
          targetKind="notebook"
          onClose={() => setPwModal(null)}
          onSubmit={async ({ currentPassword, newPassword }) => {
            const nb = pwModal.notebook;
            if (pwModal.mode === 'set' && newPassword) {
              await actions.setNotebookPassword(nb.id, newPassword);
            } else if (pwModal.mode === 'unlock' && currentPassword) {
              await actions.unlockAndOpenNotebook(nb.id, currentPassword);
            } else if (pwModal.mode === 'change' && currentPassword && newPassword) {
              await actions.changeNotebookPassword(nb.id, currentPassword, newPassword);
            } else if (pwModal.mode === 'remove' && currentPassword) {
              await actions.removeNotebookPasswordAction(nb.id, currentPassword);
            }
          }}
        />
      )}
    </div>
  );
}
