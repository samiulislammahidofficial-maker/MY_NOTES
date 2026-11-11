import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { AssetRecord, InkStroke, Layer, Notebook, Page, TextBox } from '../domain/types';
import { SAMPLE_STRIDE } from '../domain/types';
import { repo } from '../storage/db';
import { blobStore, sha256Hex } from '../storage/blobStore';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PDF_BYTES = 80 * 1024 * 1024; // 80 MB

const pdfDocCache = new Map<string, pdfjsLib.PDFDocumentProxy>();
const renderedPageBitmaps = new Map<string, HTMLCanvasElement>();

export async function getPdfDocument(assetId: string): Promise<pdfjsLib.PDFDocumentProxy | null> {
  if (pdfDocCache.has(assetId)) return pdfDocCache.get(assetId)!;
  const bytes = await blobStore.get(assetId);
  if (!bytes) return null;
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
  const doc = await loadingTask.promise;
  pdfDocCache.set(assetId, doc);
  return doc;
}

export async function renderPdfPageBackground(
  assetId: string,
  pageIndex: number,
  targetScale = 1.5,
): Promise<HTMLCanvasElement | null> {
  const key = `${assetId}:${pageIndex}:${targetScale.toFixed(1)}`;
  if (renderedPageBitmaps.has(key)) return renderedPageBitmaps.get(key)!;
  const doc = await getPdfDocument(assetId);
  if (!doc) return null;
  const page = await doc.getPage(pageIndex);
  const vp = page.getViewport({ scale: targetScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (renderedPageBitmaps.size > 24) {
    const first = renderedPageBitmaps.keys().next().value;
    if (first) renderedPageBitmaps.delete(first);
  }
  renderedPageBitmaps.set(key, canvas);
  return canvas;
}

const imageBitmapCache = new Map<string, HTMLImageElement>();
export async function getScannedImageElement(assetId: string): Promise<HTMLImageElement | null> {
  if (imageBitmapCache.has(assetId)) return imageBitmapCache.get(assetId)!;
  const bytes = await blobStore.get(assetId);
  if (!bytes) return null;
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      imageBitmapCache.set(assetId, img);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export async function importPdfAsNotebook(file: File): Promise<string> {
  if (file.size > MAX_PDF_BYTES) throw new Error('PDF exceeds 80 MB limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const assetId = `pdf-${crypto.randomUUID()}`;
  const backend = await blobStore.put(assetId, bytes);
  const now = Date.now();
  const asset: AssetRecord = {
    id: assetId,
    kind: 'pdf',
    name: file.name,
    mimeType: 'application/pdf',
    size: bytes.byteLength,
    sha256,
    backend,
    createdAt: now,
  };

  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  pdfDocCache.set(assetId, doc);

  const nbId = crypto.randomUUID();
  const pages: Page[] = [];
  const layers: Layer[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    const pageId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    layers.push({ id: layerId, pageId, name: 'Annotations', visible: true, locked: false, opacity: 1 });
    pages.push({
      id: pageId,
      notebookId: nbId,
      width: vp.width,
      height: vp.height,
      layerIds: [layerId],
      pdfAssetId: assetId,
      pdfPageIndex: i,
      revision: 1,
    });
  }

  const nb: Notebook = {
    id: nbId,
    title: file.name.replace(/\.pdf$/i, '') || 'Imported PDF',
    cover: '#3560B0',
    hasCover: true,
    template: 'blank',
    size: 'A4',
    landscape: (pages[0]?.width ?? 595) > (pages[0]?.height ?? 842),
    folderId: null,
    tags: ['PDF'],
    pinned: false,
    trashedAt: null,
    pageIds: pages.map((p) => p.id),
    createdAt: now,
    updatedAt: now,
    revision: 1,
    paper: '#FFFFFF',
  };

  await repo.createMultiPageNotebook(nb, pages, layers, asset);
  return nbId;
}

export async function importScannedImageAsNotebook(file: File, rotationDeg = 0): Promise<string> {
  const rawBytes = new Uint8Array(await file.arrayBuffer());
  const blob = new Blob([rawBytes.buffer as ArrayBuffer], { type: file.type || 'image/jpeg' });
  const bmp = await createImageBitmap(blob);

  const swap = rotationDeg % 180 !== 0;
  const w = swap ? bmp.height : bmp.width;
  const h = swap ? bmp.width : bmp.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);

  const outBlob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.9));
  const bytes = new Uint8Array(await outBlob.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const assetId = `img-${crypto.randomUUID()}`;
  const backend = await blobStore.put(assetId, bytes);
  const now = Date.now();
  const asset: AssetRecord = {
    id: assetId,
    kind: 'image',
    name: file.name,
    mimeType: 'image/jpeg',
    size: bytes.byteLength,
    sha256,
    backend,
    createdAt: now,
  };

  const scaleToA4 = 595.28 / Math.max(1, w);
  const pageW = 595.28;
  const pageH = Math.max(400, h * scaleToA4);
  const nbId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const layerId = crypto.randomUUID();

  const nb: Notebook = {
    id: nbId,
    title: file.name.replace(/\.[a-z0-9]+$/i, '') || 'Scanned Document',
    cover: '#385E51',
    hasCover: true,
    template: 'blank',
    size: 'A4',
    landscape: pageW > pageH,
    folderId: null,
    tags: ['Scan'],
    pinned: false,
    trashedAt: null,
    pageIds: [pageId],
    createdAt: now,
    updatedAt: now,
    revision: 1,
    paper: '#FFFFFF',
  };
  const page: Page = { id: pageId, notebookId: nbId, width: pageW, height: pageH, layerIds: [layerId], imageAssetId: assetId, revision: 1 };
  const layer: Layer = { id: layerId, pageId, name: 'Ink', visible: true, locked: false, opacity: 1 };
  await repo.createMultiPageNotebook(nb, [page], [layer], asset);
  return nbId;
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').padEnd(6, '0');
  const n = parseInt(clean.slice(0, 6), 16) || 0;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * Export a notebook to a standalone portable PDF using pdf-lib + fontkit.
 * Copies original PDF pages where present and overlays vector ink and text boxes
 * in canonical document coordinates (flipping y = pageHeight - docY).
 */
export async function exportNotebookToPdfBytes(
  nb: Notebook,
  pages: Page[],
  getStrokesForPage: (pageId: string) => InkStroke[],
  getTextsForPage: (pageId: string) => TextBox[],
  getLayersForPage: (pageId: string) => Layer[],
): Promise<Uint8Array> {
  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(fontkit);

  const loadedSrcPdfs = new Map<string, PDFDocument>();
  const embeddedCustomFonts = new Map<string, any>();

  for (const p of pages) {
    let pdfPage;
    if (p.pdfAssetId && p.pdfPageIndex) {
      let srcPdf = loadedSrcPdfs.get(p.pdfAssetId);
      if (!srcPdf) {
        const bytes = await blobStore.get(p.pdfAssetId);
        if (bytes) {
          srcPdf = await PDFDocument.load(bytes);
          loadedSrcPdfs.set(p.pdfAssetId, srcPdf);
        }
      }
      if (srcPdf && p.pdfPageIndex - 1 < srcPdf.getPageCount()) {
        const [copied] = await outDoc.copyPages(srcPdf, [p.pdfPageIndex - 1]);
        pdfPage = outDoc.addPage(copied);
      }
    }
    if (!pdfPage) {
      pdfPage = outDoc.addPage([p.width, p.height]);
      const bg = hexToRgb01(nb.paper);
      pdfPage.drawRectangle({ x: 0, y: 0, width: p.width, height: p.height, color: rgb(bg.r, bg.g, bg.b) });
    }

    const { height: H } = pdfPage.getSize();
    const layers = getLayersForPage(p.id);
    const visMap = new Map(layers.map((l) => [l.id, l]));

    const strokes = getStrokesForPage(p.id);
    for (const s of strokes) {
      const l = visMap.get(s.layerId);
      if (l && !l.visible) continue;
      const c = hexToRgb01(s.color);
      const alpha = s.opacity * (l?.opacity ?? 1);
      const n = s.samples.length / SAMPLE_STRIDE;
      for (let i = 0; i < n - 1; i++) {
        const o = i * SAMPLE_STRIDE, q = o + SAMPLE_STRIDE;
        pdfPage.drawLine({
          start: { x: s.samples[o], y: H - s.samples[o + 1] },
          end: { x: s.samples[q], y: H - s.samples[q + 1] },
          thickness: s.width,
          color: rgb(c.r, c.g, c.b),
          opacity: alpha,
        });
      }
    }

    const texts = getTextsForPage(p.id);
    for (const tb of texts) {
      const l = visMap.get(tb.layerId);
      if (l && !l.visible) continue;
      const c = hexToRgb01(tb.color);
      let customFont = undefined;
      if (tb.fontAssetId) {
        customFont = embeddedCustomFonts.get(tb.fontAssetId);
        if (!customFont) {
          const fBytes = await blobStore.get(tb.fontAssetId);
          if (fBytes) {
            try {
              customFont = await outDoc.embedFont(fBytes);
              embeddedCustomFonts.set(tb.fontAssetId, customFont);
            } catch {
              customFont = undefined;
            }
          }
        }
      }
      const lines = tb.text.split('\n');
      lines.forEach((line, idx) => {
        if (!line) return;
        pdfPage.drawText(line, {
          x: tb.bounds.x0,
          y: H - tb.bounds.y0 - tb.fontSize * (idx + 1),
          size: tb.fontSize,
          font: customFont,
          color: rgb(c.r, c.g, c.b),
          opacity: l?.opacity ?? 1,
        });
      });
    }
  }

  return outDoc.save();
}
