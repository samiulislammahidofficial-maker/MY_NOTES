import { create } from 'zustand';
import { PAPER_SIZES, mmToPt, type CustomFontRecord, type PaperSize, type Template, type InkStroke, type Layer, type Notebook, type Page, type PaperKind, type TextBox } from '../domain/types';
import { AddPageCommand, AddStrokeCommand, ConvertInkToTextCommand, History, ReplaceCommand, UpdateTextBoxCommand, type StrokeTarget } from '../domain/history';
import { repo } from '../storage/db';
import { loadSavedCustomFonts } from '../fonts/registry';
import type { ToolKind, ToolSettings } from '../engine/tools';
import {
  clearSessionUnlock,
  getSessionPassword,
  isDocumentUnlockedInSession,
  lockNotebookAtRest,
  lockPageAtRest,
  removeNotebookPassword,
  removePagePassword,
  unlockNotebookToMemory,
  unlockPageToMemory,
} from '../security/passwordLock';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
export type Filter = 'all' | 'untagged' | 'unfiled' | 'trashed' | 'pinned';
export type Sort = 'updated' | 'title' | 'created';

export interface Pane {
  notebookId: string;
  pageId: string;
}

export interface NewNotebookOptions {
  cover?: string;
  coverAssetId?: string;
  hasCover?: boolean;
  template?: Template;
  size?: PaperSize;
  landscape?: boolean;
  tags?: string[];
  paper?: PaperKind;
}

export interface Preset {
  color: string;
  widthMm: number;
}

interface State {
  ready: boolean;
  notebooks: Notebook[];
  mode: 'welcome' | 'library' | 'editor';
  welcomeAnchor: 'top' | 'how-it-works' | 'about-us';
  filter: Filter;
  query: string;
  sort: Sort;
  layout: 'grid' | 'list';
  selecting: boolean;
  selected: string[];
  tabs: string[];
  panes: Pane[];
  activePane: number;
  split: boolean;
  pagesOpen: boolean;
  debug: boolean;
  save: SaveStatus;
  saveError: string | null;
  persisted: boolean | null;
  tool: ToolSettings;
  presets: Preset[];
  activePreset: number;
  paper: PaperKind;
  canUndo: boolean;
  canRedo: boolean;
  strokeVersion: number;
  layerVersion: number;
  layersOpen: boolean;
  hasClipboard: boolean;
  customFonts: CustomFontRecord[];
  activeFontFamily: string;
  activeFontAssetId?: string;
  activeFontSize: number;
  geminiOptIn: boolean;
  geminiKey: string;
  geminiModel: string;
  pageViewMode: 'single' | 'continuous';
  liveAnnouncement: string;
}

const initialPageViewMode = ((): 'single' | 'continuous' => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('mynotes.pageViewMode') : null;
    return v === 'continuous' ? 'continuous' : 'single';
  } catch {
    return 'single';
  }
})();

const initialWelcomed = (() => {
  try {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (hash === '#welcome' || hash === '#how-it-works' || hash === '#about-us') return false;
    if (hash === '#library') return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('mynotes.welcomed') === '1';
  } catch {
    return true;
  }
})();

export const useApp = create<State>(() => ({
  ready: false,
  notebooks: [],
  mode: initialWelcomed ? 'library' : 'welcome',
  welcomeAnchor: 'top',
  filter: 'all',
  query: '',
  sort: 'updated',
  layout: 'grid',
  selecting: false,
  selected: [],
  tabs: [],
  panes: [],
  activePane: 0,
  split: false,
  pagesOpen: false,
  debug: false,
  save: 'idle',
  saveError: null,
  persisted: null,
  tool: {
    kind: 'pen', nib: 'ballpoint', strokeStyle: 'solid', color: '#F4F436', rainbow: false, width: mmToPt(0.45), opacity: 1,
    hlColor: '#FFE600', hlWidth: mmToPt(5), hlOpacity: 0.4,
    eraserMode: 'pixel', eraserRadius: 8, shape: 'line', scribbleErase: true, shapeSnap: true, rulerVisible: false, rulerUnits: 'metric', stabilizer: 0.3,
    penOnly: true, fingerDrawing: false, constantPressure: 0.5,
  },
  presets: [
    { color: '#F4F436', widthMm: 0.45 },
    { color: '#FFFFFF', widthMm: 0.5 },
    { color: '#BD45E5', widthMm: 0.38 },
  ],
  activePreset: 0,
  paper: '#000000',
  canUndo: false,
  canRedo: false,
  strokeVersion: 0,
  layerVersion: 0,
  layersOpen: false,
  hasClipboard: false,
  customFonts: [],
  activeFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  activeFontAssetId: undefined,
  activeFontSize: 20,
  geminiOptIn: false,
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  pageViewMode: initialPageViewMode,
  liveAnnouncement: '',
}));

const set = useApp.setState;
const get = useApp.getState;

// ---- in-memory documents ----
const strokesByPage = new Map<string, InkStroke[]>();
const textsByPage = new Map<string, TextBox[]>();
const pageNotebook = new Map<string, string>();
const histories = new Map<string, History>();
const pagesByNotebook = new Map<string, Page[]>();
let pending = 0;
let initPromise: Promise<void> | null = null;
const layersByPage = new Map<string, Layer[]>();
const activeLayerByPage = new Map<string, string>();
let clipboard: InkStroke[] = [];
export const getLayers = (pageId: string) => layersByPage.get(pageId) ?? [];
export const getActiveLayer = (pageId: string) => activeLayerByPage.get(pageId) ?? layersByPage.get(pageId)?.[0]?.id;

export const getStrokes = (pageId: string) => strokesByPage.get(pageId) ?? [];
export const getTexts = (pageId: string) => textsByPage.get(pageId) ?? [];
export const getPages = (nbId: string) => pagesByNotebook.get(nbId) ?? [];

function history(nbId: string) {
  let h = histories.get(nbId);
  if (!h) histories.set(nbId, (h = new History()));
  return h;
}

const dirtyPages = new Set<string>();
const pendingPromises = new Set<Promise<void>>();
const syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mynotes-sync-v1') : null;

export const hasPendingWrites = () => pending > 0 || dirtyPages.size > 0;
export const flushPendingWrites = async () => {
  if (pendingPromises.size > 0) {
    await Promise.allSettled([...pendingPromises]);
  }
  if (dirtyPages.size > 0) {
    await actions.retryFailedSaves();
  }
};

function track(op: () => Promise<void>, pageId?: string, nbId?: string) {
  pending++;
  set({ save: 'saving', saveError: null });
  const p = op();
  pendingPromises.add(p);
  p.then(
    () => {
      pendingPromises.delete(p);
      pending--;
      if (pageId) dirtyPages.delete(pageId);
      if (nbId) syncChannel?.postMessage({ type: 'notebook-updated', notebookId: nbId, pageId });
      if (pending === 0 && dirtyPages.size === 0 && get().save !== 'failed') set({ save: 'saved' });
    },
    (err: unknown) => {
      pendingPromises.delete(p);
      pending--;
      if (pageId) dirtyPages.add(pageId);
      // keep dirty state in memory; report truthfully
      set({ save: 'failed', saveError: err instanceof Error ? err.message : 'Write failed' });
    },
  );
}

async function persistEncryptedIfLocked(pageId: string, nbId: string): Promise<boolean> {
  const nb = get().notebooks.find((n) => n.id === nbId);
  const nbPw = getSessionPassword(nbId);
  if (nb?.passwordLock && nbPw) {
    const pages = getPages(nbId);
    const sMap: Record<string, InkStroke[]> = {};
    const tMap: Record<string, TextBox[]> = {};
    for (const p of pages) {
      sMap[p.id] = getStrokes(p.id);
      tMap[p.id] = getTexts(p.id);
    }
    const env = await lockNotebookAtRest(nb, nbPw, sMap, tMap);
    set({
      notebooks: get().notebooks.map((n) => (n.id === nbId ? { ...n, passwordLock: env, updatedAt: Date.now() } : n)),
    });
    return true;
  }
  const page = getPages(nbId).find((p) => p.id === pageId);
  const pagePw = getSessionPassword(pageId);
  if (page?.passwordLock && pagePw) {
    const env = await lockPageAtRest(page, pagePw, getStrokes(pageId), getTexts(pageId));
    pagesByNotebook.set(
      nbId,
      getPages(nbId).map((p) => (p.id === pageId ? { ...p, passwordLock: env } : p)),
    );
    return true;
  }
  return false;
}

const target: StrokeTarget = {
  addStroke(s) {
    const list = [...getStrokes(s.pageId), s];
    strokesByPage.set(s.pageId, list);
    const nb = pageNotebook.get(s.pageId)!;
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
    track(
      () =>
        persistEncryptedIfLocked(s.pageId, nb).then((handled) => {
          if (!handled) return repo.addStroke(s, nb);
        }),
      s.pageId,
      nb,
    );
  },
  replace(pageId, remove, add) {
    const rm = new Set(remove.map((s) => s.id));
    strokesByPage.set(pageId, [...getStrokes(pageId).filter((s) => !rm.has(s.id)), ...add]);
    const nb = pageNotebook.get(pageId)!;
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
    track(
      () =>
        persistEncryptedIfLocked(pageId, nb).then((handled) => {
          if (!handled) return repo.replaceStrokes(remove.map((s) => s.id), add, nb);
        }),
      pageId,
      nb,
    );
  },
  removeStroke(pageId, id) {
    strokesByPage.set(pageId, getStrokes(pageId).filter((s) => s.id !== id));
    const nb = pageNotebook.get(pageId)!;
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
    track(
      () =>
        persistEncryptedIfLocked(pageId, nb).then((handled) => {
          if (!handled) return repo.removeStroke(id, nb);
        }),
      pageId,
      nb,
    );
  },
  addText(tb) {
    const list = [...getTexts(tb.pageId).filter((x) => x.id !== tb.id), tb];
    textsByPage.set(tb.pageId, list);
    const nb = pageNotebook.get(tb.pageId)!;
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
    track(
      () =>
        persistEncryptedIfLocked(tb.pageId, nb).then((handled) => {
          if (!handled) return repo.putText(tb, nb);
        }),
      tb.pageId,
      nb,
    );
  },
  removeText(pageId, id) {
    textsByPage.set(pageId, getTexts(pageId).filter((x) => x.id !== id));
    const nb = pageNotebook.get(pageId)!;
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
    track(
      () =>
        persistEncryptedIfLocked(pageId, nb).then((handled) => {
          if (!handled) return repo.deleteText(id, nb);
        }),
      pageId,
      nb,
    );
  },
  insertPage(notebookId, page, layer, afterPageId) {
    const nb = get().notebooks.find((n) => n.id === notebookId);
    if (!nb) return;
    pageNotebook.set(page.id, notebookId);
    if (!strokesByPage.has(page.id)) strokesByPage.set(page.id, []);
    if (!textsByPage.has(page.id)) textsByPage.set(page.id, []);
    if (!layersByPage.has(page.id)) layersByPage.set(page.id, [layer]);

    const curPageIds = nb.pageIds.includes(page.id) ? [...nb.pageIds] : [...nb.pageIds];
    if (!curPageIds.includes(page.id)) {
      const idx = afterPageId ? curPageIds.indexOf(afterPageId) : -1;
      if (idx >= 0) curPageIds.splice(idx + 1, 0, page.id);
      else curPageIds.push(page.id);
    }

    const curPages = getPages(notebookId).filter((p) => p.id !== page.id);
    const pageMap = new Map<string, Page>(curPages.map((p) => [p.id, p]));
    pageMap.set(page.id, page);
    const orderedPages = curPageIds.map((pid) => pageMap.get(pid)).filter((p): p is Page => !!p);
    pagesByNotebook.set(notebookId, orderedPages);

    const updatedNb: Notebook = {
      ...nb,
      pageIds: curPageIds,
      updatedAt: Date.now(),
      revision: nb.revision + 1,
    };

    const st = get();
    const panes = st.panes.map((pn, i) => (i === st.activePane && pn.notebookId === notebookId ? { ...pn, pageId: page.id } : pn));
    set({
      notebooks: st.notebooks.map((n) => (n.id === notebookId ? updatedNb : n)),
      panes,
      strokeVersion: st.strokeVersion + 1,
      layerVersion: st.layerVersion + 1,
    });

    track(
      async () => {
        await repo.createNotebook(updatedNb, page, layer);
        await persistEncryptedIfLocked(page.id, notebookId);
      },
      page.id,
      notebookId,
    );
  },
  removeAddedPage(notebookId, pageId, fallbackPageId) {
    const nb = get().notebooks.find((n) => n.id === notebookId);
    if (!nb || nb.pageIds.length <= 1) return;
    // Do not destroy subsequently written content if strokes or texts remain on this page
    if (getStrokes(pageId).length > 0 || getTexts(pageId).length > 0) return;
    const nextPageIds = nb.pageIds.filter((id) => id !== pageId);
    const nextPages = getPages(notebookId).filter((p) => p.id !== pageId);
    pagesByNotebook.set(notebookId, nextPages);
    const updatedNb: Notebook = {
      ...nb,
      pageIds: nextPageIds,
      updatedAt: Date.now(),
      revision: nb.revision + 1,
    };
    const st = get();
    const fallback = fallbackPageId && nextPageIds.includes(fallbackPageId) ? fallbackPageId : nextPageIds[nextPageIds.length - 1];
    const panes = st.panes.map((pn) => (pn.notebookId === notebookId && pn.pageId === pageId ? { ...pn, pageId: fallback } : pn));
    set({
      notebooks: st.notebooks.map((n) => (n.id === notebookId ? updatedNb : n)),
      panes,
      strokeVersion: st.strokeVersion + 1,
      layerVersion: st.layerVersion + 1,
    });
    track(
      async () => {
        await repo.updateNotebook(updatedNb);
        if (updatedNb.passwordLock && getSessionPassword(notebookId)) {
          await persistEncryptedIfLocked(fallback, notebookId);
        }
      },
      fallback,
      notebookId,
    );
  },
};

function refreshUndo() {
  const p = get().panes[get().activePane];
  if (!p) return set({ canUndo: false, canRedo: false });
  const h = history(p.notebookId);
  set({ canUndo: h.canUndo, canRedo: h.canRedo });
}

export const actions = {
  init(): Promise<void> {
    // single-flight: StrictMode / retries must not create duplicate sample notebooks
    initPromise ??= actions._init().catch((e) => {
      initPromise = null;
      throw e;
    });
    return initPromise;
  },

  async _init() {
    const nbs = await repo.allNotebooks();
    if (nbs.length === 0) {
      await actions.createNotebook('Sample', false);
    } else {
      set({ notebooks: nbs });
    }
    const customFonts = await loadSavedCustomFonts().catch(() => []);
    set({ notebooks: await repo.allNotebooks(), customFonts, ready: true });

    if (syncChannel) {
      syncChannel.onmessage = async (ev) => {
        const msg = ev.data as { type?: string; notebookId?: string; pageId?: string };
        if (msg?.type === 'notebook-updated' && msg.notebookId) {
          // Do not overwrite a page that currently has unsaved dirty writes in this tab
          if (msg.pageId && dirtyPages.has(msg.pageId)) return;
          const all = await repo.allNotebooks();
          set({ notebooks: all });
          if (get().tabs.includes(msg.notebookId)) {
            if (msg.pageId) {
              strokesByPage.delete(msg.pageId);
              textsByPage.delete(msg.pageId);
            }
            await actions.loadNotebook(msg.notebookId);
            set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
          }
        }
      };
    }

    try {
      if (navigator.storage?.persist) {
        const already = (await navigator.storage.persisted?.()) ?? false;
        set({ persisted: already || (await navigator.storage.persist()) });
      }
    } catch {
      set({ persisted: false });
    }
  },

  async retryFailedSaves() {
    if (dirtyPages.size === 0 && get().save !== 'failed') return;
    set({ save: 'saving', saveError: null });
    try {
      for (const pageId of [...dirtyPages]) {
        const nbId = pageNotebook.get(pageId);
        if (!nbId) continue;
        const handled = await persistEncryptedIfLocked(pageId, nbId);
        if (!handled) {
          const strokes = getStrokes(pageId);
          await repo.replaceStrokes(strokes.map((s) => s.id), strokes, nbId);
          for (const tb of getTexts(pageId)) {
            await repo.putText(tb, nbId);
          }
        }
        dirtyPages.delete(pageId);
      }
      set({ save: 'saved', saveError: null });
    } catch (err: unknown) {
      set({ save: 'failed', saveError: err instanceof Error ? err.message : 'Retry failed' });
    }
  },

  async createNotebook(title = 'Untitled', open = true, o: NewNotebookOptions = {}): Promise<string> {
    const size = PAPER_SIZES[o.size ?? 'A4'];
    const landscape = o.landscape ?? false;
    const now = Date.now();
    const id = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const layer: Layer = { id: crypto.randomUUID(), pageId, name: 'Ink', visible: true, locked: false, opacity: 1 };
    const page: Page = { id: pageId, notebookId: id, width: landscape ? size.height : size.width, height: landscape ? size.width : size.height, layerIds: [layer.id], revision: 1 };
    const nb: Notebook = {
      id,
      title,
      cover: o.cover ?? '#385E51',
      coverAssetId: o.coverAssetId,
      hasCover: o.hasCover ?? true,
      template: o.template ?? 'blank',
      size: o.size ?? 'A4',
      landscape,
      folderId: null,
      tags: o.tags ?? [],
      pinned: false,
      trashedAt: null,
      pageIds: [pageId],
      createdAt: now,
      updatedAt: now,
      revision: 1,
      paper: o.paper ?? '#000000',
    };
    await repo.createNotebook(nb, page, layer);
    set({ notebooks: await repo.allNotebooks() });
    if (open) await actions.openNotebook(id);
    return id;
  },

  async renameNotebook(id: string, title: string) {
    const nb = get().notebooks.find((n) => n.id === id);
    if (!nb) return;
    await repo.updateNotebook({ ...nb, title, updatedAt: Date.now() });
    set({ notebooks: await repo.allNotebooks() });
  },

  async patchNotebook(id: string, patch: Partial<Notebook>) {
    const nb = get().notebooks.find((n) => n.id === id);
    if (!nb) return;
    await repo.updateNotebook({ ...nb, ...patch, updatedAt: Date.now() });
    set({ notebooks: await repo.allNotebooks() });
  },

  async loadNotebook(id: string) {
    const pages = await repo.getPages(id);
    const nb = get().notebooks.find((n) => n.id === id);
    const ordered = nb ? nb.pageIds.map((pid) => pages.find((p) => p.id === pid)).filter((p): p is Page => !!p) : pages;
    pagesByNotebook.set(id, ordered);
    for (const p of ordered) {
      pageNotebook.set(p.id, id);
      if (!strokesByPage.has(p.id)) strokesByPage.set(p.id, await repo.getStrokes(p.id));
      if (!textsByPage.has(p.id)) textsByPage.set(p.id, await repo.getTexts(p.id));
      if (!layersByPage.has(p.id)) {
        const ls = await repo.getLayers(p.id);
        layersByPage.set(p.id, p.layerIds.map((id) => ls.find((l) => l.id === id)).filter((l): l is Layer => !!l));
      }
    }
    return ordered;
  },

  async openNotebook(id: string, pane?: number) {
    const pages = await actions.loadNotebook(id);
    if (!pages.length) return;
    const nb = get().notebooks.find((n) => n.id === id);
    const st = get();
    const idx = pane ?? (st.mode === 'editor' ? st.activePane : 0);
    const panes = [...st.panes];
    panes[idx] = { notebookId: id, pageId: pages[0].id };
    const tabs = st.tabs.includes(id) ? st.tabs : [...st.tabs, id];
    const pageViewMode = nb?.pageViewMode ?? st.pageViewMode;
    set({ mode: 'editor', panes, tabs, activePane: idx, paper: nb?.paper ?? '#000000', pageViewMode });
    refreshUndo();
  },

  closeTab(id: string) {
    const st = get();
    const tabs = st.tabs.filter((t) => t !== id);
    const panes = st.panes.filter((p) => p.notebookId !== id);
    if (tabs.length === 0) return set({ tabs, panes: [], mode: 'library', split: false });
    set({ tabs, panes: panes.length ? panes : [{ notebookId: tabs[0], pageId: getPages(tabs[0])[0]?.id }], activePane: 0, split: panes.length > 1 && st.split });
    refreshUndo();
  },

  openLibrary() {
    try {
      localStorage.setItem('mynotes.welcomed', '1');
      if (window.location.hash === '#welcome' || window.location.hash === '#how-it-works' || window.location.hash === '#about-us') {
        window.history?.replaceState?.(null, '', '#library');
      }
    } catch {
      /* ignore */
    }
    set({ mode: 'library' });
  },

  openWelcome(anchor: 'top' | 'how-it-works' | 'about-us' = 'top') {
    set({ mode: 'welcome', welcomeAnchor: anchor });
  },

  async setNotebookPassword(id: string, password: string) {
    await actions.loadNotebook(id);
    const nb = get().notebooks.find((n) => n.id === id);
    if (!nb) return;
    const pages = getPages(id);
    const sMap: Record<string, InkStroke[]> = {};
    const tMap: Record<string, TextBox[]> = {};
    for (const p of pages) {
      sMap[p.id] = getStrokes(p.id);
      tMap[p.id] = getTexts(p.id);
    }
    await lockNotebookAtRest(nb, password, sMap, tMap);
    // Lock immediately so opening it requires the password unless currently editing in active pane
    const isCurrentlyOpen = get().mode === 'editor' && get().tabs.includes(id);
    if (!isCurrentlyOpen) {
      clearSessionUnlock(id);
      for (const p of pages) {
        strokesByPage.delete(p.id);
        textsByPage.delete(p.id);
      }
    } else {
      await unlockNotebookToMemory({ ...nb, passwordLock: (await repo.allNotebooks()).find((x) => x.id === id)?.passwordLock }, password);
    }
    set({ notebooks: await repo.allNotebooks() });
  },

  async unlockAndOpenNotebook(id: string, password: string, pane?: number) {
    const all = await repo.allNotebooks();
    const nb = all.find((n) => n.id === id);
    if (!nb) throw new Error('Notebook not found.');
    const { strokesByPage: sMap, textsByPage: tMap } = await unlockNotebookToMemory(nb, password);
    const pages = await repo.getPages(id);
    const ordered = nb.pageIds.map((pid) => pages.find((p) => p.id === pid)).filter((p): p is Page => !!p);
    pagesByNotebook.set(id, ordered);
    for (const p of ordered) {
      pageNotebook.set(p.id, id);
      strokesByPage.set(p.id, sMap[p.id] ?? []);
      textsByPage.set(p.id, tMap[p.id] ?? []);
      const ls = await repo.getLayers(p.id);
      layersByPage.set(p.id, p.layerIds.map((lid) => ls.find((l) => l.id === lid)).filter((l): l is Layer => !!l));
    }
    const st = get();
    const idx = pane ?? (st.mode === 'editor' ? st.activePane : 0);
    const panes = [...st.panes];
    panes[idx] = { notebookId: id, pageId: ordered[0].id };
    const tabs = st.tabs.includes(id) ? st.tabs : [...st.tabs, id];
    set({ notebooks: all, mode: 'editor', panes, tabs, activePane: idx, paper: nb.paper ?? '#000000', strokeVersion: st.strokeVersion + 1 });
    refreshUndo();
  },

  async changeNotebookPassword(id: string, currentPassword: string, newPassword: string) {
    const all = await repo.allNotebooks();
    const nb = all.find((n) => n.id === id);
    if (!nb) throw new Error('Notebook not found.');
    const { strokesByPage: sMap, textsByPage: tMap } = await unlockNotebookToMemory(nb, currentPassword);
    // Merge any in-memory edits if currently unlocked
    if (isDocumentUnlockedInSession(id)) {
      for (const p of getPages(id)) {
        if (strokesByPage.has(p.id)) sMap[p.id] = getStrokes(p.id);
        if (textsByPage.has(p.id)) tMap[p.id] = getTexts(p.id);
      }
    }
    await lockNotebookAtRest(nb, newPassword, sMap, tMap);
    const updatedAll = await repo.allNotebooks();
    const updatedNb = updatedAll.find((n) => n.id === id)!;
    if (get().mode === 'editor' && get().tabs.includes(id)) {
      await unlockNotebookToMemory(updatedNb, newPassword);
    } else {
      clearSessionUnlock(id);
    }
    set({ notebooks: updatedAll });
  },

  async removeNotebookPasswordAction(id: string, currentPassword: string) {
    const all = await repo.allNotebooks();
    const nb = all.find((n) => n.id === id);
    if (!nb) throw new Error('Notebook not found.');
    const inMemS: Record<string, InkStroke[]> | undefined = isDocumentUnlockedInSession(id)
      ? Object.fromEntries(getPages(id).map((p) => [p.id, getStrokes(p.id)]))
      : undefined;
    const inMemT: Record<string, TextBox[]> | undefined = isDocumentUnlockedInSession(id)
      ? Object.fromEntries(getPages(id).map((p) => [p.id, getTexts(p.id)]))
      : undefined;
    const { strokesByPage: sMap, textsByPage: tMap } = await removeNotebookPassword(nb, currentPassword, inMemS, inMemT);
    for (const [pid, s] of Object.entries(sMap)) strokesByPage.set(pid, s);
    for (const [pid, t] of Object.entries(tMap)) textsByPage.set(pid, t);
    set((st) => ({ notebooks: [], strokeVersion: st.strokeVersion + 1 }));
    set({ notebooks: await repo.allNotebooks() });
  },

  async lockNotebookNow(id: string) {
    const nb = get().notebooks.find((n) => n.id === id);
    const pw = getSessionPassword(id);
    const pages = getPages(id);
    if (nb?.passwordLock && pw) {
      const sMap: Record<string, InkStroke[]> = {};
      const tMap: Record<string, TextBox[]> = {};
      for (const p of pages) {
        sMap[p.id] = getStrokes(p.id);
        tMap[p.id] = getTexts(p.id);
      }
      await lockNotebookAtRest(nb, pw, sMap, tMap);
    }
    clearSessionUnlock(id);
    for (const p of pages) {
      strokesByPage.delete(p.id);
      textsByPage.delete(p.id);
    }
    histories.delete(id);
    set({ notebooks: await repo.allNotebooks() });
    if (get().tabs.includes(id)) {
      actions.closeTab(id);
    }
  },

  async setPagePassword(pageId: string, password: string) {
    const nbId = pageNotebook.get(pageId);
    if (!nbId) return;
    const page = getPages(nbId).find((p) => p.id === pageId);
    if (!page) return;
    const env = await lockPageAtRest(page, password, getStrokes(pageId), getTexts(pageId));
    const updatedPage: Page = { ...page, passwordLock: env };
    pagesByNotebook.set(
      nbId,
      getPages(nbId).map((p) => (p.id === pageId ? updatedPage : p)),
    );
    clearSessionUnlock(pageId);
    strokesByPage.set(pageId, []);
    textsByPage.set(pageId, []);
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
  },

  async unlockPageAction(pageId: string, password: string) {
    const nbId = pageNotebook.get(pageId);
    if (!nbId) return;
    const pages = await repo.getPages(nbId);
    const page = pages.find((p) => p.id === pageId);
    if (!page) throw new Error('Page not found.');
    const { strokes, texts } = await unlockPageToMemory(page, password);
    strokesByPage.set(pageId, strokes);
    textsByPage.set(pageId, texts);
    pagesByNotebook.set(
      nbId,
      getPages(nbId).map((p) => (p.id === pageId ? page : p)),
    );
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
  },

  async changePagePassword(pageId: string, currentPassword: string, newPassword: string) {
    const nbId = pageNotebook.get(pageId);
    if (!nbId) return;
    const pages = await repo.getPages(nbId);
    const page = pages.find((p) => p.id === pageId);
    if (!page) throw new Error('Page not found.');
    const { strokes, texts } = await unlockPageToMemory(page, currentPassword);
    const activeStrokes = isDocumentUnlockedInSession(pageId) && strokesByPage.get(pageId)?.length ? getStrokes(pageId) : strokes;
    const activeTexts = isDocumentUnlockedInSession(pageId) && textsByPage.get(pageId)?.length ? getTexts(pageId) : texts;
    const env = await lockPageAtRest(page, newPassword, activeStrokes, activeTexts);
    const updatedPage: Page = { ...page, passwordLock: env };
    await unlockPageToMemory(updatedPage, newPassword);
    strokesByPage.set(pageId, activeStrokes);
    textsByPage.set(pageId, activeTexts);
    pagesByNotebook.set(
      nbId,
      getPages(nbId).map((p) => (p.id === pageId ? updatedPage : p)),
    );
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
  },

  async removePagePasswordAction(pageId: string, currentPassword: string) {
    const nbId = pageNotebook.get(pageId);
    if (!nbId) return;
    const pages = await repo.getPages(nbId);
    const page = pages.find((p) => p.id === pageId);
    if (!page) throw new Error('Page not found.');
    const inMemS = isDocumentUnlockedInSession(pageId) && strokesByPage.get(pageId)?.length ? getStrokes(pageId) : undefined;
    const inMemT = isDocumentUnlockedInSession(pageId) && textsByPage.get(pageId)?.length ? getTexts(pageId) : undefined;
    const { strokes, texts } = await removePagePassword(page, currentPassword, inMemS, inMemT);
    strokesByPage.set(pageId, strokes);
    textsByPage.set(pageId, texts);
    pagesByNotebook.set(
      nbId,
      getPages(nbId).map((p) => (p.id === pageId ? { ...p, passwordLock: null } : p)),
    );
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
  },

  async lockPageNow(pageId: string) {
    const nbId = pageNotebook.get(pageId);
    if (!nbId) return;
    const page = getPages(nbId).find((p) => p.id === pageId);
    const pw = getSessionPassword(pageId);
    if (page?.passwordLock && pw) {
      const env = await lockPageAtRest(page, pw, getStrokes(pageId), getTexts(pageId));
      pagesByNotebook.set(
        nbId,
        getPages(nbId).map((p) => (p.id === pageId ? { ...p, passwordLock: env } : p)),
      );
    }
    clearSessionUnlock(pageId);
    strokesByPage.set(pageId, []);
    textsByPage.set(pageId, []);
    set((st) => ({ strokeVersion: st.strokeVersion + 1 }));
  },

  closeEditor() {
    set({ mode: 'library' });
  },

  setPage(pane: number, pageId: string) {
    const panes = [...get().panes];
    panes[pane] = { ...panes[pane], pageId };
    set({ panes });
  },

  setActivePane(i: number) {
    if (get().activePane === i) return;
    const p = get().panes[i];
    set({ activePane: i, paper: get().notebooks.find((n) => n.id === p?.notebookId)?.paper ?? get().paper });
    refreshUndo();
  },

  toggleSplit() {
    const st = get();
    if (st.split) return set({ split: false, panes: st.panes.slice(0, 1), activePane: 0 });
    const p = st.panes[st.activePane];
    if (!p) return;
    set({ split: true, panes: [st.panes[st.activePane], { ...p }], activePane: 1 });
  },

  commitEdit(label: string, remove: InkStroke[], add: InkStroke[]) {
    const pageId = (remove[0] ?? add[0])?.pageId;
    const nb = pageId && pageNotebook.get(pageId);
    if (!pageId || !nb) return;
    history(nb).run(new ReplaceCommand(label, pageId, remove, add), target);
    refreshUndo();
  },

  setToolKind(kind: ToolKind) {
    set((s) => ({ tool: { ...s.tool, kind } }));
  },

  copy(list: InkStroke[]) {
    clipboard = list;
    set({ hasClipboard: list.length > 0 });
  },
  getClipboard: () => clipboard,

  commitStroke(s: InkStroke) {
    const nb = pageNotebook.get(s.pageId);
    if (!nb) return;
    history(nb).run(new AddStrokeCommand(s), target, s.id);
    refreshUndo();
  },

  undo() {
    const p = get().panes[get().activePane];
    if (!p) return;
    history(p.notebookId).undo(target);
    refreshUndo();
  },
  redo() {
    const p = get().panes[get().activePane];
    if (!p) return;
    history(p.notebookId).redo(target);
    refreshUndo();
  },

  setPaper(paper: PaperKind) {
    const p = get().panes[get().activePane];
    set({ paper });
    if (p) void actions.patchNotebook(p.notebookId, { paper });
  },

  selectPreset(i: number) {
    const pr = get().presets[i];
    set((s) => ({ activePreset: i, tool: { ...s.tool, kind: s.tool.kind === 'highlighter' || s.tool.kind === 'pen' || s.tool.kind === 'shape' ? s.tool.kind : 'pen', color: pr.color, width: mmToPt(pr.widthMm) } }));
  },
  updatePreset(i: number, patch: Partial<Preset>) {
    const presets = get().presets.map((p, j) => (j === i ? { ...p, ...patch } : p));
    set({ presets });
    if (get().activePreset === i) actions.selectPreset(i);
  },
  setTool(patch: Partial<ToolSettings>) {
    set((s) => ({ tool: { ...s.tool, ...patch } }));
  },

  addPreset() {
    const t = get().tool;
    const widthMm = +(t.width * 25.4 / 72).toFixed(2);
    const presets = [...get().presets, { color: t.color, widthMm }];
    set({ presets, activePreset: presets.length - 1 });
  },

  commitConvertInkToText(pageId: string, sourceStrokes: InkStroke[], tb: TextBox, replaceInk: boolean) {
    const nb = pageNotebook.get(pageId);
    if (!nb) return;
    history(nb).run(new ConvertInkToTextCommand(pageId, sourceStrokes, tb, replaceInk), target);
    refreshUndo();
  },

  commitTextEdit(pageId: string, prev: TextBox | null, next: TextBox | null) {
    const nb = pageNotebook.get(pageId);
    if (!nb) return;
    history(nb).run(new UpdateTextBoxCommand(pageId, prev, next), target);
    refreshUndo();
  },

  async refreshNotebooksAndFonts() {
    const customFonts = await loadSavedCustomFonts().catch(() => []);
    set({ notebooks: await repo.allNotebooks(), customFonts });
  },

  async mutateLayer(pageId: string, id: string, patch: Partial<Layer>) {
    const list = getLayers(pageId).map((l) => (l.id === id ? { ...l, ...patch } : l));
    layersByPage.set(pageId, list);
    set((s) => ({ layerVersion: s.layerVersion + 1, strokeVersion: s.strokeVersion + 1 }));
    const l = list.find((x) => x.id === id);
    if (l) track(() => repo.putLayer(l), pageId);
  },
  async addLayer(pageId: string) {
    const list = getLayers(pageId);
    const layer: Layer = { id: crypto.randomUUID(), pageId, name: `Layer ${list.length + 1}`, visible: true, locked: false, opacity: 1 };
    layersByPage.set(pageId, [...list, layer]);
    activeLayerByPage.set(pageId, layer.id);
    await actions.persistLayerOrder(pageId);
  },
  async moveLayer(pageId: string, id: string, dir: -1 | 1) {
    const list = [...getLayers(pageId)];
    const i = list.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    layersByPage.set(pageId, list);
    await actions.persistLayerOrder(pageId);
  },
  async deleteLayer(pageId: string, id: string) {
    const list = getLayers(pageId);
    if (list.length <= 1) return;
    const keep = list.filter((l) => l.id !== id);
    const doomed = getStrokes(pageId).filter((s) => s.layerId === id);
    layersByPage.set(pageId, keep);
    if (activeLayerByPage.get(pageId) === id) activeLayerByPage.set(pageId, keep[0].id);
    // strokes on a deleted layer go through the command stack so it is undoable
    if (doomed.length) actions.commitEdit('Delete layer', doomed, []);
    await actions.persistLayerOrder(pageId);
  },
  setActiveLayer(pageId: string, id: string) {
    activeLayerByPage.set(pageId, id);
    set((s) => ({ layerVersion: s.layerVersion + 1 }));
  },
  async persistLayerOrder(pageId: string) {
    const nbId = pageNotebook.get(pageId)!;
    const list = getLayers(pageId);
    const pages = getPages(nbId).map((p) => (p.id === pageId ? { ...p, layerIds: list.map((l) => l.id) } : p));
    pagesByNotebook.set(nbId, pages);
    set((s) => ({ layerVersion: s.layerVersion + 1, strokeVersion: s.strokeVersion + 1 }));
    const page = pages.find((p) => p.id === pageId)!;
    track(() => repo.saveLayers(page, list), pageId, nbId);
  },

  async addPage(pane: number): Promise<string | null> {
    return actions.addPageAfter(pane);
  },

  async addPageAfter(pane: number, afterPageId?: string): Promise<string | null> {
    const p = get().panes[pane];
    const nb = p && get().notebooks.find((n) => n.id === p.notebookId);
    if (!nb) return null;
    const pageId = crypto.randomUUID();
    const layer: Layer = { id: crypto.randomUUID(), pageId, name: 'Ink', visible: true, locked: false, opacity: 1 };
    // Unprotected page created next to an individually password-locked page does NOT inherit a page password;
    // if the notebook itself has a passwordLock, insertPage encrypts the notebook envelope via persistEncryptedIfLocked.
    const page: Page = {
      id: pageId,
      notebookId: nb.id,
      width: nb.landscape ? PAPER_SIZES[nb.size].height : PAPER_SIZES[nb.size].width,
      height: nb.landscape ? PAPER_SIZES[nb.size].width : PAPER_SIZES[nb.size].height,
      layerIds: [layer.id],
      revision: 1,
    };
    const anchor = afterPageId ?? nb.pageIds[nb.pageIds.length - 1];
    actions.setActivePane(pane);
    history(nb.id).run(new AddPageCommand(nb.id, page, layer, anchor), target, pageId);
    refreshUndo();
    const updatedPages = getPages(nb.id);
    const newIdx = updatedPages.findIndex((x) => x.id === pageId);
    set({ liveAnnouncement: `Page added, page ${newIdx + 1} of ${updatedPages.length}` });
    return pageId;
  },

  setPageViewMode(mode: 'single' | 'continuous') {
    try {
      localStorage.setItem('mynotes.pageViewMode', mode);
    } catch {
      /* ignore */
    }
    const p = get().panes[get().activePane];
    set({ pageViewMode: mode });
    if (p) {
      void actions.patchNotebook(p.notebookId, { pageViewMode: mode });
    }
  },

  async duplicatePage(pane: number, pageId: string) {
    const p = get().panes[pane];
    const nb = get().notebooks.find((n) => n.id === p.notebookId);
    const srcPage = getPages(p.notebookId).find((x) => x.id === pageId);
    if (!nb || !srcPage) return;
    const newPageId = crypto.randomUUID();
    const srcLayers = getLayers(pageId);
    const layerMap = new Map<string, string>();
    const newLayers: Layer[] = srcLayers.map((l) => {
      const nid = crypto.randomUUID();
      layerMap.set(l.id, nid);
      return { ...l, id: nid, pageId: newPageId };
    });
    const newPage: Page = { ...srcPage, id: newPageId, layerIds: newLayers.map((l) => l.id), revision: 1 };
    const srcStrokes = getStrokes(pageId);
    const newStrokes: InkStroke[] = srcStrokes.map((s) => ({
      ...s, id: crypto.randomUUID(), pageId: newPageId, layerId: layerMap.get(s.layerId) ?? newLayers[0].id,
      samples: new Float32Array(s.samples),
    }));
    const idx = nb.pageIds.indexOf(pageId);
    const nextPageIds = [...nb.pageIds];
    nextPageIds.splice(idx + 1, 0, newPageId);
    await repo.createNotebook({ ...nb, pageIds: nextPageIds, updatedAt: Date.now(), revision: nb.revision + 1 }, newPage, newLayers[0]);
    if (newLayers.length > 1) await repo.saveLayers(newPage, newLayers);
    if (newStrokes.length) await repo.replaceStrokes([], newStrokes, nb.id);
    set({ notebooks: await repo.allNotebooks() });
    await actions.loadNotebook(nb.id);
    actions.setPage(pane, newPageId);
  },

  async deletePage(pane: number, pageId: string) {
    const p = get().panes[pane];
    const nb = get().notebooks.find((n) => n.id === p.notebookId);
    if (!nb || nb.pageIds.length <= 1) return;
    const nextPageIds = nb.pageIds.filter((id) => id !== pageId);
    await repo.updateNotebook({ ...nb, pageIds: nextPageIds, updatedAt: Date.now(), revision: nb.revision + 1 });
    pagesByNotebook.set(nb.id, getPages(nb.id).filter((x) => x.id !== pageId));
    set({ notebooks: await repo.allNotebooks() });
    if (p.pageId === pageId) actions.setPage(pane, nextPageIds[0]);
  },

  async movePage(pane: number, pageId: string, dir: -1 | 1) {
    const p = get().panes[pane];
    const nb = get().notebooks.find((n) => n.id === p.notebookId);
    if (!nb) return;
    const nextPageIds = [...nb.pageIds];
    const i = nextPageIds.indexOf(pageId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= nextPageIds.length) return;
    [nextPageIds[i], nextPageIds[j]] = [nextPageIds[j], nextPageIds[i]];
    await repo.updateNotebook({ ...nb, pageIds: nextPageIds, updatedAt: Date.now(), revision: nb.revision + 1 });
    set({ notebooks: await repo.allNotebooks() });
    await actions.loadNotebook(nb.id);
  },
};

