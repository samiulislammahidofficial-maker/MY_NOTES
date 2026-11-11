import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { AssetRecord, ImageBox, InkStroke, Layer, Notebook, Page, TextBox } from '../domain/types';
import { SAMPLE_STRIDE } from '../domain/types';
import { repo } from '../storage/db';
import { blobStore, sha256Hex } from '../storage/blobStore';

// Ensure `@pdf-lib/fontkit` IndicShaper (`StateMachine.prototype.match`) has `regeneratorRuntime`
// when shaping pure Bengali / Indic strings (`বাংলা লেখা`, conjuncts, vowel matras).
if (typeof (globalThis as Record<string, unknown>).regeneratorRuntime === 'undefined') {
  (globalThis as Record<string, unknown>).regeneratorRuntime = {
    mark: (fn: unknown) => fn,
    wrap: (innerFn: (ctx: { prev: number; next: number | string; done: boolean; stop: () => unknown }) => unknown) => {
      const context = {
        prev: 0,
        next: 0 as number | string,
        done: false,
        stop() {
          this.done = true;
          return undefined;
        },
      };
      return {
        next() {
          if (context.done) return { value: undefined, done: true };
          context.prev = typeof context.next === 'number' ? context.next : 0;
          const value = innerFn(context);
          return { value, done: context.done };
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
  };
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PDF_BYTES = 80 * 1024 * 1024; // 80 MB
const BUNDLED_UNICODE_FONT_URL = '/fonts/NotoSansBengali-Regular.ttf';

let cachedBundledUnicodeFontBytes: Uint8Array | null = null;

/**
 * Loads the bundled OFL Unicode Bengali + Latin font (`/fonts/NotoSansBengali-Regular.ttf`).
 * Works both in the browser (`fetch`) and in Node/Vitest tests (`node:fs`).
 */
export async function loadBundledUnicodeFontBytes(): Promise<Uint8Array | null> {
  if (cachedBundledUnicodeFontBytes) return cachedBundledUnicodeFontBytes;
  try {
    if (typeof window !== 'undefined' && typeof fetch === 'function') {
      const res = await fetch(BUNDLED_UNICODE_FONT_URL);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.byteLength > 1024) {
          cachedBundledUnicodeFontBytes = bytes;
          return bytes;
        }
      }
    }
  } catch {
    /* fallback to node:fs in test environment */
  }
  try {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const p = pathMod.resolve(process.cwd(), 'public/fonts/NotoSansBengali-Regular.ttf');
    if (fsMod.existsSync(p)) {
      const buf = fsMod.readFileSync(p);
      cachedBundledUnicodeFontBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return cachedBundledUnicodeFontBytes;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Returns true when a string contains characters outside basic ASCII / WinAnsi
 * or any Bengali / Indic / non-Latin code points that require an embedded Unicode font.
 */
export function requiresUnicodePdfFont(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xff) return true;
  }
  return false;
}

/**
 * Returns true if the text contains complex Indic / Bengali script (`U+0980..U+09FF`)
 * where browser HarfBuzz shaping on an offscreen canvas produces high-precision conjunct
 * and pre-base vowel matra (`ে`, `ি`, `ৈ`) visual appearance.
 */
export function containsBengaliOrComplexScript(text: string): boolean {
  return /[\u0980-\u09FF]/.test(text);
}

/**
 * Renders a `TextBox` onto a high-DPI canvas (when in browser) and returns PNG bytes
 * so complex Bengali conjuncts and vowel matras match the live canvas rendering 1:1.
 */
async function renderComplexTextAppearancePng(
  tb: TextBox,
  lines: string[],
): Promise<{ pngBytes: Uint8Array; widthPt: number; heightPt: number } | null> {
  if (typeof document === 'undefined') return null;
  try {
    const dpr = 3;
    const widthPt = Math.max(120, tb.bounds.x1 - tb.bounds.x0);
    const lineHeightPt = tb.fontSize * (tb.lineHeight || 1.35);
    const heightPt = Math.max(tb.fontSize * 1.6, lines.length * lineHeightPt + 8);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(widthPt * dpr);
    canvas.height = Math.ceil(heightPt * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    ctx.font = `${tb.fontSize}px ${tb.fontFamily || '"Noto Sans Bengali", sans-serif'}`;
    ctx.fillStyle = tb.color || '#FFFFFF';
    ctx.textBaseline = 'top';
    ctx.textAlign = tb.align || 'left';
    const xAnchor = tb.align === 'center' ? widthPt / 2 : tb.align === 'right' ? widthPt : 0;
    lines.forEach((line, idx) => {
      if (!line) return;
      ctx.fillText(line, xAnchor, idx * lineHeightPt);
    });
    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));
    if (!blob) return null;
    return {
      pngBytes: new Uint8Array(await blob.arrayBuffer()),
      widthPt,
      heightPt,
    };
  } catch {
    return null;
  }
}

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
  getImagesForPage?: (pageId: string) => ImageBox[],
): Promise<Uint8Array> {
  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(fontkit);

  const loadedSrcPdfs = new Map<string, PDFDocument>();
  const embeddedCustomFonts = new Map<string, any>();
  const embeddedImages = new Map<string, any>();

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

    // Draw user-inserted Question / Exercise photos
    const images = getImagesForPage?.(p.id) ?? [];
    for (const img of images) {
      const l = visMap.get(img.layerId);
      if (l && !l.visible) continue;
      let embedded = embeddedImages.get(img.assetId);
      if (!embedded) {
        const bytes = await blobStore.get(img.assetId);
        if (bytes) {
          try {
            embedded = await outDoc.embedPng(bytes);
            embeddedImages.set(img.assetId, embedded);
          } catch {
            try {
              embedded = await outDoc.embedJpg(bytes);
              embeddedImages.set(img.assetId, embedded);
            } catch {
              embedded = null;
            }
          }
        }
      }
      if (embedded) {
        const w = img.bounds.x1 - img.bounds.x0;
        const h = img.bounds.y1 - img.bounds.y0;
        pdfPage.drawImage(embedded, {
          x: img.bounds.x0,
          y: H - img.bounds.y1,
          width: w,
          height: h,
          opacity: (img.opacity ?? 1) * (l?.opacity ?? 1),
        });
      }
    }

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
              customFont = await outDoc.embedFont(fBytes, { subset: false });
              embeddedCustomFonts.set(tb.fontAssetId, customFont);
            } catch {
              customFont = undefined;
            }
          }
        }
      }

      // If no custom font is embedded OR the text contains non-WinAnsi / Unicode / Bengali characters,
      // automatically load and embed the bundled OFL Unicode Bengali + Latin font (`NotoSansBengali-Regular.ttf`).
      const needsUnicode = requiresUnicodePdfFont(tb.text);
      if (!customFont && needsUnicode) {
        customFont = embeddedCustomFonts.get('__bundled_noto_bengali__');
        if (!customFont) {
          const bundledBytes = await loadBundledUnicodeFontBytes();
          if (bundledBytes) {
            try {
              customFont = await outDoc.embedFont(bundledBytes, { subset: false });
              embeddedCustomFonts.set('__bundled_noto_bengali__', customFont);
            } catch {
              customFont = undefined;
            }
          }
        }
      }

      const lines = tb.text.split('\n');
      const isComplexIndic = containsBengaliOrComplexScript(tb.text);
      const opacity = l?.opacity ?? 1;

      // For Bengali / complex Indic script in the browser, render high-DPI HarfBuzz-shaped canvas appearance
      // so vowel matras (`ে`, `ি`, `ৈ`) and conjuncts (`ক্ষ`, `জ্ঞ`, `শ্র`, `স্ট্র`) match the live canvas 100%,
      // while also embedding the Unicode searchable text layer underneath!
      let drewVisualAppearance = false;
      if (isComplexIndic) {
        const app = await renderComplexTextAppearancePng(tb, lines);
        if (app) {
          try {
            const pngImg = await outDoc.embedPng(app.pngBytes);
            pdfPage.drawImage(pngImg, {
              x: tb.bounds.x0,
              y: H - tb.bounds.y0 - app.heightPt,
              width: app.widthPt,
              height: app.heightPt,
              opacity,
            });
            drewVisualAppearance = true;
          } catch {
            /* fallback to vector drawText below */
          }
        }
      }

      lines.forEach((line, idx) => {
        if (!line) return;
        try {
          pdfPage.drawText(line, {
            x: tb.bounds.x0,
            y: H - tb.bounds.y0 - tb.fontSize * (idx + 1),
            size: tb.fontSize,
            font: customFont,
            color: rgb(c.r, c.g, c.b),
            opacity: drewVisualAppearance ? 0.01 : opacity,
          });
        } catch {
          // If a custom font lacked a specific glyph, fall back to the bundled Unicode font or ASCII-safe replacement
          if (!drewVisualAppearance) {
            const safeAscii = Array.from(line)
              .map((ch) => ((ch.codePointAt(0) ?? 0) <= 0x7e ? ch : '?'))
              .join('');
            if (safeAscii) {
              pdfPage.drawText(safeAscii, {
                x: tb.bounds.x0,
                y: H - tb.bounds.y0 - tb.fontSize * (idx + 1),
                size: tb.fontSize,
                color: rgb(c.r, c.g, c.b),
                opacity,
              });
            }
          }
        }
      });
    }
  }

  return outDoc.save();
}
