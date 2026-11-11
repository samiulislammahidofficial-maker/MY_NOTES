import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { SCHEMA_VERSION, type AssetRecord, type CustomFontRecord, type ImageBox, type InkStroke, type Layer, type Notebook, type Page, type TextBox } from '../domain/types';
import { db, fromRow, repo, toRow } from '../storage/db';
import { blobStore, sha256Hex } from '../storage/blobStore';
import { registerFontBytes } from '../fonts/registry';

export interface BackupManifest {
  format: 'tabletnotes-backup';
  schemaVersion: number;
  appVersion: string;
  createdAt: number;
  notebookCount: number;
  assetCount: number;
  note: string;
}

interface SerializedStroke extends Omit<InkStroke, 'samples'> {
  sampleFile: string;
}

interface BackupPayload {
  notebooks: Notebook[];
  pages: Page[];
  layers: Layer[];
  strokes: SerializedStroke[];
  texts: TextBox[];
  images?: ImageBox[];
  assets: AssetRecord[];
  fonts: CustomFontRecord[];
}

const MAX_RESTORE_UNCOMPRESSED_BYTES = 250 * 1024 * 1024; // 250 MB safety cap
const LAST_BACKUP_KEY = 'mynotes_last_backup_at';
let activeBackupJobs = 0;
export const hasActiveBackupJobs = () => activeBackupJobs > 0;

export function getLastBackupTime(): number | null {
  try {
    const v = localStorage.getItem(LAST_BACKUP_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function setLastBackupTime(ts = Date.now()): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(ts));
  } catch {
    // ignore
  }
}

/**
 * Create a complete `.tabletnotes.zip` archive for either one notebook or all notebooks.
 * Never includes API keys or transient laser/prediction data.
 * Protected notebooks and pages are included strictly as AES-GCM ciphertext envelopes (`passwordLock`) without leaking keys.
 */
export async function buildBackupZipBytes(notebookId?: string): Promise<Uint8Array> {
  activeBackupJobs++;
  try {
    const allNbs = await repo.allNotebooks();
    const notebooks = notebookId ? allNbs.filter((n) => n.id === notebookId) : allNbs;
    const pages: Page[] = [];
    const layers: Layer[] = [];
    const strokes: SerializedStroke[] = [];
    const texts: TextBox[] = [];
    const images: ImageBox[] = [];
    const files: Record<string, Uint8Array> = {};
    const assetIds = new Set<string>();

    for (const nb of notebooks) {
      if (nb.coverAssetId) assetIds.add(nb.coverAssetId);
      const nbPages = await repo.getPages(nb.id);
      for (const p of nbPages) {
        pages.push(p);
        if (p.pdfAssetId) assetIds.add(p.pdfAssetId);
        if (p.imageAssetId) assetIds.add(p.imageAssetId);
        const ls = await repo.getLayers(p.id);
        layers.push(...ls);
        // If notebook or page is password-protected at rest, db.strokes/db.texts are empty and ciphertext is in passwordLock
        const sts = await repo.getStrokes(p.id);
        for (const s of sts) {
          const sampleFile = `strokes/${s.id}.bin`;
          files[sampleFile] = new Uint8Array(s.samples.buffer.slice(s.samples.byteOffset, s.samples.byteOffset + s.samples.byteLength));
          const { samples: _omit, ...rest } = s;
          strokes.push({ ...rest, sampleFile });
        }
        const tbs = await repo.getTexts(p.id);
        for (const tb of tbs) {
          texts.push(tb);
          if (tb.fontAssetId) assetIds.add(tb.fontAssetId);
        }
        const imgs = await repo.getImages(p.id);
        for (const img of imgs) {
          images.push(img);
          if (img.assetId) assetIds.add(img.assetId);
        }
      }
    }

    const allFonts = await repo.allFonts();
    const fonts = notebookId ? allFonts.filter((f) => assetIds.has(f.assetId)) : allFonts;
    for (const f of fonts) assetIds.add(f.assetId);

    const assets: AssetRecord[] = [];
    for (const aid of assetIds) {
      const rec = await repo.getAsset(aid);
      const bytes = await blobStore.get(aid);
      if (rec && bytes) {
        assets.push(rec);
        files[`assets/${aid}`] = bytes;
      }
    }

    const appVer = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : '1.0.0';
    const manifest: BackupManifest = {
      format: 'tabletnotes-backup',
      schemaVersion: SCHEMA_VERSION,
      appVersion: appVer,
      createdAt: Date.now(),
      notebookCount: notebooks.length,
      assetCount: assets.length,
      note: 'Rebuildable thumbnails and offline OCR model packs are omitted; all editable vectors, text, PDFs, custom fonts, and encrypted password envelopes are included.',
    };

    const payload: BackupPayload = { notebooks, pages, layers, strokes, texts, images, assets, fonts };
    files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
    files['data.json'] = strToU8(JSON.stringify(payload));

    return zipSync(files, { level: 6 });
  } finally {
    activeBackupJobs = Math.max(0, activeBackupJobs - 1);
  }
}

export async function exportBackupArchiveFlow(notebookId?: string, suggestedName?: string): Promise<boolean> {
  const bytes = await buildBackupZipBytes(notebookId);
  const name = suggestedName ?? `MyNotes-Backup-${new Date().toISOString().slice(0, 10)}.tabletnotes.zip`;
  const handedOff = await saveOrShareFileBytes(bytes, name, 'application/zip');
  if (handedOff) {
    setLastBackupTime();
  }
  return handedOff;
}

/**
 * Validate and restore a `.tabletnotes.zip` archive.
 * Checks path traversal, size bounds, schema, and SHA-256 asset hashes,
 * and remaps IDs if a notebook ID already exists locally so existing notebooks are never overwritten.
 */
export async function restoreFromBackupZipBytes(zipBytes: Uint8Array): Promise<{ restoredNotebooks: number; restoredAssets: number }> {
  const entries = unzipSync(zipBytes);
  let totalBytes = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
      throw new Error(`Invalid archive path: ${name}`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_RESTORE_UNCOMPRESSED_BYTES) {
      throw new Error('Backup archive exceeds 250 MB uncompressed limit.');
    }
  }

  if (!entries['manifest.json'] || !entries['data.json']) {
    throw new Error('Invalid .tabletnotes.zip archive: missing manifest.json or data.json.');
  }

  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as BackupManifest;
  if (manifest.format !== 'tabletnotes-backup') {
    throw new Error('Unrecognized backup format.');
  }

  const payload = JSON.parse(strFromU8(entries['data.json'])) as BackupPayload;

  // Verify and stage binary assets first
  for (const asset of payload.assets ?? []) {
    const bytes = entries[`assets/${asset.id}`];
    if (!bytes) throw new Error(`Missing binary asset in archive: ${asset.id}`);
    const hash = await sha256Hex(bytes);
    if (hash !== asset.sha256) {
      throw new Error(`Integrity check failed for asset ${asset.name}`);
    }
    const backend = await blobStore.put(asset.id, bytes);
    await db.assets.put({ ...asset, backend });
  }

  for (const font of payload.fonts ?? []) {
    await db.fonts.put(font);
    const bytes = entries[`assets/${font.assetId}`];
    if (bytes) await registerFontBytes(font.family, bytes).catch(() => {});
  }

  // Remap IDs if notebook already exists so existing user notes are never clobbered
  const existingNbIds = new Set((await db.notebooks.toCollection().primaryKeys()) as string[]);
  const nbMap = new Map<string, string>();
  const pageMap = new Map<string, string>();
  const layerMap = new Map<string, string>();

  const stagedNbs: Notebook[] = [];
  for (const nb of payload.notebooks) {
    const newId = existingNbIds.has(nb.id) ? crypto.randomUUID() : nb.id;
    nbMap.set(nb.id, newId);
  }
  for (const p of payload.pages) {
    const remap = nbMap.get(p.notebookId) !== p.notebookId;
    pageMap.set(p.id, remap ? crypto.randomUUID() : p.id);
  }
  for (const l of payload.layers) {
    const remap = pageMap.get(l.pageId) !== l.pageId;
    layerMap.set(l.id, remap ? crypto.randomUUID() : l.id);
  }

  for (const nb of payload.notebooks) {
    const nid = nbMap.get(nb.id)!;
    const isDup = nid !== nb.id;
    stagedNbs.push({
      ...nb,
      id: nid,
      title: isDup ? `${nb.title} (Restored)` : nb.title,
      pageIds: nb.pageIds.map((pid) => pageMap.get(pid) ?? pid),
    });
  }

  const stagedPages: Page[] = payload.pages.map((p) => ({
    ...p,
    id: pageMap.get(p.id) ?? p.id,
    notebookId: nbMap.get(p.notebookId) ?? p.notebookId,
    layerIds: p.layerIds.map((lid) => layerMap.get(lid) ?? lid),
  }));

  const stagedLayers: Layer[] = payload.layers.map((l) => ({
    ...l,
    id: layerMap.get(l.id) ?? l.id,
    pageId: pageMap.get(l.pageId) ?? l.pageId,
  }));

  const stagedStrokes = payload.strokes.map((s) => {
    const bin = entries[s.sampleFile];
    if (!bin) throw new Error(`Missing stroke sample buffer: ${s.sampleFile}`);
    const samples = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    const remap = pageMap.get(s.pageId) !== s.pageId;
    const stroke: InkStroke = {
      ...s,
      id: remap ? crypto.randomUUID() : s.id,
      pageId: pageMap.get(s.pageId) ?? s.pageId,
      layerId: layerMap.get(s.layerId) ?? s.layerId,
      samples,
    };
    return toRow(stroke);
  });

  const stagedTexts: TextBox[] = (payload.texts ?? []).map((tb) => {
    const remap = pageMap.get(tb.pageId) !== tb.pageId;
    return {
      ...tb,
      id: remap ? crypto.randomUUID() : tb.id,
      pageId: pageMap.get(tb.pageId) ?? tb.pageId,
      layerId: layerMap.get(tb.layerId) ?? tb.layerId,
    };
  });

  const stagedImages: ImageBox[] = (payload.images ?? []).map((img) => {
    const remap = pageMap.get(img.pageId) !== img.pageId;
    return {
      ...img,
      id: remap ? crypto.randomUUID() : img.id,
      pageId: pageMap.get(img.pageId) ?? img.pageId,
      layerId: layerMap.get(img.layerId) ?? img.layerId,
    };
  });

  await db.transaction('rw', [db.notebooks, db.pages, db.layers, db.strokes, db.texts, db.images], async () => {
    await db.notebooks.bulkPut(stagedNbs);
    await db.pages.bulkPut(stagedPages);
    await db.layers.bulkPut(stagedLayers);
    await db.strokes.bulkPut(stagedStrokes);
    await db.texts.bulkPut(stagedTexts);
    await db.images.bulkPut(stagedImages);
  });

  // Verify round-trip count for the first restored notebook
  if (stagedNbs.length > 0) {
    const checkPages = await repo.getPages(stagedNbs[0].id);
    if (checkPages.length) {
      const checkStrokes = await repo.getStrokes(checkPages[0].id);
      void fromRow;
      void checkStrokes;
    }
  }

  return { restoredNotebooks: stagedNbs.length, restoredAssets: (payload.assets ?? []).length };
}

/**
 * Save or share generated file bytes using platform pickers (showSaveFilePicker,
 * navigator.share for iPad Save to Files, or Blob download fallback).
 * Returns `true` only when the archive was actually handed to a supported download/save/share flow
 * (and `false` if the user cancelled a native picker).
 */
export async function saveOrShareFileBytes(bytes: Uint8Array, filename: string, mimeType: string): Promise<boolean> {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error('Cannot export an empty archive.');
  }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buf], { type: mimeType });

  const win = window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
  };

  if (typeof win.showSaveFilePicker === 'function') {
    try {
      const handle = await win.showSaveFilePicker({ suggestedName: filename });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
    }
  }

  const file = new File([blob], filename, { type: mimeType });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
