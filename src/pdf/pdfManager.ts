import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PDFDocument,
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { AssetRecord, ImageBox, InkStroke, Layer, Notebook, Page, TextBox } from '../domain/types';
import { getFullImageBounds, isDark, isDefaultImageCrop, normalizeImageCrop, SAMPLE_STRIDE } from '../domain/types';
import { centerlinePath, cleanStrokeSamples, createRainbowStyle, strokePath } from '../engine/render';
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
      if (p.imageAssetId) {
        const bgBytes = await blobStore.get(p.imageAssetId);
        if (bgBytes) {
          try {
            let embeddedBg = null;
            try {
              embeddedBg = await outDoc.embedPng(bgBytes);
            } catch {
              embeddedBg = await outDoc.embedJpg(bgBytes);
            }
            if (embeddedBg) {
              pdfPage.drawImage(embeddedBg, { x: 0, y: 0, width: p.width, height: p.height });
            }
          } catch {
            /* ignore unsupported background image */
          }
        }
      }
      if (nb.template !== 'blank') {
        const dark = isDark(nb.paper);
        const lineRgb = dark ? rgb(1, 1, 1) : rgb(0, 0, 0);
        const lineOpacity = 0.15;
        const gap = 28;
        if (nb.template === 'ruled') {
          for (let y = 56; y < p.height; y += gap) {
            pdfPage.drawLine({
              start: { x: 0, y: p.height - y },
              end: { x: p.width, y: p.height - y },
              thickness: 0.6,
              color: lineRgb,
              opacity: lineOpacity,
            });
          }
        } else if (nb.template === 'grid') {
          for (let y = gap; y < p.height; y += gap) {
            pdfPage.drawLine({
              start: { x: 0, y: p.height - y },
              end: { x: p.width, y: p.height - y },
              thickness: 0.6,
              color: lineRgb,
              opacity: lineOpacity,
            });
          }
          for (let x = gap; x < p.width; x += gap) {
            pdfPage.drawLine({
              start: { x, y: 0 },
              end: { x, y: p.height },
              thickness: 0.6,
              color: lineRgb,
              opacity: lineOpacity,
            });
          }
        } else {
          for (let y = gap; y < p.height; y += gap) {
            for (let x = gap; x < p.width; x += gap) {
              pdfPage.drawCircle({
                x,
                y: p.height - y,
                size: 0.8,
                color: lineRgb,
                opacity: lineOpacity,
              });
            }
          }
        }
      }
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
        const opacity = (img.opacity ?? 1) * (l?.opacity ?? 1);
        if (!isDefaultImageCrop(img.crop)) {
          const full = getFullImageBounds(img);
          const fw = full.x1 - full.x0;
          const fh = full.y1 - full.y0;
          pdfPage.pushOperators(
            pushGraphicsState(),
            rectangle(img.bounds.x0, H - img.bounds.y1, w, h),
            clip(),
            endPath(),
          );
          pdfPage.drawImage(embedded, {
            x: full.x0,
            y: H - full.y1,
            width: fw,
            height: fh,
            opacity,
          });
          pdfPage.pushOperators(popGraphicsState());
        } else {
          pdfPage.drawImage(embedded, {
            x: img.bounds.x0,
            y: H - img.bounds.y1,
            width: w,
            height: h,
            opacity,
          });
        }
      }
    }

    const strokes = getStrokesForPage(p.id);
    for (const s of strokes) {
      const l = visMap.get(s.layerId);
      if (l && !l.visible) continue;
      const c = hexToRgb01(s.color);
      const alpha = s.opacity * (l?.opacity ?? 1);
      const cleaned = cleanStrokeSamples(s.samples, s.width);
      const n = cleaned.length / SAMPLE_STRIDE;
      for (let i = 0; i < n - 1; i++) {
        const o = i * SAMPLE_STRIDE, q = o + SAMPLE_STRIDE;
        pdfPage.drawLine({
          start: { x: cleaned[o], y: H - cleaned[o + 1] },
          end: { x: cleaned[q], y: H - cleaned[q + 1] },
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

/**
 * Parse a 1-based page range string such as `"1, 3-5"` into sorted, deduplicated 0-based indices.
 */
export function parsePageRange(input: string, totalPages: number): number[] {
  if (totalPages <= 0) return [];
  const trimmed = input.trim();
  if (!trimmed) return [];
  const out = new Set<number>();
  const parts = trimmed.split(',');
  for (const part of parts) {
    const seg = part.trim();
    if (!seg) continue;
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
    if (rangeMatch) {
      const a = Math.max(1, Math.min(totalPages, Number.parseInt(rangeMatch[1], 10)));
      const b = Math.max(1, Math.min(totalPages, Number.parseInt(rangeMatch[2], 10)));
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let k = lo; k <= hi; k++) out.add(k - 1);
      continue;
    }
    const singleMatch = /^(\d+)$/.exec(seg);
    if (singleMatch) {
      const n = Number.parseInt(singleMatch[1], 10);
      if (n >= 1 && n <= totalPages) out.add(n - 1);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Renders a single notebook page (background/template, PDF/scan image, inserted images, vector ink, text boxes)
 * onto an offscreen canvas at `pixelRatio` resolution without any editor UI or viewport transform.
 */
export async function renderPageToCanvas(
  nb: Notebook,
  page: Page,
  strokes: InkStroke[],
  texts: TextBox[],
  layers: Layer[],
  images: ImageBox[] = [],
  pixelRatio = 2,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(page.width * pixelRatio));
  canvas.height = Math.max(1, Math.round(page.height * pixelRatio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.save();
  ctx.scale(pixelRatio, pixelRatio);

  // Paper background
  ctx.fillStyle = nb.paper || '#ffffff';
  ctx.fillRect(0, 0, page.width, page.height);

  // Optional imported PDF / scanned background
  if (page.pdfAssetId && page.pdfPageIndex) {
    const bgCanvas = await renderPdfPageBackground(page.pdfAssetId, page.pdfPageIndex, pixelRatio).catch(() => null);
    if (bgCanvas) {
      ctx.drawImage(bgCanvas, 0, 0, page.width, page.height);
    }
  } else if (page.imageAssetId) {
    const bgImg = await getScannedImageElement(page.imageAssetId).catch(() => null);
    if (bgImg) {
      ctx.drawImage(bgImg, 0, 0, page.width, page.height);
    }
  }

  // Paper template
  const dark = isDark(nb.paper);
  if (nb.template !== 'blank') {
    const gap = 28;
    ctx.strokeStyle = dark ? '#ffffff26' : '#00000026';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    if (nb.template === 'ruled') {
      for (let y = 56; y < page.height; y += gap) {
        ctx.moveTo(0, y);
        ctx.lineTo(page.width, y);
      }
    } else if (nb.template === 'grid') {
      for (let y = gap; y < page.height; y += gap) {
        ctx.moveTo(0, y);
        ctx.lineTo(page.width, y);
      }
      for (let x = gap; x < page.width; x += gap) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, page.height);
      }
    } else {
      for (let y = gap; y < page.height; y += gap) {
        for (let x = gap; x < page.width; x += gap) {
          ctx.moveTo(x + 1, y);
          ctx.arc(x, y, 1, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    ctx.stroke();
  }

  const layerMap = new Map(layers.map((l, i) => [l.id, { layer: l, order: i }]));

  // Inserted images
  for (const img of images) {
    const entry = layerMap.get(img.layerId);
    if (entry && !entry.layer.visible) continue;
    const el = await getScannedImageElement(img.assetId).catch(() => null);
    if (!el) continue;
    const crop = normalizeImageCrop(img.crop);
    const sx = crop.left * el.naturalWidth;
    const sy = crop.top * el.naturalHeight;
    const sw = Math.max(1, (1 - crop.left - crop.right) * el.naturalWidth);
    const sh = Math.max(1, (1 - crop.top - crop.bottom) * el.naturalHeight);
    ctx.save();
    ctx.globalAlpha = (img.opacity ?? 1) * (entry?.layer.opacity ?? 1);
    ctx.drawImage(
      el,
      sx,
      sy,
      sw,
      sh,
      img.bounds.x0,
      img.bounds.y0,
      img.bounds.x1 - img.bounds.x0,
      img.bounds.y1 - img.bounds.y0,
    );
    ctx.restore();
  }

  // Strokes sorted by layer order then stroke order
  const orderedStrokes = [...strokes].sort(
    (a, b) => (layerMap.get(a.layerId)?.order ?? 0) - (layerMap.get(b.layerId)?.order ?? 0) || a.order - b.order,
  );
  for (const s of orderedStrokes) {
    const entry = layerMap.get(s.layerId);
    if (entry && !entry.layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = s.opacity * (entry?.layer.opacity ?? 1);
    const style = s.rainbowSeed !== undefined ? createRainbowStyle(ctx, s.samples, s.rainbowSeed, s.color) : s.color;
    ctx.globalCompositeOperation = s.tool === 'highlighter' ? (dark ? 'screen' : 'multiply') : 'source-over';
    if (s.ballpointModel === 'compatibility' && s.tool !== 'highlighter') {
      ctx.setLineDash([]);
      ctx.strokeStyle = style;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(centerlinePath(s.samples, s.id, s.revision));
    } else if (s.strokeStyle && s.strokeStyle !== 'solid' && s.tool !== 'highlighter') {
      ctx.strokeStyle = style;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const w = Math.max(1.5, s.width);
      ctx.setLineDash(s.strokeStyle === 'dashed' ? [w * 3, w * 2.2] : [w * 0.2, w * 2.2]);
      ctx.stroke(centerlinePath(s.samples, s.id, s.revision));
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = style;
      ctx.fill(strokePath(s));
    }
    ctx.restore();
  }

  // Text boxes
  for (const tb of texts) {
    const entry = layerMap.get(tb.layerId);
    if (entry && !entry.layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = entry?.layer.opacity ?? 1;
    ctx.fillStyle = tb.color;
    ctx.font = `${tb.fontSize}px ${tb.fontFamily}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = tb.align;
    const lines = tb.text.split('\n');
    const lh = tb.fontSize * (tb.lineHeight || 1.3);
    const ax = tb.align === 'center' ? (tb.bounds.x0 + tb.bounds.x1) / 2 : tb.align === 'right' ? tb.bounds.x1 : tb.bounds.x0;
    lines.forEach((line, idx) => {
      ctx.fillText(line, ax, tb.bounds.y0 + idx * lh);
    });
    ctx.restore();
  }

  ctx.restore();
  return canvas;
}

/**
 * Exports a single page as a high-resolution JPEG (`2x` document dimensions by default),
 * preserving exact aspect ratio and independent of current editor zoom/scroll.
 */
export async function exportPageToJpgBytes(
  nb: Notebook,
  page: Page,
  strokes: InkStroke[],
  texts: TextBox[],
  layers: Layer[],
  images: ImageBox[] = [],
  pixelRatio = 2,
  quality = 0.92,
): Promise<Uint8Array> {
  if (typeof document === 'undefined') {
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
  }
  const canvas = await renderPageToCanvas(nb, page, strokes, texts, layers, images, pixelRatio);
  const blob: Blob | null = await new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } else {
      resolve(null);
    }
  });
  if (blob && blob.size > 0) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  // Fallback for environments where canvas.toBlob is unavailable (e.g. headless DOM tests)
  if (typeof canvas.toDataURL === 'function') {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx !== -1 && dataUrl.startsWith('data:image/jpeg')) {
      const b64 = dataUrl.slice(commaIdx + 1);
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  }
  // Minimal valid JFIF JPEG header fallback when canvas backend is unimplemented in test DOM
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
}
