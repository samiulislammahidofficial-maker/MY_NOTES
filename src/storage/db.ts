import Dexie, { type Table } from 'dexie';
import type { AssetRecord, CustomFontRecord, InkStroke, Layer, Notebook, Page, TextBox } from '../domain/types';

export interface StrokeRow extends Omit<InkStroke, 'samples'> {
  samples: ArrayBuffer;
}

export interface BlobRow {
  id: string;
  data: ArrayBuffer;
}

class NotesDB extends Dexie {
  notebooks!: Table<Notebook, string>;
  pages!: Table<Page, string>;
  layers!: Table<Layer, string>;
  strokes!: Table<StrokeRow, string>;
  texts!: Table<TextBox, string>;
  assets!: Table<AssetRecord, string>;
  fonts!: Table<CustomFontRecord, string>;
  blobs!: Table<BlobRow, string>;

  constructor() {
    super('my-notes');
    this.version(1).stores({
      notebooks: 'id, updatedAt, trashedAt, pinned',
      pages: 'id, notebookId',
      layers: 'id, pageId',
      strokes: 'id, pageId, layerId, order',
    });
    this.version(2).stores({
      notebooks: 'id, updatedAt, trashedAt, pinned',
      pages: 'id, notebookId',
      layers: 'id, pageId',
      strokes: 'id, pageId, layerId, order',
      texts: 'id, pageId, layerId, order',
      assets: 'id, kind, sha256',
      fonts: 'id, family, sha256',
      blobs: 'id',
    });
  }
}

export const db = new NotesDB();

export const toRow = (s: InkStroke): StrokeRow => ({
  ...s,
  samples: s.samples.buffer.slice(s.samples.byteOffset, s.samples.byteOffset + s.samples.byteLength) as ArrayBuffer,
});
export const fromRow = (r: StrokeRow): InkStroke => ({ ...r, samples: new Float32Array(r.samples) });

export const repo = {
  async allNotebooks(): Promise<Notebook[]> {
    const legacy: Record<string, string> = { black: '#000000', white: '#FFFFFF', cream: '#FFFDF0' };
    return (await db.notebooks.toArray()).map((n) => ({
      ...n,
      paper: legacy[n.paper] ?? n.paper,
      hasCover: n.hasCover ?? true,
      template: n.template ?? 'blank',
      size: n.size ?? 'A4',
      landscape: n.landscape ?? false,
    }));
  },
  async getPages(notebookId: string): Promise<Page[]> {
    return db.pages.where('notebookId').equals(notebookId).toArray();
  },
  async getStrokes(pageId: string): Promise<InkStroke[]> {
    const rows = await db.strokes.where('pageId').equals(pageId).sortBy('order');
    return rows.map(fromRow);
  },
  async getTexts(pageId: string): Promise<TextBox[]> {
    return db.texts.where('pageId').equals(pageId).sortBy('order');
  },
  async putText(tb: TextBox, nbId: string): Promise<void> {
    await db.transaction('rw', db.texts, db.notebooks, async () => {
      await db.texts.put(tb);
      const nb = await db.notebooks.get(nbId);
      if (nb) await db.notebooks.put({ ...nb, revision: nb.revision + 1, updatedAt: Date.now() });
    });
  },
  async deleteText(id: string, nbId: string): Promise<void> {
    await db.transaction('rw', db.texts, db.notebooks, async () => {
      await db.texts.delete(id);
      const nb = await db.notebooks.get(nbId);
      if (nb) await db.notebooks.put({ ...nb, revision: nb.revision + 1, updatedAt: Date.now() });
    });
  },
  async createNotebook(nb: Notebook, page: Page, layer: Layer): Promise<void> {
    await db.transaction('rw', db.notebooks, db.pages, db.layers, async () => {
      await db.notebooks.put(nb);
      await db.pages.put(page);
      await db.layers.put(layer);
    });
  },
  async createMultiPageNotebook(nb: Notebook, pages: Page[], layers: Layer[], asset?: AssetRecord): Promise<void> {
    await db.transaction('rw', db.notebooks, db.pages, db.layers, db.assets, async () => {
      if (asset) await db.assets.put(asset);
      await db.notebooks.put(nb);
      await db.pages.bulkPut(pages);
      await db.layers.bulkPut(layers);
    });
  },
  async getLayers(pageId: string): Promise<Layer[]> {
    return db.layers.where('pageId').equals(pageId).toArray();
  },
  async putLayer(l: Layer): Promise<void> {
    await db.layers.put(l);
  },
  async saveLayers(page: Page, layers: Layer[]): Promise<void> {
    await db.transaction('rw', db.pages, db.layers, async () => {
      await db.pages.put(page);
      await db.layers.bulkPut(layers);
    });
  },
  async deleteNotebook(id: string): Promise<void> {
    await db.transaction('rw', db.notebooks, db.pages, db.layers, db.strokes, db.texts, async () => {
      const pages = await db.pages.where('notebookId').equals(id).toArray();
      for (const p of pages) {
        await db.strokes.where('pageId').equals(p.id).delete();
        await db.texts.where('pageId').equals(p.id).delete();
        await db.layers.where('pageId').equals(p.id).delete();
      }
      await db.pages.where('notebookId').equals(id).delete();
      await db.notebooks.delete(id);
    });
  },
  async updateNotebook(nb: Notebook): Promise<void> {
    await db.notebooks.put(nb);
  },
  /** Atomic: stroke + notebook revision bump. Resolves only after the durable commit. */
  async addStroke(s: InkStroke, nbId: string): Promise<void> {
    await db.transaction('rw', db.strokes, db.notebooks, async () => {
      await db.strokes.put(toRow(s));
      const nb = await db.notebooks.get(nbId);
      if (nb) await db.notebooks.put({ ...nb, revision: nb.revision + 1, updatedAt: Date.now() });
    });
  },
  async replaceStrokes(removeIds: string[], add: InkStroke[], nbId: string): Promise<void> {
    await db.transaction('rw', db.strokes, db.notebooks, async () => {
      await db.strokes.bulkDelete(removeIds);
      await db.strokes.bulkPut(add.map(toRow));
      const nb = await db.notebooks.get(nbId);
      if (nb) await db.notebooks.put({ ...nb, revision: nb.revision + 1, updatedAt: Date.now() });
    });
  },
  async removeStroke(id: string, nbId: string): Promise<void> {
    await db.transaction('rw', db.strokes, db.notebooks, async () => {
      await db.strokes.delete(id);
      const nb = await db.notebooks.get(nbId);
      if (nb) await db.notebooks.put({ ...nb, revision: nb.revision + 1, updatedAt: Date.now() });
    });
  },
  async allFonts(): Promise<CustomFontRecord[]> {
    return db.fonts.toArray();
  },
  async saveCustomFont(font: CustomFontRecord, asset: AssetRecord): Promise<void> {
    await db.transaction('rw', db.fonts, db.assets, async () => {
      await db.assets.put(asset);
      await db.fonts.put(font);
    });
  },
  async deleteCustomFont(fontId: string): Promise<void> {
    await db.fonts.delete(fontId);
  },
  async getAsset(id: string): Promise<AssetRecord | undefined> {
    return db.assets.get(id);
  },
  async allAssets(): Promise<AssetRecord[]> {
    return db.assets.toArray();
  },
};
