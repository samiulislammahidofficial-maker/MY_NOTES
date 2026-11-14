import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Activity,
  Check,
  FilePlus2,
  Grid,
  Link2,
  Maximize2,
  Pin,
  PinOff,
  Search,
  Share,
  Sliders,
  ChevronDown,
  ChevronLeft,
  ClipboardPaste,
  Columns2,
  Copy,
  CopyPlus,
  CornerDownLeft,
  Crop,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileDown,
  Fingerprint,
  Hand,
  HelpCircle,
  Highlighter,
  Image as ImageIcon,
  KeyRound,
  Lasso,
  Layers,
  LayoutGrid,
  List,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pen,
  Plus,
  Printer,
  Redo2,
  RotateCcw,
  Ruler,
  Scissors,
  Shapes,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import katex from 'katex';
import { actions, beginEssentialJob, getActiveLayer, getImages, getLayers, getPages, getStrokes, getTexts, useApp } from './store';
import { InkSurface } from '../engine/surface';
import type { SelectionInfo, ShapeKind, ToolKind } from '../engine/tools';
import {
  PAPER_COLORS,
  getCropBoxBounds,
  getFullImageBounds,
  isDefaultImageCrop,
  normalizeImageCrop,
  type ImageBox,
  type ImageCrop,
  type InkStroke,
  type Page,
  type TextBox,
} from '../domain/types';
import { unionBounds } from '../engine/hit';
import { SwipeToAddController, type SwipeAddSnapshot } from '../engine/swipeAddPage';
import { StyleColorPopover, type StylePopoverTab } from '../ui/StyleColorPopover';
import { SYSTEM_FONTS, importCustomFontFile } from '../fonts/registry';
import {
  installLocalHandwritingPack,
  isLocalPackInstalled,
  recognizeLocalHandwriting,
  recognizeWithGeminiOptIn,
} from '../recognition/provider';
import { segmentStrokesIntoLines } from '../recognition/segmentation';
import { isDocumentUnlockedInSession } from '../security/passwordLock';
import { PasswordModal, type PasswordModalMode } from '../ui/PasswordModal';
import { blobStore, sha256Hex } from '../storage/blobStore';
import { db } from '../storage/db';
import { attachEditorSelectionGuard, clearWorkspaceStaleSelectionAndFocus } from '../engine/selectionGuard';
import { WritingDiagnosticsModal } from '../ui/WritingDiagnosticsModal';

const loadPdfManager = () => import('../pdf/pdfManager');
const loadBackupManager = () => import('../export/backup');

function ConvertToTextModal({
  page,
  strokes,
  onClose,
  onConverted,
}: {
  page: Page;
  strokes: InkStroke[];
  onClose: () => void;
  onConverted: () => void;
}) {
  const s = useApp();
  const [text, setText] = useState(() => {
    const lines = segmentStrokesIntoLines(strokes);
    return lines.length > 1 ? `Handwritten note (${lines.length} lines)` : 'Handwritten note';
  });
  const [latex, setLatex] = useState('');
  const [fontFamily, setFontFamily] = useState(s.activeFontFamily);
  const [fontAssetId, setFontAssetId] = useState<string | undefined>(s.activeFontAssetId);
  const [fontSize, setFontSize] = useState(s.activeFontSize);
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('left');
  const [status, setStatus] = useState<string>('Ready — edit text below or run the offline TrOCR handwriting model');
  const [busy, setBusy] = useState(false);
  const [packReady, setPackReady] = useState(isLocalPackInstalled());
  const fontInputRef = useRef<HTMLInputElement>(null);

  const runLocalNeuralHtr = async () => {
    setBusy(true);
    setStatus('Preparing local offline TrOCR model…');
    try {
      if (!isLocalPackInstalled()) {
        await installLocalHandwritingPack((msg) => setStatus(msg));
        setPackReady(true);
      }
      const res = await recognizeLocalHandwriting({
        requestId: crypto.randomUUID(),
        pageId: page.id,
        revision: page.revision,
        strokes,
        mode: 'text',
        provider: 'local',
      });
      setText(res.text);
      if (res.latex) setLatex(res.latex);
      setStatus(`Recognized ${res.lineCount} line(s) locally offline.`);
    } catch (err) {
      setStatus(`Local HTR note: ${(err as Error).message}. Original ink is safe; you can edit text below.`);
    } finally {
      setBusy(false);
    }
  };

  const runGeminiOptIn = async () => {
    setBusy(true);
    setStatus('Sending crop to opt-in Gemini API…');
    try {
      const res = await recognizeWithGeminiOptIn({
        requestId: crypto.randomUUID(),
        pageId: page.id,
        revision: page.revision,
        strokes,
        mode: 'text',
        provider: 'gemini',
        geminiKey: s.geminiKey,
        geminiModel: s.geminiModel,
      });
      setText(res.text);
      if (res.latex) setLatex(res.latex);
      setStatus(`Recognized via ${res.provider}.`);
    } catch (err) {
      setStatus(`Gemini error: ${(err as Error).message}. Original ink is preserved.`);
    } finally {
      setBusy(false);
    }
  };

  const handleImportFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rec = await importCustomFontFile(file);
      await actions.refreshNotebooksAndFonts();
      setFontFamily(rec.family);
      setFontAssetId(rec.assetId);
      useApp.setState({ activeFontFamily: rec.family, activeFontAssetId: rec.assetId });
      setStatus(`Imported custom font "${rec.family}" (${rec.format.toUpperCase()}).`);
    } catch (err) {
      setStatus(`Font import failed: ${(err as Error).message}`);
    } finally {
      e.target.value = '';
    }
  };

  const commit = (replaceInk: boolean) => {
    const b = unionBounds(strokes) ?? { x0: 72, y0: 72, x1: 260, y1: 120 };
    const width = Math.max(160, b.x1 - b.x0 + 24);
    const lines = Math.max(1, text.split('\n').length);
    const height = Math.max(fontSize * 1.6, lines * fontSize * 1.35 + 12);
    const y0 = replaceInk ? b.y0 : b.y1 + 14;
    const tb: TextBox = {
      kind: 'text',
      id: crypto.randomUUID(),
      pageId: page.id,
      layerId: getActiveLayer(page.id) ?? page.layerIds[0],
      text: text.trim() || 'Text',
      latex: latex.trim() || undefined,
      fontFamily,
      fontAssetId,
      fontSize,
      color: strokes[0]?.color ?? s.tool.color,
      align,
      lineHeight: 1.3,
      bounds: { x0: b.x0, y0, x1: b.x0 + width, y1: y0 + height },
      sourceStrokeIds: strokes.map((st) => st.id),
      order: Date.now(),
      revision: 1,
    };
    actions.commitConvertInkToText(page.id, strokes, tb, replaceInk);
    onConverted();
    onClose();
  };

  const latexHtml = latex.trim()
    ? katex.renderToString(latex, { throwOnError: false, trust: false, displayMode: false })
    : '';

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="nn-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Convert Handwriting to Text"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(540px, 95vw)' }}
      >
        <header className="nn-head">
          <button className="nn-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
          <h2>Handwriting to Font Text</h2>
          <div style={{ width: 34 }} />
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" className="chip" disabled={busy} onClick={() => void runLocalNeuralHtr()}>
              <Sparkles size={14} /> {packReady ? 'Recognize (Offline TrOCR)' : 'Download & Run Offline TrOCR Pack'}
            </button>
            {s.geminiOptIn && s.geminiKey && (
              <button type="button" className="chip" disabled={busy} onClick={() => void runGeminiOptIn()}>
                Recognize (Opt-in Gemini)
              </button>
            )}
            <button
              type="button"
              className="chip"
              onClick={() => fontInputRef.current?.click()}
              title="Import local .ttf or .otf font"
            >
              <Upload size={14} /> Import .TTF / .OTF Font
            </button>
            <input
              ref={fontInputRef}
              type="file"
              accept=".ttf,.otf,font/ttf,font/otf"
              style={{ display: 'none' }}
              onChange={handleImportFont}
            />
          </div>

          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{status}</p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span>Recognized / Editable Text</span>
            <textarea
              className="nn-input"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ fontFamily, fontSize: Math.min(24, fontSize), resize: 'vertical' }}
            />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 120px', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>Font Family</span>
              <select
                className="nn-select"
                value={fontFamily}
                onChange={(e) => {
                  const fam = e.target.value;
                  const custom = s.customFonts.find((f) => f.family === fam);
                  setFontFamily(fam);
                  setFontAssetId(custom?.assetId);
                  useApp.setState({ activeFontFamily: fam, activeFontAssetId: custom?.assetId });
                }}
              >
                <optgroup label="Built-in Offline Fonts">
                  {SYSTEM_FONTS.map((f) => (
                    <option key={f.id} value={f.family}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
                {s.customFonts.length > 0 && (
                  <optgroup label="Imported Custom Fonts (.TTF/.OTF)">
                    {s.customFonts.map((f) => (
                      <option key={f.id} value={f.family}>
                        {f.family}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>Size (pt)</span>
              <input
                type="number"
                className="nn-input"
                min={10}
                max={72}
                value={fontSize}
                onChange={(e) => {
                  const v = Math.max(10, Math.min(72, +e.target.value || 20));
                  setFontSize(v);
                  useApp.setState({ activeFontSize: v });
                }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>Align</span>
              <select
                className="nn-select"
                value={align}
                onChange={(e) => setAlign(e.target.value as 'left' | 'center' | 'right')}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span>Optional LaTeX Math Formula (rendered offline with KaTeX)</span>
            <input
              className="nn-input"
              placeholder="e.g. \int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}"
              value={latex}
              onChange={(e) => setLatex(e.target.value)}
            />
          </label>
          {latexHtml && (
            <div
              style={{
                padding: '8px 12px',
                background: '#141416',
                borderRadius: 10,
                border: '1px solid var(--line)',
                overflowX: 'auto',
              }}
              dangerouslySetInnerHTML={{ __html: latexHtml }}
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button type="button" className="chip" onClick={() => commit(false)}>
              Keep Ink & Add Text
            </button>
            <button type="button" className="nn-create" onClick={() => commit(true)}>
              Replace Ink with Text
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContinuousPageCard({
  paneIndex,
  page,
  pageIndex,
  isActivePage,
  shouldMountCanvas,
  sharedRulerRef,
  onRulerSync,
  onRequestUnlockPage,
  onSelectStrokesForConvert,
  onOpenTapBox,
  onAnyStrokeStart,
  selectedImageId,
  onSelectImage,
  isImageEditMode,
  croppingImageId,
  draftCrop,
  onDraftCropChange,
  onPinchZoom,
}: {
  paneIndex: number;
  page: Page;
  pageIndex: number;
  isActivePage: boolean;
  shouldMountCanvas: boolean;
  sharedRulerRef: React.MutableRefObject<{ x: number; y: number; angle: number }>;
  onRulerSync: () => void;
  onRequestUnlockPage: (page: Page) => void;
  onSelectStrokesForConvert: (page: Page, strokes: InkStroke[]) => void;
  onOpenTapBox: (page: Page, pt: { x: number; y: number }) => void;
  onAnyStrokeStart: () => void;
  selectedImageId: string | null;
  onSelectImage: (id: string | null) => void;
  isImageEditMode: boolean;
  croppingImageId: string | null;
  draftCrop: ImageCrop | null;
  onDraftCropChange: (crop: ImageCrop) => void;
  onPinchZoom?: (factor: number, ended: boolean) => void;
}) {
  const version = useApp((s) => s.strokeVersion);
  const paper = useApp((s) => s.paper);
  const kind = useApp((s) => s.tool.kind);
  const rulerVisible = useApp((s) => s.tool.rulerVisible);
  const rulerUnits = useApp((s) => s.tool.rulerUnits);
  const hostRef = useRef<HTMLDivElement>(null);
  const surfRef = useRef<InkSurface | null>(null);
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [keepMountedForStroke, setKeepMountedForStroke] = useState(false);

  const mountCanvas = shouldMountCanvas || keepMountedForStroke || isActivePage;
  const isPageLocked = !!page.passwordLock && !isDocumentUnlockedInSession(page.id);

  const isActivePageRef = useRef(isActivePage);
  isActivePageRef.current = isActivePage;
  const selectedImageIdRef = useRef(selectedImageId);
  selectedImageIdRef.current = selectedImageId;
  const isImageEditModeRef = useRef(isImageEditMode);
  isImageEditModeRef.current = isImageEditMode;
  const croppingImageIdRef = useRef(croppingImageId);
  croppingImageIdRef.current = croppingImageId;
  const draftCropRef = useRef(draftCrop);
  draftCropRef.current = draftCrop;

  useEffect(() => {
    if (!mountCanvas || !hostRef.current) {
      if (surfRef.current && !surfRef.current.isStrokeActive()) {
        surfRef.current.destroy();
        surfRef.current = null;
      }
      return;
    }
    const surface = new InkSurface(hostRef.current, {
      getTool: () => {
        const t = useApp.getState().tool;
        return isActivePageRef.current ? t : { ...t, rulerVisible: false };
      },
      getPaper: () => {
        const n = useApp.getState().notebooks.find((x) => x.id === page.notebookId);
        return { color: n?.paper ?? '#000000', template: n?.template ?? 'blank' };
      },
      getLayers: () => getLayers(page.id),
      activeLayerId: () => getActiveLayer(page.id),
      getTexts: () => getTexts(page.id),
      getImages: () => getImages(page.id),
      getSelectedImageId: () => (isActivePageRef.current ? selectedImageIdRef.current : null),
      isImageEditMode: () => isActivePageRef.current && (isImageEditModeRef.current || !!selectedImageIdRef.current),
      getCroppingImageId: () => (isActivePageRef.current ? croppingImageIdRef.current : null),
      getDraftCrop: () => (isActivePageRef.current ? draftCropRef.current : null),
      onDraftCropChange: (crop) => onDraftCropChange(crop),
      onImageSelect: (im) => {
        if (im && useApp.getState().panes[paneIndex]?.pageId !== page.id) {
          actions.setPage(paneIndex, page.id);
        }
        onSelectImage(im?.id ?? null);
      },
      onImageCommit: (prev, next) => actions.commitImageEdit(page.id, prev, next),
      onStroke: (st) => {
        setKeepMountedForStroke(false);
        actions.commitStroke(st);
      },
      onEdit: (label, rm, add) => actions.commitEdit(label, rm, add),
      onActivate: () => {
        actions.setActivePane(paneIndex);
        if (useApp.getState().panes[paneIndex]?.pageId !== page.id) {
          actions.setPage(paneIndex, page.id);
        }
      },
      onSelection: setSel,
      onCopy: (list) => actions.copy(list),
      onCanvasTap: (pt) => onOpenTapBox(page, pt),
      onCloseRuler: () => actions.setTool({ rulerVisible: false }),
      onStrokeStart: () => {
        setKeepMountedForStroke(true);
        onAnyStrokeStart();
      },
      getRuler: () => sharedRulerRef.current,
      onRulerChange: (r) => {
        sharedRulerRef.current = r;
        onRulerSync();
      },
      fitFullHost: true,
      disableCanvasPanWheel: true,
      onPinchZoom,
    });
    surfRef.current = surface;
    surface.setPage(page, getStrokes(page.id));
    return () => {
      surface.destroy();
      surfRef.current = null;
    };
  }, [mountCanvas, page.id, page.notebookId, paneIndex]);

  useEffect(() => {
    surfRef.current?.setStrokes(getStrokes(page.id));
  }, [version, page.id]);

  useEffect(() => {
    surfRef.current?.invalidate();
  }, [paper, rulerVisible, rulerUnits, isActivePage, selectedImageId, isImageEditMode, croppingImageId, draftCrop, version]);

  useEffect(() => {
    if (kind !== 'lasso') surfRef.current?.clearSelection();
  }, [kind]);

  const act = (a: 'delete' | 'duplicate' | 'cut' | 'copy') => surfRef.current?.selectionAction(a);

  return (
    <div
      className={`continuous-page-card ${isActivePage ? 'active' : ''}`}
      data-page-id={page.id}
      data-page-index={pageIndex}
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
      onPointerDown={() => {
        if (useApp.getState().panes[paneIndex]?.pageId !== page.id) {
          actions.setPage(paneIndex, page.id);
        }
      }}
    >
      <div className="continuous-canvas-host" ref={hostRef} style={{ background: paper }} />

      {!mountCanvas && (
        <div
          className="continuous-page-placeholder"
          style={{ background: paper }}
          aria-label={`Page ${pageIndex + 1} preview`}
        >
          <span>Page {pageIndex + 1}</span>
        </div>
      )}

      {isPageLocked && (
        <div
          className="page-lock-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(15, 15, 18, 0.92)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            zIndex: 15,
          }}
        >
          <Lock size={36} color="#1E88FF" />
          <h3 style={{ margin: 0, fontSize: 18 }}>Page {pageIndex + 1} is Password Protected</h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Enter this page’s password to view and edit its notes.
          </p>
          <button type="button" className="nn-create" onClick={() => onRequestUnlockPage(page)}>
            Unlock Page
          </button>
        </div>
      )}

      {sel && kind === 'lasso' && isActivePage && (
        <div
          className="sel-menu"
          role="toolbar"
          aria-label="Selection actions"
          style={{ left: Math.max(8, sel.rect.x + sel.rect.w / 2), top: Math.max(8, sel.rect.y - 56) }}
        >
          <button onClick={() => act('cut')}>
            <Scissors size={16} /> Cut
          </button>
          <button onClick={() => act('copy')}>
            <Copy size={16} /> Copy
          </button>
          <button onClick={() => act('duplicate')}>
            <CopyPlus size={16} /> Duplicate
          </button>
          <button onClick={() => act('delete')}>
            <Trash2 size={16} /> Delete
          </button>
          <button
            onClick={() => {
              const picked = surfRef.current?.getSelectedStrokes() ?? [];
              if (picked.length) onSelectStrokesForConvert(page, picked);
            }}
          >
            <Type size={16} /> Convert to Text
          </button>
        </div>
      )}
    </div>
  );
}

function Pane({
  index,
  selectedImageId,
  onSelectImage,
  isImageEditMode,
  croppingImageId,
  draftCrop,
  onDraftCropChange,
  onRequestUnlockPage,
}: {
  index: number;
  selectedImageId: string | null;
  onSelectImage: (id: string | null) => void;
  isImageEditMode: boolean;
  croppingImageId: string | null;
  draftCrop: ImageCrop | null;
  onDraftCropChange: (crop: ImageCrop) => void;
  onRequestUnlockPage: (page: Page) => void;
}) {
  const pane = useApp((s) => s.panes[index]);
  const active = useApp((s) => s.activePane === index);
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedImageIdRef = useRef(selectedImageId);
  selectedImageIdRef.current = selectedImageId;
  const isImageEditModeRef = useRef(isImageEditMode);
  isImageEditModeRef.current = isImageEditMode;
  const croppingImageIdRef = useRef(croppingImageId);
  croppingImageIdRef.current = croppingImageId;
  const draftCropRef = useRef(draftCrop);
  draftCropRef.current = draftCrop;
  const paper = useApp((s) => s.paper);
  const version = useApp((s) => s.strokeVersion);
  const kind = useApp((s) => s.tool.kind);
  const rulerVisible = useApp((s) => s.tool.rulerVisible);
  const rulerUnits = useApp((s) => s.tool.rulerUnits);
  const pageViewMode = useApp((s) => s.pageViewMode);
  const liveAnnouncement = useApp((s) => s.liveAnnouncement);
  const hasClip = useApp((s) => s.hasClipboard);
  const debug = useApp((s) => s.debug);
  const host = useRef<HTMLDivElement>(null);
  const surf = useRef<InkSurface | null>(null);
  const zHost = useRef<HTMLDivElement>(null);
  const zSurf = useRef<InkSurface | null>(null);
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const sharedRulerRef = useRef<{ x: number; y: number; angle: number }>({ x: 297, y: 420, angle: 0 });
  const swipeCtrlRef = useRef<SwipeToAddController>(new SwipeToAddController());
  const [swipeSnap, setSwipeSnap] = useState<SwipeAddSnapshot>(swipeCtrlRef.current.getSnapshot());
  const [stats, setStats] = useState('');
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [convertTarget, setConvertTarget] = useState<{ page: Page; strokes: InkStroke[] } | null>(null);
  const [tapBox, setTapBox] = useState<{ pageId: string; x: number; y: number; text: string } | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [continuousScale, setContinuousScale] = useState(1);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [zoomWin, setZoomWin] = useState({ open: false, x: 40, y: 120, w: 200, h: 65, scale: 2.5 });
  const activeTouchIdsRef = useRef<Set<number>>(new Set());
  const isPenDownRef = useRef(false);
  const [scrollThumb, setScrollThumb] = useState({ topPct: 0, heightPct: 100, visible: false, hasOverflow: false });
  const scrollFadeTimerRef = useRef<number>(0);
  const programmaticScrollUntilRef = useRef(0);
  const addingPageRef = useRef(false);

  // Sync zoomScale to continuousScale when in continuous mode
  useEffect(() => {
    if (pageViewMode === 'continuous') {
      setZoomScale(continuousScale);
    }
  }, [pageViewMode, continuousScale]);

  const updateScrollThumb = (wrap: HTMLDivElement) => {
    const sh = wrap.scrollHeight;
    const ch = wrap.clientHeight;
    if (sh <= ch + 2) {
      setScrollThumb({ topPct: 0, heightPct: 100, visible: false, hasOverflow: false });
      return;
    }
    const heightPct = Math.max(8, (ch / sh) * 100);
    const maxTop = 100 - heightPct;
    const topPct = Math.min(maxTop, Math.max(0, (wrap.scrollTop / Math.max(1, sh - ch)) * maxTop));
    setScrollThumb({ topPct, heightPct, visible: true, hasOverflow: true });
    window.clearTimeout(scrollFadeTimerRef.current);
    scrollFadeTimerRef.current = window.setTimeout(() => {
      setScrollThumb((prev) => ({ ...prev, visible: false }));
    }, 1200);
  };

  const changeZoom = (factor: number) => {
    if (pageViewMode === 'continuous') {
      const wrap = scrollWrapRef.current;
      const centerRatio = wrap && wrap.scrollHeight > 0
        ? (wrap.scrollTop + wrap.clientHeight / 2) / wrap.scrollHeight
        : 0;
      setContinuousScale((prev) => {
        let next = Math.max(0.2, Math.min(3.0, prev * factor));
        if (Math.abs(next - 1) <= 0.05) next = 1;
        setZoomScale(next);
        if (wrap) {
          requestAnimationFrame(() => {
            wrap.scrollTop = Math.max(0, centerRatio * wrap.scrollHeight - wrap.clientHeight / 2);
            if (next <= 1) wrap.scrollLeft = 0;
            updateScrollThumb(wrap);
          });
        }
        return next;
      });
    } else {
      surf.current?.zoomByFactor(factor);
    }
  };

  const handleContinuousPinch = (factor: number, ended: boolean) => {
    const wrap = scrollWrapRef.current;
    const centerRatio = wrap && wrap.scrollHeight > 0
      ? (wrap.scrollTop + wrap.clientHeight / 2) / wrap.scrollHeight
      : 0;
    setContinuousScale((prev) => {
      let next = ended ? prev : Math.max(0.2, Math.min(3.0, prev * factor));
      if (ended && Math.abs(next - 1) <= 0.05) {
        next = 1;
      }
      setZoomScale(next);
      if (wrap) {
        requestAnimationFrame(() => {
          wrap.scrollTop = Math.max(0, centerRatio * wrap.scrollHeight - wrap.clientHeight / 2);
          if (next <= 1) wrap.scrollLeft = 0;
          updateScrollThumb(wrap);
        });
      }
      return next;
    });
  };

  const resetFit = () => {
    if (pageViewMode === 'continuous') {
      const wrap = scrollWrapRef.current;
      const centerRatio = wrap && wrap.scrollHeight > 0
        ? (wrap.scrollTop + wrap.clientHeight / 2) / wrap.scrollHeight
        : 0;
      setContinuousScale(1);
      setZoomScale(1);
      if (wrap) {
        requestAnimationFrame(() => {
          wrap.scrollTop = Math.max(0, centerRatio * wrap.scrollHeight - wrap.clientHeight / 2);
          wrap.scrollLeft = 0;
          updateScrollThumb(wrap);
        });
      }
    } else {
      surf.current?.snapToFitWidth();
    }
    setZoomMenuOpen(false);
  };

  const syncRulerSurfaces = () => {
    surf.current?.invalidate();
    zSurf.current?.invalidate();
  };

  useEffect(() => {
    if (pageViewMode !== 'single' || !host.current) return;
    const pageOf = () => useApp.getState().panes[index]?.pageId;
    const surface = new InkSurface(host.current, {
      getTool: () => useApp.getState().tool,
      getPaper: () => {
        const n = useApp.getState().notebooks.find((x) => x.id === useApp.getState().panes[index]?.notebookId);
        return { color: n?.paper ?? '#000000', template: n?.template ?? 'blank' };
      },
      getLayers: () => getLayers(pageOf() ?? ''),
      activeLayerId: () => getActiveLayer(pageOf() ?? ''),
      getTexts: () => getTexts(pageOf() ?? ''),
      getImages: () => getImages(pageOf() ?? ''),
      getSelectedImageId: () => (activeRef.current ? selectedImageIdRef.current : null),
      isImageEditMode: () => activeRef.current && (isImageEditModeRef.current || !!selectedImageIdRef.current),
      getCroppingImageId: () => (activeRef.current ? croppingImageIdRef.current : null),
      getDraftCrop: () => (activeRef.current ? draftCropRef.current : null),
      onDraftCropChange: (crop) => onDraftCropChange(crop),
      onImageSelect: (im) => onSelectImage(im?.id ?? null),
      onImageCommit: (prev, next) => actions.commitImageEdit(prev.pageId, prev, next),
      onStroke: (st) => actions.commitStroke(st),
      onEdit: (label, rm, add) => actions.commitEdit(label, rm, add),
      onActivate: () => actions.setActivePane(index),
      onSelection: setSel,
      onCopy: (list) => actions.copy(list),
      onViewChange: (_v, relScale) => setZoomScale(relScale),
      onCanvasTap: (pt) => {
        const pid = pageOf();
        if (pid) setTapBox({ pageId: pid, x: pt.x, y: pt.y, text: '' });
      },
      onCloseRuler: () => actions.setTool({ rulerVisible: false }),
      onStrokeStart: () => {
        swipeCtrlRef.current.cancel();
        setSwipeSnap(swipeCtrlRef.current.getSnapshot());
      },
      getRuler: () => sharedRulerRef.current,
      onRulerChange: (r) => {
        sharedRulerRef.current = r;
        syncRulerSurfaces();
      },
    });
    surf.current = surface;
    const page = pane && getPages(pane.notebookId).find((p) => p.id === pane.pageId);
    if (page) surface.setPage(page, getStrokes(page.id));
    return () => {
      surface.destroy();
      surf.current = null;
    };
  }, [index, pageViewMode]);

  useEffect(() => {
    if (!zoomWin.open || !zHost.current) return;
    const pageOf = () => useApp.getState().panes[index]?.pageId;
    const zs = new InkSurface(zHost.current, {
      getTool: () => useApp.getState().tool,
      getPaper: () => {
        const n = useApp.getState().notebooks.find((x) => x.id === useApp.getState().panes[index]?.notebookId);
        return { color: n?.paper ?? '#000000', template: n?.template ?? 'blank' };
      },
      getLayers: () => getLayers(pageOf() ?? ''),
      activeLayerId: () => getActiveLayer(pageOf() ?? ''),
      getTexts: () => getTexts(pageOf() ?? ''),
      getImages: () => getImages(pageOf() ?? ''),
      getSelectedImageId: () => (activeRef.current ? selectedImageIdRef.current : null),
      isImageEditMode: () => activeRef.current && (isImageEditModeRef.current || !!selectedImageIdRef.current),
      getCroppingImageId: () => (activeRef.current ? croppingImageIdRef.current : null),
      getDraftCrop: () => (activeRef.current ? draftCropRef.current : null),
      onDraftCropChange: (crop) => onDraftCropChange(crop),
      onImageSelect: (im) => onSelectImage(im?.id ?? null),
      onImageCommit: (prev, next) => actions.commitImageEdit(prev.pageId, prev, next),
      onStroke: (st) => actions.commitStroke(st),
      onEdit: (label, rm, add) => actions.commitEdit(label, rm, add),
      onActivate: () => actions.setActivePane(index),
      onCloseRuler: () => actions.setTool({ rulerVisible: false }),
      getRuler: () => sharedRulerRef.current,
      onRulerChange: (r) => {
        sharedRulerRef.current = r;
        syncRulerSurfaces();
      },
      disableAutoFit: true,
    });
    zSurf.current = zs;
    const page = pane && getPages(pane.notebookId).find((p) => p.id === pane.pageId);
    if (page) zs.setPage(page, getStrokes(page.id));
    zs.setView({ scale: zoomWin.scale, tx: -zoomWin.x * zoomWin.scale, ty: -zoomWin.y * zoomWin.scale });
    return () => {
      zs.destroy();
      zSurf.current = null;
    };
  }, [zoomWin.open, index]);

  useEffect(() => {
    surf.current?.invalidate();
    if (zSurf.current && zoomWin.open) {
      zSurf.current.setView({ scale: zoomWin.scale, tx: -zoomWin.x * zoomWin.scale, ty: -zoomWin.y * zoomWin.scale });
    }
  }, [zoomWin.x, zoomWin.y, zoomWin.w, zoomWin.h, zoomWin.scale, zoomWin.open]);

  useEffect(() => {
    surf.current?.invalidate();
    zSurf.current?.invalidate();
  }, [rulerVisible, rulerUnits]);

  useEffect(() => {
    const page = pane && getPages(pane.notebookId).find((p) => p.id === pane.pageId);
    if (page) {
      surf.current?.setPage(page, getStrokes(page.id));
      zSurf.current?.setPage(page, getStrokes(page.id));
    }
  }, [pane?.pageId, pane?.notebookId, pageViewMode]);

  useEffect(() => {
    if (pane) {
      const list = getStrokes(pane.pageId);
      surf.current?.setStrokes(list);
      zSurf.current?.setStrokes(list);
    }
  }, [version, pane?.pageId]);

  useEffect(() => {
    surf.current?.invalidate();
  }, [paper]);
  useEffect(() => {
    surf.current?.invalidate();
    zSurf.current?.invalidate();
  }, [active, selectedImageId, isImageEditMode, croppingImageId, draftCrop, version]);
  useEffect(() => {
    if (kind !== 'lasso') surf.current?.clearSelection();
  }, [kind]);

  // Cancel any pending swipe when switching view mode, notebook, or pane
  useEffect(() => {
    swipeCtrlRef.current.cancel();
    setSwipeSnap(swipeCtrlRef.current.getSnapshot());
  }, [pageViewMode, pane?.notebookId, active]);

  // When switching into Continuous Scroll mode, scroll current active page into view
  useEffect(() => {
    if (pageViewMode === 'continuous' && scrollWrapRef.current && pane?.pageId) {
      const card = scrollWrapRef.current.querySelector(`[data-page-id="${pane.pageId}"]`) as HTMLElement | null;
      card?.scrollIntoView({ block: 'nearest' });
    }
  }, [pageViewMode]);

  useEffect(() => {
    if (!debug) return;
    const t = setInterval(() => setStats(JSON.stringify(surf.current?.getStats())), 1000);
    return () => clearInterval(t);
  }, [debug]);

  const pages = pane ? getPages(pane.notebookId) : [];
  const idx = pages.findIndex((p) => p.id === pane?.pageId);
  const currentPage = idx >= 0 ? pages[idx] : undefined;
  const isPageLocked = !!currentPage?.passwordLock && !isDocumentUnlockedInSession(currentPage.id);
  const act = (a: 'delete' | 'duplicate' | 'cut' | 'copy') => surf.current?.selectionAction(a);

  const commitTappedText = () => {
    if (!tapBox) return;
    const targetPage = pages.find((p) => p.id === tapBox.pageId) ?? currentPage;
    if (!targetPage) return;
    const val = tapBox.text.trim();
    if (val) {
      const st = useApp.getState();
      const tb: TextBox = {
        kind: 'text',
        id: crypto.randomUUID(),
        pageId: targetPage.id,
        layerId: getActiveLayer(targetPage.id) ?? targetPage.layerIds[0],
        text: val,
        fontFamily: st.activeFontFamily,
        fontAssetId: st.activeFontAssetId,
        fontSize: st.activeFontSize,
        color: st.tool.color,
        align: 'left',
        lineHeight: 1.3,
        bounds: {
          x0: tapBox.x,
          y0: tapBox.y,
          x1: tapBox.x + Math.max(160, val.length * (st.activeFontSize * 0.6)),
          y1: tapBox.y + st.activeFontSize * 1.6,
        },
        order: Date.now(),
        revision: 1,
      };
      actions.commitTextEdit(targetPage.id, null, tb);
    }
    setTapBox(null);
  };

  const scrollToAndActivatePage = (pageId: string) => {
    programmaticScrollUntilRef.current = performance.now() + 700;
    actions.setPage(index, pageId);
    if (pageViewMode === 'continuous' && scrollWrapRef.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = scrollWrapRef.current?.querySelector(`[data-page-id="${pageId}"]`) as HTMLElement | null;
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }
  };

  const handleAddPageAfterAndScroll = async (afterPageId?: string) => {
    if (addingPageRef.current) return;
    addingPageRef.current = true;
    try {
      programmaticScrollUntilRef.current = performance.now() + 850;
      const newId = await actions.addPageAfter(index, afterPageId);
      if (newId && pageViewMode === 'continuous') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const wrap = scrollWrapRef.current;
            const el = wrap?.querySelector(`[data-page-id="${newId}"]`) as HTMLElement | null;
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (wrap) updateScrollThumb(wrap);
          });
        });
      }
    } finally {
      addingPageRef.current = false;
    }
  };

  return (
    <section className={`pane ${active ? 'active' : ''}`} aria-label={`Pane ${index + 1}`}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {pageViewMode === 'single' ? (
        <>
          <div className="canvas-host" ref={host} />

          {isPageLocked && currentPage && (
            <div
              className="page-lock-overlay"
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(15, 15, 18, 0.92)',
                backdropFilter: 'blur(10px)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                zIndex: 15,
              }}
            >
              <Lock size={36} color="#1E88FF" />
              <h3 style={{ margin: 0, fontSize: 18 }}>Page {idx + 1} is Password Protected</h3>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                Enter this page’s password to view and edit its notes.
              </p>
              <button type="button" className="nn-create" onClick={() => onRequestUnlockPage(currentPage)}>
                Unlock Page
              </button>
            </div>
          )}

          {sel && kind === 'lasso' && (
            <div
              className="sel-menu"
              role="toolbar"
              aria-label="Selection actions"
              style={{ left: Math.max(8, sel.rect.x + sel.rect.w / 2), top: Math.max(8, sel.rect.y - 56) }}
            >
              <button onClick={() => act('cut')}>
                <Scissors size={16} /> Cut
              </button>
              <button onClick={() => act('copy')}>
                <Copy size={16} /> Copy
              </button>
              <button onClick={() => act('duplicate')}>
                <CopyPlus size={16} /> Duplicate
              </button>
              <button onClick={() => act('delete')}>
                <Trash2 size={16} /> Delete
              </button>
              <button
                onClick={() => {
                  const picked = surf.current?.getSelectedStrokes() ?? [];
                  if (picked.length && currentPage) setConvertTarget({ page: currentPage, strokes: picked });
                }}
              >
                <Type size={16} /> Convert to Text
              </button>
            </div>
          )}
        </>
      ) : (
        <div
          className="continuous-scroll-pane"
          ref={scrollWrapRef}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch') {
              activeTouchIdsRef.current.add(e.pointerId);
            } else if (e.pointerType === 'pen') {
              isPenDownRef.current = true;
            }
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch') {
              activeTouchIdsRef.current.delete(e.pointerId);
            } else if (e.pointerType === 'pen') {
              isPenDownRef.current = false;
            }
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') {
              activeTouchIdsRef.current.delete(e.pointerId);
            } else if (e.pointerType === 'pen') {
              isPenDownRef.current = false;
            }
          }}
          onScroll={(e) => {
            const wrap = e.currentTarget;
            updateScrollThumb(wrap);
            if (performance.now() < programmaticScrollUntilRef.current) return;
            const centerY = wrap.scrollTop + wrap.clientHeight * 0.5;
            const cards = wrap.querySelectorAll<HTMLElement>('.continuous-page-card');
            let bestId: string | undefined;
            let bestDist = Infinity;
            for (const c of cards) {
              const top = c.offsetTop;
              const bottom = top + c.offsetHeight;
              if (centerY >= top && centerY <= bottom) {
                bestId = c.dataset.pageId;
                break;
              }
              const mid = (top + bottom) / 2;
              const dist = Math.abs(centerY - mid);
              if (dist < bestDist) {
                bestDist = dist;
                bestId = c.dataset.pageId;
              }
            }
            if (bestId && bestId !== pane?.pageId) {
              actions.setPage(index, bestId);
            }
          }}
        >
          <div
            className="continuous-pages-stack"
            style={{
              maxWidth: `${Math.round(1400 * continuousScale)}px`,
              width: `${Math.round(100 * continuousScale)}%`,
            }}
          >
            {pages.map((pg, pageIdx) => {
              // Bounded canvas virtualization: mount active page ± 2 neighbors (minimum 5 pages) so long notebooks stay light
              const shouldMountCanvas = Math.abs(pageIdx - Math.max(0, idx)) <= 2;
              return (
                <div key={pg.id} className="continuous-page-block">
                  <div className="continuous-page-header">
                    <span className="continuous-page-badge">
                      Page {pageIdx + 1} of {pages.length}
                    </span>
                  </div>
                  <ContinuousPageCard
                    paneIndex={index}
                    page={pg}
                    pageIndex={pageIdx}
                    isActivePage={pg.id === pane?.pageId}
                    shouldMountCanvas={shouldMountCanvas}
                    sharedRulerRef={sharedRulerRef}
                    onRulerSync={syncRulerSurfaces}
                    onRequestUnlockPage={onRequestUnlockPage}
                    onSelectStrokesForConvert={(p, strokes) => setConvertTarget({ page: p, strokes })}
                    onOpenTapBox={(p, pt) => setTapBox({ pageId: p.id, x: pt.x, y: pt.y, text: '' })}
                    onAnyStrokeStart={() => {
                      swipeCtrlRef.current.cancel();
                      setSwipeSnap(swipeCtrlRef.current.getSnapshot());
                    }}
                    selectedImageId={selectedImageId}
                    onSelectImage={onSelectImage}
                    isImageEditMode={isImageEditMode}
                    croppingImageId={croppingImageId}
                    draftCrop={draftCrop}
                    onDraftCropChange={onDraftCropChange}
                    onPinchZoom={handleContinuousPinch}
                  />
                  {pageIdx < pages.length - 1 && (
                    <div className="page-boundary-bar" role="group" aria-label={`After page ${pageIdx + 1}`}>
                      <span className="page-boundary-line" />
                      <button
                        type="button"
                        className="page-boundary-add-btn"
                        aria-label={`Add page below page ${pageIdx + 1}`}
                        title={`Add page below page ${pageIdx + 1}`}
                        onClick={() => void handleAddPageAfterAndScroll(pg.id)}
                      >
                        <Plus size={14} /> <span>Add page below</span>
                      </button>
                      <span className="page-boundary-line" />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Deliberate Bottom Swipe-to-Add-Page Affordance + Accessible Add Page Button */}
            <div className="bottom-add-page-zone">
              <div
                className={`swipe-add-affordance ${swipeSnap.state}`}
                role="region"
                aria-label="Swipe up to add a page"
                style={{
                  transform:
                    swipeSnap.state === 'dragging' || swipeSnap.state === 'armed'
                      ? `translateY(${-Math.round(swipeSnap.pullPx * 0.35)}px)`
                      : undefined,
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === 'touch') activeTouchIdsRef.current.add(e.pointerId);
                  const touches = Math.max(1, activeTouchIdsRef.current.size);
                  const snap = swipeCtrlRef.current.start({
                    pointerId: e.pointerId,
                    pointerType: e.pointerType,
                    clientY: e.clientY,
                    timeStamp: e.timeStamp,
                    activeTouchCount: touches,
                    penDown: isPenDownRef.current,
                    rulerDragging: false,
                  });
                  setSwipeSnap(snap);
                  if (snap.state === 'dragging') {
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      /* ignore */
                    }
                  }
                }}
                onPointerMove={(e) => {
                  const touches = Math.max(1, activeTouchIdsRef.current.size);
                  const snap = swipeCtrlRef.current.move(e.pointerId, e.clientY, {
                    activeTouchCount: touches,
                    penDown: isPenDownRef.current || e.pointerType === 'pen',
                    rulerDragging: false,
                  });
                  setSwipeSnap(snap);
                }}
                onPointerUp={(e) => {
                  if (e.pointerType === 'touch') activeTouchIdsRef.current.delete(e.pointerId);
                  const res = swipeCtrlRef.current.end(e.pointerId, e.timeStamp);
                  setSwipeSnap(res.snapshot);
                  if (res.shouldAddPage) {
                    const lastId = pages[pages.length - 1]?.id;
                    void handleAddPageAfterAndScroll(lastId);
                  }
                }}
                onPointerCancel={(e) => {
                  if (e.pointerType === 'touch') activeTouchIdsRef.current.delete(e.pointerId);
                  const snap = swipeCtrlRef.current.cancel();
                  setSwipeSnap(snap);
                }}
              >
                <div className="swipe-add-pill">
                  <span className={`swipe-add-icon ${swipeSnap.state === 'armed' ? 'armed' : ''}`}>
                    <ArrowUp size={16} />
                  </span>
                  <span className="swipe-add-label">{swipeSnap.label}</span>
                  <div className="swipe-add-progress-track" aria-hidden="true">
                    <div
                      className="swipe-add-progress-fill"
                      style={{ width: `${Math.round(swipeSnap.progress * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="bottom-explicit-add-btn"
                aria-label="Add Page"
                onClick={() => void handleAddPageAfterAndScroll(pages[pages.length - 1]?.id)}
              >
                <Plus size={16} /> <span>Add Page</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {tapBox && (
        <div
          className="popover"
          style={{
            position: 'absolute',
            left: '50%',
            top: 72,
            transform: 'translateX(-50%)',
            zIndex: 25,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: 10,
          }}
        >
          <input
            autoFocus
            className="nn-input"
            placeholder="Write or type text (Apple Scribble / S-Pen Ready)…"
            value={tapBox.text}
            onChange={(e) => setTapBox({ ...tapBox, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTappedText();
              if (e.key === 'Escape') setTapBox(null);
            }}
            style={{ minWidth: 260 }}
          />
          <button type="button" className="nn-create" onClick={commitTappedText}>
            Add Text
          </button>
          <button type="button" className="icon sm" aria-label="Cancel text" onClick={() => setTapBox(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      {convertTarget && (
        <ConvertToTextModal
          page={convertTarget.page}
          strokes={convertTarget.strokes}
          onClose={() => setConvertTarget(null)}
          onConverted={() => surf.current?.clearSelection()}
        />
      )}

      {/* Compact bottom-left readout: "20% | 45 of 73" */}
      <div className="hud-left-readout" aria-label="Zoom and page indicator">
        <span>{Math.round(zoomScale * 100)}%</span>
        <span className="hud-left-readout-sep" aria-hidden="true" />
        <span>
          {Math.max(1, idx + 1)} of {Math.max(1, pages.length)}
        </span>
      </div>

      {/* Slim neutral vertical scroll thumb at far right in Continuous mode */}
      {pageViewMode === 'continuous' && scrollThumb.hasOverflow && (
        <div
          className="continuous-scroll-thumb-hit"
          style={{ opacity: scrollThumb.visible ? 1 : 0.25 }}
          aria-hidden="true"
          onPointerDown={(e) => {
            const wrap = scrollWrapRef.current;
            if (!wrap) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const rect = e.currentTarget.getBoundingClientRect();
            const scrub = (clientY: number) => {
              const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
              wrap.scrollTop = ratio * Math.max(0, wrap.scrollHeight - wrap.clientHeight);
              updateScrollThumb(wrap);
            };
            scrub(e.clientY);
            const onMove = (ev: PointerEvent) => scrub(ev.clientY);
            const onUp = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
              window.removeEventListener('pointercancel', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
          }}
        >
          <div
            className="continuous-scroll-thumb"
            style={{
              top: `${scrollThumb.topPct}%`,
              height: `${scrollThumb.heightPct}%`,
            }}
          />
        </div>
      )}

      {zoomMenuOpen && (
        <div
          className="popover-scrim"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setZoomMenuOpen(false);
          }}
        />
      )}

      {/* Compact unified Tablet Bottom HUD (Non-overlapping & Responsive) */}
      <div
        className="hud-bottom-bar"
        role="toolbar"
        aria-label="Page navigation and document view"
        style={{ zIndex: zoomMenuOpen ? 38 : undefined }}
      >
        <div className="hud-pager-group">
          <button
            className="icon xs hud-btn"
            disabled={idx <= 0}
            aria-label="Previous page"
            onClick={() => scrollToAndActivatePage(pages[idx - 1].id)}
          >
            ‹
          </button>
          <span className="hud-status-badge" title="Current page">
            {idx + 1} / {pages.length}
          </span>
          <button
            className="icon xs hud-btn"
            disabled={idx >= pages.length - 1}
            aria-label="Next page"
            onClick={() => scrollToAndActivatePage(pages[idx + 1].id)}
          >
            ›
          </button>
          <button
            className="icon xs hud-btn"
            aria-label="Add page below"
            title="Add page below"
            onClick={() => void handleAddPageAfterAndScroll(currentPage?.id)}
          >
            <Plus size={15} />
          </button>
          {hasClip && (
            <button
              className="icon xs hud-btn"
              aria-label="Paste"
              onClick={() => surf.current?.paste(actions.getClipboard())}
            >
              <ClipboardPaste size={14} />
            </button>
          )}
        </div>

        <div className="hud-view-group">
          <button
            className={`hud-mode-pill ${pageViewMode === 'continuous' ? 'on' : ''}`}
            aria-label={pageViewMode === 'continuous' ? 'Switch to Single Page' : 'Switch to Continuous Scroll'}
            onClick={() => actions.setPageViewMode(pageViewMode === 'continuous' ? 'single' : 'continuous')}
          >
            {pageViewMode === 'continuous' ? 'Continuous' : 'Single'}
          </button>

          <button
            className={`icon xs hud-btn ${rulerVisible ? 'on' : ''}`}
            aria-label="Toggle ruler"
            aria-pressed={rulerVisible}
            title="Toggle straightedge ruler"
            onClick={() => actions.setTool({ rulerVisible: !rulerVisible })}
          >
            <Ruler size={15} />
          </button>

          {/* Zoom % readout + Quick View Affordance Popover */}
          <div style={{ position: 'relative' }}>
            <button
              className={`hud-zoom-badge ${zoomMenuOpen ? 'on' : ''}`}
              aria-label="Zoom actions"
              aria-expanded={zoomMenuOpen}
              onClick={() => setZoomMenuOpen((o) => !o)}
            >
              <span>{Math.round(zoomScale * 100)}%</span>
            </button>

            {zoomMenuOpen && (
              <div className="popover hud-zoom-popover" role="dialog" aria-label="Zoom controls">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px' }}>
                  <button
                    className="icon xs"
                    aria-label="Zoom out"
                    title="Zoom out"
                    onClick={() => changeZoom(0.85)}
                  >
                    −
                  </button>
                  <button
                    className="icon xs"
                    aria-label="Zoom in"
                    title="Zoom in"
                    onClick={() => changeZoom(1.15)}
                  >
                    +
                  </button>
                  <button
                    className="chip"
                    style={{ fontSize: 12, padding: '0 8px', minHeight: 28 }}
                    onClick={resetFit}
                  >
                    Fit
                  </button>
                  <button
                    className="icon xs"
                    aria-label="Close"
                    onClick={() => setZoomMenuOpen(false)}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {zoomWin.open && (
        <div className="zoom-win" role="region" aria-label="Magnified writing window">
          <div className="zoom-bar">
            <span>Zoom {zoomWin.scale.toFixed(1)}×</span>
            <button
              className="icon xs"
              aria-label="Zoom out"
              onClick={() => setZoomWin((z) => ({ ...z, scale: Math.max(1.5, z.scale - 0.5) }))}
            >
              −
            </button>
            <button
              className="icon xs"
              aria-label="Zoom in"
              onClick={() => setZoomWin((z) => ({ ...z, scale: Math.min(4, z.scale + 0.5) }))}
            >
              +
            </button>
            <button
              className="icon xs"
              aria-label="Advance left"
              onClick={() => setZoomWin((z) => ({ ...z, x: Math.max(20, z.x - 100) }))}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              className="icon xs"
              aria-label="Advance right"
              onClick={() => setZoomWin((z) => ({ ...z, x: Math.min(360, z.x + 100) }))}
            >
              <ArrowRight size={16} />
            </button>
            <button
              className="icon xs"
              aria-label="Next line"
              onClick={() => setZoomWin((z) => ({ ...z, x: 40, y: Math.min(720, z.y + 48) }))}
            >
              <CornerDownLeft size={16} />
            </button>
            <button
              className="icon xs"
              aria-label="Close zoom window"
              onClick={() => setZoomWin((z) => ({ ...z, open: false }))}
            >
              <X size={16} />
            </button>
          </div>
          <div
            className="zoom-host"
            ref={zHost}
            style={{ width: zoomWin.w * zoomWin.scale, height: zoomWin.h * zoomWin.scale }}
          />
        </div>
      )}
      {debug && <pre className="debug">{stats}</pre>}
    </section>
  );
}

function LayersPanel({ pageId }: { pageId: string }) {
  useApp((s) => s.layerVersion);
  const layers = getLayers(pageId);
  const activeId = getActiveLayer(pageId);
  const shown = [...layers].reverse(); // topmost first
  return (
    <div className="layers">
      {shown.map((l) => (
        <div key={l.id} className={`layer ${activeId === l.id ? 'sel' : ''}`}>
          <button
            className="layer-name"
            aria-pressed={activeId === l.id}
            onClick={() => actions.setActiveLayer(pageId, l.id)}
          >
            <input
              aria-label="Layer name"
              className="layer-input"
              defaultValue={l.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => void actions.mutateLayer(pageId, l.id, { name: e.target.value || l.name })}
            />
          </button>
          <div className="layer-ctl">
            <button
              className="icon xs"
              aria-label={l.visible ? 'Hide layer' : 'Show layer'}
              onClick={() => void actions.mutateLayer(pageId, l.id, { visible: !l.visible })}
            >
              {l.visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
            <button
              className="icon xs"
              aria-label={l.locked ? 'Unlock layer' : 'Lock layer'}
              onClick={() => void actions.mutateLayer(pageId, l.id, { locked: !l.locked })}
            >
              {l.locked ? <Lock size={16} /> : <LockOpen size={16} />}
            </button>
            <button
              className="icon xs"
              aria-label="Move layer up"
              onClick={() => void actions.moveLayer(pageId, l.id, 1)}
            >
              <ArrowUp size={16} />
            </button>
            <button
              className="icon xs"
              aria-label="Move layer down"
              onClick={() => void actions.moveLayer(pageId, l.id, -1)}
            >
              <ArrowDown size={16} />
            </button>
            <button
              className="icon xs"
              aria-label="Delete layer"
              disabled={layers.length <= 1}
              onClick={() => {
                if (confirm(`Delete "${l.name}" and its ink?`)) void actions.deleteLayer(pageId, l.id);
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <input
            type="range"
            aria-label="Layer opacity"
            min="0.1"
            max="1"
            step="0.05"
            value={l.opacity}
            onChange={(e) => void actions.mutateLayer(pageId, l.id, { opacity: +e.target.value })}
          />
        </div>
      ))}
      <button className="thumb add" onClick={() => void actions.addLayer(pageId)}>
        <Plus size={16} /> Add layer
      </button>
    </div>
  );
}

type ToolbarToolId =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'hand'
  | 'laser'
  | 'text'
  | 'page'
  | 'image'
  | 'shape'
  | 'insert';

interface ToolbarItemConfig {
  id: ToolbarToolId;
  label: string;
  visible: boolean;
}

const TOOLBAR_CONFIG_KEY = 'mynotes.toolbarConfig.v2';
const PINNED_PAGES_KEY = 'mynotes.pinnedPages.v1';

const DEFAULT_TOOLBAR_ITEMS: ToolbarItemConfig[] = [
  { id: 'pen', label: 'Pen Tool', visible: true },
  { id: 'highlighter', label: 'Highlighter Tool', visible: true },
  { id: 'eraser', label: 'Eraser Tool', visible: true },
  { id: 'lasso', label: 'Lasso Tool', visible: true },
  { id: 'image', label: 'Add Image', visible: true },
  { id: 'shape', label: 'Shape', visible: true },
  { id: 'hand', label: 'Hand Tool', visible: true },
  { id: 'laser', label: 'Presentation Tool', visible: true },
  { id: 'text', label: 'Text Tool', visible: false },
  { id: 'page', label: 'Page', visible: false },
  { id: 'insert', label: 'Insert', visible: false },
];

function loadToolbarConfig(): ToolbarItemConfig[] {
  try {
    const raw = localStorage.getItem(TOOLBAR_CONFIG_KEY);
    if (!raw) return DEFAULT_TOOLBAR_ITEMS;
    const parsed = JSON.parse(raw) as ToolbarItemConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TOOLBAR_ITEMS;
    const byId = new Map(parsed.map((x) => [x.id, x]));
    const merged: ToolbarItemConfig[] = [];
    for (const item of parsed) {
      const def = DEFAULT_TOOLBAR_ITEMS.find((d) => d.id === item.id);
      if (def) merged.push({ id: def.id, label: def.label, visible: !!item.visible });
    }
    for (const def of DEFAULT_TOOLBAR_ITEMS) {
      if (!byId.has(def.id)) merged.push(def);
    }
    return merged;
  } catch {
    return DEFAULT_TOOLBAR_ITEMS;
  }
}

type Pop = 'style' | 'wheel' | 'eraser' | 'shape' | 'more' | 'insert' | null;

export function Editor() {
  const s = useApp();
  const [wide, setWide] = useState(window.innerWidth >= 900);
  const [pop, setPop] = useState<Pop>(null);
  const [styleTab, setStyleTab] = useState<StylePopoverTab>('style');
  const [panelTab, setPanelTab] = useState<'pages' | 'layers'>('pages');
  const [pwModal, setPwModal] = useState<{
    mode: PasswordModalMode;
    targetKind: 'notebook' | 'page';
    targetId: string;
    targetName: string;
  } | null>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pendingInsertPageIdRef = useRef<string | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [isImageEditMode, setIsImageEditMode] = useState(false);
  const [croppingImageId, setCroppingImageId] = useState<string | null>(null);
  const [draftCrop, setDraftCrop] = useState<ImageCrop | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [toolbarItems, setToolbarItems] = useState<ToolbarItemConfig[]>(() => loadToolbarConfig());
  const [showCustomizeToolbar, setShowCustomizeToolbar] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareFormat, setShareFormat] = useState<'pdf' | 'jpg'>('pdf');
  const [sharePageScope, setSharePageScope] = useState<'current' | 'all' | 'range'>('all');
  const [shareRangeInput, setShareRangeInput] = useState('1');
  const [printPageUrls, setPrintPageUrls] = useState<string[]>([]);
  const [showFindModal, setShowFindModal] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [showPageJumpModal, setShowPageJumpModal] = useState(false);
  const [jumpPageNum, setJumpPageNum] = useState('');
  const [showResizeModal, setShowResizeModal] = useState(false);
  const [showPaperModal, setShowPaperModal] = useState(false);
  const [showGestureSettings, setShowGestureSettings] = useState(false);
  const [showDocEditing, setShowDocEditing] = useState(false);
  const [pinnedPages, setPinnedPages] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(PINNED_PAGES_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [copiedLinkMsg, setCopiedLinkMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(TOOLBAR_CONFIG_KEY, JSON.stringify(toolbarItems));
    } catch {
      // ignore storage quota errors
    }
  }, [toolbarItems]);

  useEffect(() => {
    try {
      localStorage.setItem(PINNED_PAGES_KEY, JSON.stringify(pinnedPages));
    } catch {
      // ignore
    }
  }, [pinnedPages]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pageId = params.get('page');
    const nbId = s.panes[s.activePane]?.notebookId;
    if (pageId && nbId && getPages(nbId).some((p) => p.id === pageId)) {
      actions.setPage(s.activePane, pageId);
    }
  }, [s.activePane, s.panes]);

  useEffect(() => {
    if (!editorRef.current) return;
    return attachEditorSelectionGuard(editorRef.current, () => useApp.getState().tool.kind);
  }, []);

  useEffect(() => {
    if (editorRef.current) {
      clearWorkspaceStaleSelectionAndFocus(editorRef.current, s.tool.kind);
    }
  }, [s.tool.kind]);

  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 900);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? actions.redo() : actions.undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        actions.redo();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const showSplit = s.split && wide;
  const panesToShow = showSplit ? [0, 1] : [Math.min(s.activePane, s.panes.length - 1)];
  const cur = s.panes[s.activePane];
  const curNb = s.notebooks.find((n) => n.id === cur?.notebookId);
  const curPages = cur ? getPages(cur.notebookId) : [];
  const curPageIdx = curPages.findIndex((p) => p.id === cur?.pageId);
  const curPage = curPageIdx >= 0 ? curPages[curPageIdx] : undefined;

  const allCurrentImages = curPage ? getImages(curPage.id) : [];
  const selectedImage = selectedImageId ? allCurrentImages.find((im) => im.id === selectedImageId) ?? null : null;

  useEffect(() => {
    if (!selectedImage && croppingImageId) {
      setCroppingImageId(null);
      setDraftCrop(null);
    }
  }, [selectedImage, croppingImageId]);

  const openImagePicker = () => {
    pendingInsertPageIdRef.current = curPage?.id ?? curPages[0]?.id ?? null;
    imageInputRef.current?.click();
  };

  const decodeImageDimensions = async (imgFile: File): Promise<{ width: number; height: number }> => {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(imgFile);
        const dims = { width: bmp.width, height: bmp.height };
        bmp.close();
        if (dims.width > 0 && dims.height > 0) return dims;
      } catch {
        // fallback to HTMLImageElement
      }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(imgFile);
      const imgEl = new Image();
      imgEl.onload = () => {
        const width = imgEl.naturalWidth || imgEl.width;
        const height = imgEl.naturalHeight || imgEl.height;
        URL.revokeObjectURL(url);
        if (width > 0 && height > 0) resolve({ width, height });
        else reject(new Error('Image has invalid dimensions.'));
      };
      imgEl.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Selected file could not be decoded as an image.'));
      };
      imgEl.src = url;
    });
  };

  const handleInsertImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const capturedPageId = pendingInsertPageIdRef.current;
    pendingInsertPageIdRef.current = null;
    if (!file) return;

    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(file.name)) {
      alert('Please select a valid image file (PNG, JPEG, WebP, GIF, or SVG).');
      return;
    }

    setBusyMsg('Importing image…');
    const endJob = beginEssentialJob('image-import');
    try {
      const { width: naturalW, height: naturalH } = await decodeImageDimensions(file);
      const targetPage =
        (capturedPageId ? curPages.find((p) => p.id === capturedPageId) : undefined) ?? curPage ?? curPages[0];
      if (!targetPage) throw new Error('No active page to place image.');

      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      const sha256 = await sha256Hex(bytes);
      const assetId = 'img-' + crypto.randomUUID();
      const backend = await blobStore.put(assetId, bytes);

      await db.assets.put({
        id: assetId,
        kind: 'image',
        name: file.name,
        mimeType: file.type || 'image/png',
        size: file.size,
        sha256,
        backend,
        createdAt: Date.now(),
      });

      const aspectRatio = Math.max(0.05, naturalW / Math.max(1, naturalH));
      const pW = targetPage.width;
      const pH = targetPage.height;
      const padX = 36;
      const padY = 48;
      const maxW = Math.min(Math.max(120, pW - padX * 2), 420);
      const maxH = Math.min(Math.max(120, pH - padY * 2), pH * 0.55);
      let initW = maxW;
      let initH = initW / aspectRatio;
      if (initH > maxH) {
        initH = maxH;
        initW = initH * aspectRatio;
      }

      const x0 = Math.max(0, (pW - initW) / 2);
      const y0 = Math.max(24, Math.min(60, (pH - initH) / 2));
      const activeLayerId = getActiveLayer(targetPage.id) ?? targetPage.layerIds[0];

      const newImg: ImageBox = {
        kind: 'image',
        id: crypto.randomUUID(),
        pageId: targetPage.id,
        layerId: activeLayerId,
        assetId,
        bounds: { x0, y0, x1: x0 + initW, y1: y0 + initH },
        aspectRatio,
        naturalAspectRatio: aspectRatio,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        opacity: 1,
        order: Date.now(),
        revision: 1,
      };

      actions.commitImageEdit(targetPage.id, null, newImg);
      if (cur?.pageId !== targetPage.id) {
        actions.setPage(s.activePane, targetPage.id);
      }
      setSelectedImageId(newImg.id);
      setIsImageEditMode(true);
      setCroppingImageId(null);
      setDraftCrop(null);
    } catch (err) {
      alert(`Image import failed: ${(err as Error).message}`);
    } finally {
      endJob();
      setBusyMsg(null);
    }
  };

  const nudgeSelectedImage = (dx: number, dy: number) => {
    if (!selectedImage || !curPage) return;
    const w = selectedImage.bounds.x1 - selectedImage.bounds.x0;
    const h = selectedImage.bounds.y1 - selectedImage.bounds.y0;
    const nx0 = Math.max(0, Math.min(curPage.width - w, selectedImage.bounds.x0 + dx));
    const ny0 = Math.max(0, Math.min(curPage.height - h, selectedImage.bounds.y0 + dy));
    const next: ImageBox = {
      ...selectedImage,
      bounds: { x0: nx0, y0: ny0, x1: nx0 + w, y1: ny0 + h },
      revision: selectedImage.revision + 1,
    };
    actions.commitImageEdit(curPage.id, selectedImage, next);
  };

  const scaleSelectedImage = (factor: number) => {
    if (!selectedImage || !curPage) return;
    const curW = selectedImage.bounds.x1 - selectedImage.bounds.x0;
    const ar = selectedImage.aspectRatio || 1;
    let newW = Math.max(60, Math.min(curPage.width, curW * factor));
    let newH = newW / ar;
    if (newH > curPage.height) {
      newH = curPage.height;
      newW = newH * ar;
    }
    let x0 = selectedImage.bounds.x0;
    let y0 = selectedImage.bounds.y0;
    if (x0 + newW > curPage.width) x0 = Math.max(0, curPage.width - newW);
    if (y0 + newH > curPage.height) y0 = Math.max(0, curPage.height - newH);

    const next: ImageBox = {
      ...selectedImage,
      bounds: { x0, y0, x1: x0 + newW, y1: y0 + newH },
      revision: selectedImage.revision + 1,
    };
    actions.commitImageEdit(curPage.id, selectedImage, next);
  };

  const fitSelectedImageWidth = () => {
    if (!selectedImage || !curPage) return;
    const pad = 36;
    let newW = Math.max(100, curPage.width - pad * 2);
    const ar = selectedImage.aspectRatio || 1;
    let newH = newW / ar;
    if (newH > curPage.height - 72) {
      newH = curPage.height - 72;
      newW = newH * ar;
    }
    const x0 = Math.max(0, (curPage.width - newW) * 0.5);
    const y0 = Math.max(20, Math.min(curPage.height - newH - 20, selectedImage.bounds.y0));
    const next: ImageBox = {
      ...selectedImage,
      bounds: { x0, y0, x1: x0 + newW, y1: y0 + newH },
      revision: selectedImage.revision + 1,
    };
    actions.commitImageEdit(curPage.id, selectedImage, next);
  };

  const cycleSelectedImageOpacity = () => {
    if (!selectedImage || !curPage) return;
    const curOp = selectedImage.opacity ?? 1;
    const nextOp = curOp > 0.8 ? 0.65 : curOp > 0.5 ? 0.35 : 1;
    const next: ImageBox = {
      ...selectedImage,
      opacity: nextOp,
      revision: selectedImage.revision + 1,
    };
    actions.commitImageEdit(curPage.id, selectedImage, next);
  };

  const startCropSelectedImage = () => {
    if (!selectedImage) return;
    setDraftCrop(normalizeImageCrop(selectedImage.crop));
    setCroppingImageId(selectedImage.id);
  };

  const applyCropSelectedImage = () => {
    if (!selectedImage || !curPage) return;
    const full = getFullImageBounds(selectedImage);
    const nextCrop = normalizeImageCrop(draftCrop ?? selectedImage.crop);
    const nextBounds = getCropBoxBounds(full, nextCrop);
    const nextAr = Math.max(0.05, (nextBounds.x1 - nextBounds.x0) / Math.max(1, nextBounds.y1 - nextBounds.y0));
    const nextImg: ImageBox = {
      ...selectedImage,
      bounds: nextBounds,
      aspectRatio: nextAr,
      crop: isDefaultImageCrop(nextCrop) ? undefined : nextCrop,
      revision: selectedImage.revision + 1,
    };
    actions.commitImageEdit(curPage.id, selectedImage, nextImg);
    setCroppingImageId(null);
    setDraftCrop(null);
  };

  const resetCropSelectedImage = () => {
    setDraftCrop({ left: 0, top: 0, right: 0, bottom: 0 });
  };

  const cancelCropSelectedImage = () => {
    setCroppingImageId(null);
    setDraftCrop(null);
  };

  const finishImageEditing = () => {
    setCroppingImageId(null);
    setDraftCrop(null);
    setSelectedImageId(null);
    setIsImageEditMode(false);
  };

  const deleteSelectedImage = () => {
    if (!selectedImage || !curPage) return;
    actions.commitImageEdit(curPage.id, selectedImage, null);
    setCroppingImageId(null);
    setDraftCrop(null);
    setSelectedImageId(null);
  };

  const saveLabel = { idle: '', saving: 'Saving…', saved: 'Saved locally', failed: 'Save failed' }[s.save];
  const kind = s.tool.kind;

  /** Tap an active tool again to open its options; tap another to switch. */
  const pick = (k: ToolKind, popKey: Pop, defaultTab: StylePopoverTab = 'style') => {
    if (kind === k) {
      setStyleTab(defaultTab);
      setPop(pop === popKey ? null : popKey);
    } else {
      actions.setToolKind(k);
      setPop(null);
    }
  };

  const tbtn = (k: ToolKind, label: string, icon: React.ReactNode, popKey: Pop = null, tab: StylePopoverTab = 'style') => (
    <button
      className={`tool ${kind === k ? 'sel' : ''}`}
      aria-label={label}
      aria-pressed={kind === k}
      title={label}
      onClick={() => pick(k, popKey, tab)}
    >
      {icon}
    </button>
  );

  const T = s.tool;

  const resolveSharePages = (): Page[] => {
    if (!curPages.length) return [];
    if (sharePageScope === 'current') {
      return curPage ? [curPage] : [curPages[0]];
    }
    if (sharePageScope === 'range') {
      // Parse asynchronously loaded or sync helper; we keep simple inline parse here and also use parsePageRange in pdfManager
      const indices: number[] = [];
      const seen = new Set<number>();
      for (const part of shareRangeInput.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const m = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
        if (m) {
          const a = Math.max(1, Math.min(curPages.length, Number.parseInt(m[1], 10)));
          const b = Math.max(1, Math.min(curPages.length, Number.parseInt(m[2], 10)));
          for (let k = Math.min(a, b); k <= Math.max(a, b); k++) {
            if (!seen.has(k - 1)) { seen.add(k - 1); indices.push(k - 1); }
          }
        } else if (/^\d+$/.test(seg)) {
          const n = Number.parseInt(seg, 10);
          if (n >= 1 && n <= curPages.length && !seen.has(n - 1)) { seen.add(n - 1); indices.push(n - 1); }
        }
      }
      indices.sort((a, b) => a - b);
      return indices.length ? indices.map((i) => curPages[i]) : (curPage ? [curPage] : []);
    }
    return curPages;
  };

  const handleShareExportPdf = async () => {
    if (!curNb) return;
    const targetPages = resolveSharePages();
    if (!targetPages.length) {
      alert('Please select at least one valid page.');
      return;
    }
    setShowShareModal(false);
    setBusyMsg('Exporting vector PDF…');
    const endJob = beginEssentialJob('pdf-export');
    try {
      const [{ exportNotebookToPdfBytes }, { saveOrShareFileBytes }] = await Promise.all([
        loadPdfManager(),
        loadBackupManager(),
      ]);
      const bytes = await exportNotebookToPdfBytes(
        curNb,
        targetPages,
        (pid) => getStrokes(pid),
        (pid) => getTexts(pid),
        (pid) => getLayers(pid),
        (pid) => getImages(pid),
      );
      const suffix = targetPages.length === 1 && curPageIdx >= 0 ? `-page-${curPageIdx + 1}` : '';
      await saveOrShareFileBytes(bytes, `${curNb.title || 'Notebook'}${suffix}.pdf`, 'application/pdf');
    } catch (err) {
      alert(`PDF export failed: ${(err as Error).message}`);
    } finally {
      endJob();
      setBusyMsg(null);
    }
  };

  const handleShareExportJpg = async () => {
    if (!curNb || !curPage) return;
    setShowShareModal(false);
    setBusyMsg('Rendering JPG image…');
    const endJob = beginEssentialJob('jpg-export');
    try {
      const [{ exportPageToJpgBytes }, { saveOrShareFileBytes }] = await Promise.all([
        loadPdfManager(),
        loadBackupManager(),
      ]);
      const bytes = await exportPageToJpgBytes(
        curNb,
        curPage,
        getStrokes(curPage.id),
        getTexts(curPage.id),
        getLayers(curPage.id),
        getImages(curPage.id),
        2,
      );
      await saveOrShareFileBytes(
        bytes,
        `${curNb.title || 'Notebook'}-page-${curPageIdx + 1}.jpg`,
        'image/jpeg',
      );
    } catch (err) {
      alert(`JPG export failed: ${(err as Error).message}`);
    } finally {
      endJob();
      setBusyMsg(null);
    }
  };

  const handlePrintPages = async () => {
    if (!curNb) return;
    const targetPages = shareFormat === 'jpg' && curPage ? [curPage] : resolveSharePages();
    if (!targetPages.length) {
      alert('No pages selected to print.');
      return;
    }
    setShowShareModal(false);
    setBusyMsg('Preparing pages for print…');
    const endJob = beginEssentialJob('print-prepare');
    try {
      const { renderPageToCanvas } = await loadPdfManager();
      const urls: string[] = [];
      for (const pg of targetPages) {
        const canvas = await renderPageToCanvas(
          curNb,
          pg,
          getStrokes(pg.id),
          getTexts(pg.id),
          getLayers(pg.id),
          getImages(pg.id),
          2,
        );
        urls.push(canvas.toDataURL('image/png'));
      }
      setPrintPageUrls(urls);
      // Wait for React commit and image decoding before opening print preview
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const printImgs = Array.from(document.querySelectorAll<HTMLImageElement>('.print-only-container img'));
      await Promise.all(
        printImgs.map((img) =>
          img.complete
            ? img.decode?.().catch(() => undefined)
            : new Promise<void>((res) => {
                img.onload = () => res();
                img.onerror = () => res();
              }),
        ),
      );
      setBusyMsg(null);
      window.print();
    } catch (err) {
      alert(`Print preparation failed: ${(err as Error).message}`);
    } finally {
      endJob();
      setBusyMsg(null);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pop !== null || showCustomizeToolbar) {
        const restoreMore = pop === 'more' || showCustomizeToolbar;
        setPop(null);
        setShowCustomizeToolbar(false);
        if (restoreMore) {
          requestAnimationFrame(() => moreBtnRef.current?.focus());
        }
      } else if (showShareModal) {
        setShowShareModal(false);
      } else if (showFindModal) {
        setShowFindModal(false);
      } else if (showPageJumpModal) {
        setShowPageJumpModal(false);
      } else if (showResizeModal) {
        setShowResizeModal(false);
      } else if (showPaperModal) {
        setShowPaperModal(false);
      } else if (showGestureSettings) {
        setShowGestureSettings(false);
      } else if (showDocEditing) {
        setShowDocEditing(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    pop,
    showCustomizeToolbar,
    showShareModal,
    showFindModal,
    showPageJumpModal,
    showResizeModal,
    showPaperModal,
    showGestureSettings,
    showDocEditing,
  ]);

  const handleExportNotebookZip = async () => {
    if (!curNb) return;
    setPop(null);
    setBusyMsg('Creating backup (.tabletnotes.zip)…');
    try {
      const { buildBackupZipBytes, saveOrShareFileBytes } = await loadBackupManager();
      const bytes = await buildBackupZipBytes(curNb.id);
      await saveOrShareFileBytes(bytes, `${curNb.title || 'Notebook'}.tabletnotes.zip`, 'application/zip');
    } catch (err) {
      alert(`Backup failed: ${(err as Error).message}`);
    } finally {
      setBusyMsg(null);
    }
  };

  return (
    <div className="editor" ref={editorRef}>
      <header className="ed-head">
        <button className="icon blue" aria-label="Back to library" onClick={actions.closeEditor}>
          <ChevronLeft size={26} />
        </button>
        <div className="tabs" role="tablist">
          {s.tabs.map((id) => {
            const nb = s.notebooks.find((n) => n.id === id);
            const on = cur?.notebookId === id;
            return (
              <div key={id} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on}>
                <button className="tab-main" onClick={() => void actions.openNotebook(id)}>
                  {nb?.passwordLock && <Lock size={12} style={{ marginRight: 5, verticalAlign: '-1px' }} />}
                  {nb?.title ?? 'Untitled'}
                </button>
                <button className="icon xs" aria-label={`Close ${nb?.title}`} onClick={() => actions.closeTab(id)}>
                  <X size={14} />
                </button>
                {on && <ChevronDown size={14} aria-hidden />}
              </div>
            );
          })}
        </div>
        <span className={`save ${s.save}`} role="status">
          {busyMsg || saveLabel}
          {s.save === 'failed' && s.saveError ? `: ${s.saveError}` : ''}
        </span>
        {s.save === 'failed' && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className="chip"
              onClick={() => void actions.retryFailedSaves()}
              title="Retry saving unsaved notes to local storage"
            >
              Retry Save
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => void handleExportNotebookZip()}
              title="Download emergency backup (.tabletnotes.zip)"
            >
              Export Backup
            </button>
          </span>
        )}
        <button
          className={`icon blue ${s.pagesOpen ? 'on' : ''}`}
          aria-label="Pages and layers"
          aria-pressed={s.pagesOpen}
          onClick={() => useApp.setState({ pagesOpen: !s.pagesOpen })}
        >
          <List size={22} />
        </button>
        <button
          className={`icon blue ${showSplit ? 'on' : ''}`}
          aria-label="Split view"
          aria-pressed={showSplit}
          disabled={!wide}
          title={wide ? 'Split view' : 'Needs a wider screen'}
          onClick={actions.toggleSplit}
        >
          <Columns2 size={22} />
        </button>
        <button
          ref={moreBtnRef}
          className="icon blue"
          aria-label="More"
          aria-expanded={pop === 'more'}
          onClick={() => setPop(pop === 'more' ? null : 'more')}
        >
          <MoreHorizontal size={22} />
        </button>
      </header>

      {(pop !== null || showCustomizeToolbar) && (
        <div
          className="popover-scrim"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setPop(null);
            setShowCustomizeToolbar(false);
          }}
        />
      )}

      {pop === 'more' && (
        <div className="popover more-menu" role="menu">
          <div style={{ textAlign: 'center', fontWeight: 600, fontSize: 15, padding: '4px 0 8px' }}>
            More
          </div>
          <div className="more-menu-grid">
            <button
              type="button"
              className="more-shortcut"
              onClick={() => {
                setPop(null);
                setShowPaperModal(true);
              }}
            >
              <Grid size={18} />
              <span>Paper</span>
            </button>
            <button
              type="button"
              className="more-shortcut"
              onClick={() => {
                setPop(null);
                setShareFormat('pdf');
                setSharePageScope('all');
                setShareRangeInput(`1-${Math.max(1, curPages.length)}`);
                setShowShareModal(true);
              }}
            >
              <Share size={18} />
              <span>Share</span>
            </button>
            <button
              type="button"
              className="more-shortcut"
              onClick={() => {
                setPop(null);
                setShowFindModal(true);
              }}
            >
              <Search size={18} />
              <span>Find</span>
            </button>
            <button
              type="button"
              className="more-shortcut"
              onClick={() => {
                setPop(null);
                setJumpPageNum(String(curPageIdx + 1));
                setShowPageJumpModal(true);
              }}
            >
              <FilePlus2 size={18} />
              <span>1 - {curPages.length}</span>
            </button>
          </div>

          <div className="row" style={{ fontSize: 12, color: 'var(--muted)', paddingBottom: 2 }}>
            Page
          </div>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              if (!curPage) return;
              setPinnedPages((prev) => ({ ...prev, [curPage.id]: !prev[curPage.id] }));
              setPop(null);
            }}
          >
            {curPage && pinnedPages[curPage.id] ? <PinOff size={16} /> : <Pin size={16} />}
            <span>
              {curPage && pinnedPages[curPage.id] ? `Unpin Page ${curPageIdx + 1}` : `Pin Page ${curPageIdx + 1}`}
            </span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              setShowResizeModal(true);
            }}
          >
            <Maximize2 size={16} />
            <span>Expand &amp; Resize Page</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              if (!curPage || !curNb) return;
              const url = `${window.location.origin}${window.location.pathname}?nb=${encodeURIComponent(curNb.id)}&page=${encodeURIComponent(curPage.id)}`;
              void navigator.clipboard?.writeText(url);
              setCopiedLinkMsg('Copied local page link (works on this device only).');
              setTimeout(() => setCopiedLinkMsg(null), 3000);
              setPop(null);
            }}
          >
            <Link2 size={16} />
            <span>Copy Page Link</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              if (!curPage) return;
              if (!window.confirm(`Clear all ink on Page ${curPageIdx + 1}? You can undo this.`)) return;
              const strokes = getStrokes(curPage.id);
              if (strokes.length > 0) {
                actions.commitEdit('Clear Page', strokes, []);
              }
              setPop(null);
            }}
          >
            <Eraser size={16} />
            <span>Clear Page</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            disabled={curPages.length <= 1}
            onClick={() => {
              if (!curPage || curPages.length <= 1) return;
              if (!window.confirm(`Delete Page ${curPageIdx + 1}?`)) return;
              void actions.deletePage(s.activePane, curPage.id);
              setPop(null);
            }}
          >
            <Trash2 size={16} />
            <span>Delete Page</span>
          </button>

          <div className="row" style={{ fontSize: 12, color: 'var(--muted)', paddingTop: 6, paddingBottom: 2 }}>
            Settings
          </div>
          <label className="nav-row" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
            <span>Draw with Touch</span>
            <input
              type="checkbox"
              className="switch-pill"
              checked={T.fingerDrawing}
              onChange={(e) => actions.setTool({ fingerDrawing: e.target.checked })}
            />
          </label>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              setShowGestureSettings(true);
            }}
          >
            <Hand size={16} />
            <span>Gesture Settings</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              setShowDocEditing(true);
            }}
          >
            <Pen size={16} />
            <span>Document Editing</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              setShowCustomizeToolbar(true);
            }}
          >
            <Sliders size={16} />
            <span>Customize Toolbar</span>
          </button>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '6px 0' }} />

          <div className="row" style={{ fontSize: 12, color: 'var(--muted)', paddingBottom: 2 }}>
            Page View
          </div>
          <div className="seg tabs2" role="radiogroup" aria-label="Page View" style={{ margin: '0 8px 8px' }}>
            <button
              type="button"
              role="radio"
              aria-checked={s.pageViewMode === 'single'}
              className={s.pageViewMode === 'single' ? 'on' : ''}
              onClick={() => actions.setPageViewMode('single')}
            >
              Single Page
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={s.pageViewMode === 'continuous'}
              className={s.pageViewMode === 'continuous' ? 'on' : ''}
              onClick={() => actions.setPageViewMode('continuous')}
            >
              Continuous Scroll
            </button>
          </div>

          <div className="row" style={{ fontSize: 12, color: 'var(--muted)', paddingBottom: 2 }}>
            Ruler Units
          </div>
          <div className="seg tabs2" role="radiogroup" aria-label="Ruler Units" style={{ margin: '0 8px 8px' }}>
            <button
              type="button"
              role="radio"
              aria-checked={(T.rulerUnits ?? 'metric') === 'metric'}
              className={(T.rulerUnits ?? 'metric') === 'metric' ? 'on' : ''}
              onClick={() => actions.setTool({ rulerUnits: 'metric' })}
            >
              Metric (cm)
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={T.rulerUnits === 'imperial'}
              className={T.rulerUnits === 'imperial' ? 'on' : ''}
              onClick={() => actions.setTool({ rulerUnits: 'imperial' })}
            >
              Inches (in)
            </button>
          </div>

          <label className="nav-row" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
            <span>Performance panel</span>
            <input
              type="checkbox"
              checked={s.debug}
              onChange={(e) => useApp.setState({ debug: e.target.checked })}
            />
          </label>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '6px 0' }} />

          {curNb && (
            <>
              <div className="row" style={{ fontSize: 12, color: 'var(--muted)' }}>
                Notebook Password Protection
              </div>
              {!curNb.passwordLock ? (
                <button
                  role="menuitem"
                  className="nav-row"
                  onClick={() => {
                    setPop(null);
                    setPwModal({
                      mode: 'set',
                      targetKind: 'notebook',
                      targetId: curNb.id,
                      targetName: curNb.title,
                    });
                  }}
                >
                  <Lock size={16} /> <span>Set Password</span>
                </button>
              ) : (
                <>
                  <button
                    role="menuitem"
                    className="nav-row"
                    onClick={() => {
                      setPop(null);
                      void actions.lockNotebookNow(curNb.id);
                    }}
                  >
                    <Lock size={16} /> <span>Lock Now</span>
                  </button>
                  <button
                    role="menuitem"
                    className="nav-row"
                    onClick={() => {
                      setPop(null);
                      setPwModal({
                        mode: 'change',
                        targetKind: 'notebook',
                        targetId: curNb.id,
                        targetName: curNb.title,
                      });
                    }}
                  >
                    <KeyRound size={16} /> <span>Change Password</span>
                  </button>
                  <button
                    role="menuitem"
                    className="nav-row"
                    onClick={() => {
                      setPop(null);
                      setPwModal({
                        mode: 'remove',
                        targetKind: 'notebook',
                        targetId: curNb.id,
                        targetName: curNb.title,
                      });
                    }}
                  >
                    <LockOpen size={16} /> <span>Remove Password</span>
                  </button>
                </>
              )}
            </>
          )}

          {curPage && (
            <>
              <div className="row" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                Page {curPageIdx + 1} Password Protection
              </div>
              {!curPage.passwordLock ? (
                <button
                  role="menuitem"
                  className="nav-row"
                  onClick={() => {
                    setPop(null);
                    setPwModal({
                      mode: 'set',
                      targetKind: 'page',
                      targetId: curPage.id,
                      targetName: `Page ${curPageIdx + 1}`,
                    });
                  }}
                >
                  <Lock size={16} /> <span>Set Page Password</span>
                </button>
              ) : (
                <>
                  {isDocumentUnlockedInSession(curPage.id) && (
                    <button
                      role="menuitem"
                      className="nav-row"
                      onClick={() => {
                        setPop(null);
                        void actions.lockPageNow(curPage.id);
                      }}
                    >
                      <Lock size={16} /> <span>Lock Page Now</span>
                    </button>
                  )}
                  <button
                    role="menuitem"
                    className="nav-row"
                    onClick={() => {
                      setPop(null);
                      setPwModal({
                        mode: 'change',
                        targetKind: 'page',
                        targetId: curPage.id,
                        targetName: `Page ${curPageIdx + 1}`,
                      });
                    }}
                  >
                    <KeyRound size={16} /> <span>Change Page Password</span>
                  </button>
                  <button
                    role="menuitem"
                    className="nav-row"
                    onClick={() => {
                      setPop(null);
                      setPwModal({
                        mode: 'remove',
                        targetKind: 'page',
                        targetId: curPage.id,
                        targetName: `Page ${curPageIdx + 1}`,
                      });
                    }}
                  >
                    <LockOpen size={16} /> <span>Remove Page Password</span>
                  </button>
                </>
              )}
            </>
          )}

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '6px 0' }} />

          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              openImagePicker();
            }}
          >
            <ImageIcon size={16} /> <span>Add Image</span>
          </button>
          <button role="menuitem" className="nav-row" onClick={() => {
            setPop(null);
            setShareFormat('pdf');
            setSharePageScope('all');
            setShareRangeInput(`1-${Math.max(1, curPages.length)}`);
            setShowShareModal(true);
          }}>
            <FileDown size={16} /> <span>Share / Print (PDF &amp; JPG)</span>
          </button>
          <button role="menuitem" className="nav-row" onClick={() => void handleExportNotebookZip()}>
            <Download size={16} /> <span>Export Backup (.tabletnotes.zip)</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              setBusyMsg('Downloading offline handwriting model…');
              installLocalHandwritingPack((msg) => setBusyMsg(msg))
                .then(() => setBusyMsg('Offline handwriting pack ready'))
                .catch((e) => setBusyMsg(`Offline pack: ${(e as Error).message}`));
            }}
          >
            <Sparkles size={16} /> <span>Install Offline Handwriting Pack</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              setShowDiagnostics(true);
            }}
          >
            <Activity size={16} /> <span>Stylus Diagnostics Board</span>
          </button>
          <button
            role="menuitem"
            className="nav-row"
            onClick={() => {
              setPop(null);
              actions.openWelcome('how-it-works');
            }}
          >
            <HelpCircle size={16} /> <span>How It Works & About Us</span>
          </button>
        </div>
      )}

      <div className="ed-body">
        <aside className="rail" aria-label="Tools">
          <button
            className="tool"
            aria-label="Pages and layers"
            aria-pressed={s.pagesOpen}
            onClick={() => useApp.setState({ pagesOpen: !s.pagesOpen })}
          >
            <LayoutGrid size={22} />
          </button>
          {toolbarItems
            .filter((item) => item.visible)
            .map((item) => {
              switch (item.id) {
                case 'pen':
                  return <Fragment key="pen">{tbtn('pen', 'Pen', <Pen size={22} />, 'style', 'style')}</Fragment>;
                case 'highlighter':
                  return (
                    <Fragment key="highlighter">
                      {tbtn('highlighter', 'Highlighter', <Highlighter size={22} />, 'style', 'style')}
                    </Fragment>
                  );
                case 'eraser':
                  return <Fragment key="eraser">{tbtn('eraser', 'Eraser', <Eraser size={22} />, 'eraser')}</Fragment>;
                case 'lasso':
                  return <Fragment key="lasso">{tbtn('lasso', 'Lasso', <Lasso size={22} />)}</Fragment>;
                case 'hand':
                  return <Fragment key="hand">{tbtn('hand', 'Hand', <Hand size={22} />)}</Fragment>;
                case 'laser':
                  return <Fragment key="laser">{tbtn('laser', 'Laser Pointer', <Sparkles size={22} />)}</Fragment>;
                case 'text':
                  return <Fragment key="text">{tbtn('text', 'Text box & Scribble', <Type size={22} />)}</Fragment>;
                case 'shape':
                  return <Fragment key="shape">{tbtn('shape', 'Shapes', <Shapes size={22} />, 'shape')}</Fragment>;
                case 'page':
                  return (
                    <button
                      key="page"
                      className="tool"
                      aria-label="Add page"
                      title="Add page"
                      onClick={() => void actions.addPage(s.activePane)}
                    >
                      <FilePlus2 size={22} />
                    </button>
                  );
                case 'image':
                  return (
                    <button
                      key="image"
                      className="tool"
                      aria-label="Add Image"
                      title="Add Image from Gallery"
                      onClick={openImagePicker}
                    >
                      <ImageIcon size={22} />
                    </button>
                  );
                default:
                  return null;
              }
            })}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleInsertImageFile}
          />
          {(allCurrentImages.length > 0 || isImageEditMode) && (
            <button
              className={`tool ${isImageEditMode ? 'sel' : ''}`}
              aria-label="Edit Images"
              aria-pressed={isImageEditMode}
              title={isImageEditMode ? 'Done editing images' : 'Select, move, resize, or crop images'}
              onClick={() => {
                if (isImageEditMode) {
                  finishImageEditing();
                } else {
                  setIsImageEditMode(true);
                }
              }}
            >
              <Crop size={20} />
            </button>
          )}
          <button
            className={`tool ${T.penOnly ? 'sel' : ''}`}
            aria-label="Pen only: reject finger ink"
            aria-pressed={T.penOnly}
            title="Pen only"
            onClick={() => actions.setTool({ penOnly: !T.penOnly, fingerDrawing: T.penOnly })}
          >
            <Fingerprint size={22} />
          </button>
          <div className="spacer" />
          <button className="tool" aria-label="Undo" disabled={!s.canUndo} onClick={actions.undo}>
            <Undo2 size={22} />
          </button>
          <button className="tool" aria-label="Redo" disabled={!s.canRedo} onClick={actions.redo}>
            <Redo2 size={22} />
          </button>
          {s.presets.map((p, i) => {
            const isSelected = s.activePreset === i && (kind === 'pen' || kind === 'highlighter');
            return (
              <button
                key={i}
                className={`preset ${isSelected ? 'sel' : ''}`}
                style={{ background: p.color }}
                aria-label={`Preset ${p.widthMm} mm ${p.color}`}
                aria-pressed={s.activePreset === i}
                onClick={() => {
                  if (s.activePreset === i) {
                    setStyleTab('style');
                    setPop(pop === 'style' ? null : 'style');
                  } else {
                    actions.selectPreset(i);
                  }
                }}
              >
                <span>{p.widthMm.toFixed(2).replace(/^0/, '')}</span>
              </button>
            );
          })}
        </aside>

        {s.pagesOpen && cur && (
          <aside className="pages-panel" aria-label="Pages and layers">
            <div className="seg tabs2" role="tablist">
              <button
                role="tab"
                aria-selected={panelTab === 'pages'}
                className={panelTab === 'pages' ? 'on' : ''}
                onClick={() => setPanelTab('pages')}
              >
                Pages
              </button>
              <button
                role="tab"
                aria-selected={panelTab === 'layers'}
                className={panelTab === 'layers' ? 'on' : ''}
                onClick={() => setPanelTab('layers')}
              >
                <Layers size={14} /> Layers
              </button>
            </div>
            {panelTab === 'pages' ? (
              <>
                {getPages(cur.notebookId).map((p, i, arr) => (
                  <div key={p.id} className={`thumb ${cur.pageId === p.id ? 'sel' : ''}`}>
                    <button className="thumb-main" onClick={() => actions.setPage(s.activePane, p.id)}>
                      {p.passwordLock && <Lock size={12} style={{ marginRight: 4 }} />}
                      Page {i + 1}
                    </button>
                    <div className="layer-ctl">
                      <button
                        className="icon xs"
                        aria-label="Move page up"
                        disabled={i === 0}
                        onClick={() => void actions.movePage(s.activePane, p.id, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon xs"
                        aria-label="Move page down"
                        disabled={i === arr.length - 1}
                        onClick={() => void actions.movePage(s.activePane, p.id, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        className="icon xs"
                        aria-label="Add page below"
                        title="Add page below"
                        onClick={() => void actions.addPageAfter(s.activePane, p.id)}
                      >
                        <Plus size={14} />
                      </button>
                      <button
                        className="icon xs"
                        aria-label="Duplicate page"
                        onClick={() => void actions.duplicatePage(s.activePane, p.id)}
                      >
                        <CopyPlus size={14} />
                      </button>
                      <button
                        className="icon xs"
                        aria-label="Delete page"
                        disabled={arr.length <= 1}
                        onClick={() => void actions.deletePage(s.activePane, p.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                <button className="thumb add" onClick={() => void actions.addPage(s.activePane)}>
                  <Plus size={16} /> Add page
                </button>
              </>
            ) : (
              <LayersPanel pageId={cur.pageId} />
            )}
          </aside>
        )}

        <div className={`panes ${showSplit ? 'two' : ''}`}>
          {s.panes.map((_, i) => (
            <div key={i} className="pane-wrap" style={{ display: panesToShow.includes(i) ? 'flex' : 'none' }}>
              <Pane
                index={i}
                selectedImageId={selectedImageId}
                onSelectImage={(id) => {
                  setSelectedImageId(id);
                  if (!id) {
                    setCroppingImageId(null);
                    setDraftCrop(null);
                  } else {
                    setIsImageEditMode(true);
                  }
                }}
                isImageEditMode={isImageEditMode}
                croppingImageId={croppingImageId}
                draftCrop={draftCrop}
                onDraftCropChange={setDraftCrop}
                onRequestUnlockPage={(pg) =>
                  setPwModal({
                    mode: 'unlock',
                    targetKind: 'page',
                    targetId: pg.id,
                    targetName: `Page ${curPages.findIndex((x) => x.id === pg.id) + 1}`,
                  })
                }
              />
            </div>
          ))}
        </div>

        {(pop === 'style' || pop === 'wheel') && (
          <StyleColorPopover initialTab={styleTab} onClose={() => setPop(null)} />
        )}

        {pop === 'eraser' && (
          <div className="popover pen-pop" role="dialog" aria-label="Eraser settings">
            <div className="row">
              <strong>Eraser</strong>
              <button className="icon sm" aria-label="Close" onClick={() => setPop(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="seg" role="radiogroup" aria-label="Eraser mode">
              <button
                role="radio"
                aria-checked={T.eraserMode === 'pixel'}
                className={T.eraserMode === 'pixel' ? 'on' : ''}
                onClick={() => actions.setTool({ eraserMode: 'pixel' })}
              >
                Pixel
              </button>
              <button
                role="radio"
                aria-checked={T.eraserMode === 'stroke'}
                className={T.eraserMode === 'stroke' ? 'on' : ''}
                onClick={() => actions.setTool({ eraserMode: 'stroke' })}
              >
                Whole stroke
              </button>
            </div>
            <label className="row">
              Size {Math.round(T.eraserRadius)} pt
              <input
                type="range"
                min="3"
                max="40"
                step="1"
                value={T.eraserRadius}
                onChange={(e) => actions.setTool({ eraserRadius: +e.target.value })}
              />
            </label>
            <p className="note">Erases only unlocked, visible layers.</p>
          </div>
        )}

        {pop === 'shape' && (
          <div className="popover pen-pop" role="dialog" aria-label="Shape settings">
            <div className="row">
              <strong>Shapes</strong>
              <button className="icon sm" aria-label="Close" onClick={() => setPop(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="seg" role="radiogroup" aria-label="Shape">
              {(['line', 'rect', 'ellipse'] as ShapeKind[]).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={T.shape === k}
                  className={T.shape === k ? 'on' : ''}
                  onClick={() => actions.setTool({ shape: k })}
                >
                  {k === 'rect' ? 'Rectangle' : k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
            <p className="note">Uses the active pen colour and width. Hold Shift for square/circle.</p>
          </div>
        )}
      </div>

      {pwModal && (
        <PasswordModal
          mode={pwModal.mode}
          targetName={pwModal.targetName}
          targetKind={pwModal.targetKind}
          onClose={() => setPwModal(null)}
          onSubmit={async ({ currentPassword, newPassword }) => {
            if (pwModal.targetKind === 'notebook') {
              if (pwModal.mode === 'set' && newPassword) {
                await actions.setNotebookPassword(pwModal.targetId, newPassword);
              } else if (pwModal.mode === 'change' && currentPassword && newPassword) {
                await actions.changeNotebookPassword(pwModal.targetId, currentPassword, newPassword);
              } else if (pwModal.mode === 'remove' && currentPassword) {
                await actions.removeNotebookPasswordAction(pwModal.targetId, currentPassword);
              }
            } else {
              if (pwModal.mode === 'set' && newPassword) {
                await actions.setPagePassword(pwModal.targetId, newPassword);
              } else if (pwModal.mode === 'unlock' && currentPassword) {
                await actions.unlockPageAction(pwModal.targetId, currentPassword);
              } else if (pwModal.mode === 'change' && currentPassword && newPassword) {
                await actions.changePagePassword(pwModal.targetId, currentPassword, newPassword);
              } else if (pwModal.mode === 'remove' && currentPassword) {
                await actions.removePagePasswordAction(pwModal.targetId, currentPassword);
              }
            }
          }}
        />
      )}

      {selectedImage && croppingImageId === selectedImage.id && (
        <div
          className="sel-menu image-toolbar"
          role="toolbar"
          aria-label="Crop image actions"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40,
            maxWidth: 'calc(100vw - 24px)',
            flexWrap: 'wrap',
            background: 'rgba(28, 28, 30, 0.94)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Crop size={15} /> Drag handles to crop
          </span>
          <button className="chip" aria-label="Reset crop" onClick={resetCropSelectedImage} title="Restore full image">
            <RotateCcw size={14} /> Reset
          </button>
          <button className="chip" aria-label="Cancel crop" onClick={cancelCropSelectedImage} title="Cancel crop">
            <X size={14} /> Cancel
          </button>
          <button className="nn-create" aria-label="Apply crop" onClick={applyCropSelectedImage} title="Apply crop">
            <Check size={15} /> Apply
          </button>
        </div>
      )}

      {selectedImage && croppingImageId !== selectedImage.id && (
        <div
          className="sel-menu image-toolbar"
          role="toolbar"
          aria-label="Image actions"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40,
            maxWidth: 'calc(100vw - 24px)',
            flexWrap: 'wrap',
            background: 'rgba(28, 28, 30, 0.94)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              marginRight: 4,
            }}
          >
            <ImageIcon size={15} /> Photo
          </span>
          <button
            className="chip"
            aria-label="Crop image"
            title="Crop image"
            onClick={startCropSelectedImage}
          >
            <Crop size={14} /> Crop
          </button>
          <span style={{ width: 1, height: 16, background: 'var(--line)' }} />
          <div style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }} title="Nudge position">
            <button className="icon xs" aria-label="Nudge left" onClick={() => nudgeSelectedImage(-20, 0)}>
              <ArrowLeft size={14} />
            </button>
            <button className="icon xs" aria-label="Nudge right" onClick={() => nudgeSelectedImage(20, 0)}>
              <ArrowRight size={14} />
            </button>
            <button className="icon xs" aria-label="Nudge up" onClick={() => nudgeSelectedImage(0, -20)}>
              <ArrowUp size={14} />
            </button>
            <button className="icon xs" aria-label="Nudge down" onClick={() => nudgeSelectedImage(0, 20)}>
              <ArrowDown size={14} />
            </button>
          </div>
          <span style={{ width: 1, height: 16, background: 'var(--line)' }} />
          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <button className="chip" aria-label="Shrink 10%" onClick={() => scaleSelectedImage(0.9)} title="Shrink image">
              − 10%
            </button>
            <button className="chip" aria-label="Enlarge 10%" onClick={() => scaleSelectedImage(1.1)} title="Enlarge image">
              + 10%
            </button>
            <button className="chip" aria-label="Fit Page Width" onClick={() => fitSelectedImageWidth()} title="Fit Page Width">
              Fit Width
            </button>
          </div>
          <span style={{ width: 1, height: 16, background: 'var(--line)' }} />
          <button
            className="chip"
            onClick={() => cycleSelectedImageOpacity()}
            title="Toggle opacity (100% / 65% / 35%) for tracing over diagrams"
          >
            Opacity {Math.round((selectedImage.opacity ?? 1) * 100)}%
          </button>
          <span style={{ width: 1, height: 16, background: 'var(--line)' }} />
          <button
            className="icon xs"
            style={{ color: '#FF453A' }}
            aria-label="Delete image"
            title="Delete image"
            onClick={() => deleteSelectedImage()}
          >
            <Trash2 size={16} />
          </button>
          <button
            className="nn-create"
            aria-label="Done editing image"
            title="Done"
            onClick={finishImageEditing}
          >
            <Check size={15} /> Done
          </button>
        </div>
      )}

      {!selectedImage && isImageEditMode && (
        <div
          className="sel-menu image-toolbar"
          role="toolbar"
          aria-label="Image editing mode"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40,
            maxWidth: 'calc(100vw - 24px)',
            flexWrap: 'wrap',
            background: 'rgba(28, 28, 30, 0.94)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <ImageIcon size={15} /> Tap a photo to select
          </span>
          <button className="chip" aria-label="Add another image" onClick={openImagePicker}>
            <Plus size={14} /> Add Image
          </button>
          <button className="nn-create" aria-label="Done image editing" onClick={finishImageEditing}>
            <Check size={15} /> Done
          </button>
        </div>
      )}

      {showDiagnostics && (
        <WritingDiagnosticsModal onClose={() => setShowDiagnostics(false)} />
      )}

      {showCustomizeToolbar && (
        <div className="customize-toolbar-panel" role="dialog" aria-label="Customize Toolbar">
          <div className="customize-toolbar-head">
            <button
              type="button"
              className="chip"
              onClick={() => setToolbarItems(DEFAULT_TOOLBAR_ITEMS)}
            >
              Reset
            </button>
            <strong style={{ fontSize: 15 }}>Customize</strong>
            <button
              type="button"
              className="icon blue"
              aria-label="Done customizing toolbar"
              onClick={() => setShowCustomizeToolbar(false)}
            >
              <Check size={18} />
            </button>
          </div>
          <div className="customize-toolbar-list">
            {toolbarItems.map((item, idx) => (
              <div key={item.id} className="customize-toolbar-row">
                <span style={{ flex: 1, fontSize: 13 }}>{item.label}</span>
                <input
                  type="checkbox"
                  className="switch-pill"
                  aria-label={`Toggle ${item.label}`}
                  checked={item.visible}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setToolbarItems((prev) =>
                      prev.map((t) => (t.id === item.id ? { ...t, visible: checked } : t)),
                    );
                  }}
                />
                <button
                  type="button"
                  className="icon xs"
                  aria-label={`Move ${item.label} up`}
                  disabled={idx === 0}
                  onClick={() => {
                    setToolbarItems((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(idx, 1);
                      next.splice(idx - 1, 0, moved);
                      return next;
                    });
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon xs"
                  aria-label={`Move ${item.label} down`}
                  disabled={idx === toolbarItems.length - 1}
                  onClick={() => {
                    setToolbarItems((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(idx, 1);
                      next.splice(idx + 1, 0, moved);
                      return next;
                    });
                  }}
                >
                  ↓
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showShareModal && curNb && (
        <div className="modal-scrim" onClick={() => setShowShareModal(false)}>
          <div className="nn-dialog" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Share &amp; Print</h2>
              <button
                type="button"
                className="nn-close"
                aria-label="Close Share"
                onClick={() => setShowShareModal(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="seg tabs2" role="tablist" aria-label="Export format" style={{ marginBottom: 14 }}>
              <button
                type="button"
                role="tab"
                aria-selected={shareFormat === 'pdf'}
                className={shareFormat === 'pdf' ? 'on' : ''}
                onClick={() => setShareFormat('pdf')}
              >
                PDF
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={shareFormat === 'jpg'}
                className={shareFormat === 'jpg' ? 'on' : ''}
                onClick={() => setShareFormat('jpg')}
              >
                JPG
              </button>
            </div>

            {shareFormat === 'pdf' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>Pages to include ({curPages.length} total):</div>
                <label className="row" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="share-scope"
                    checked={sharePageScope === 'current'}
                    onChange={() => setSharePageScope('current')}
                  />
                  <span>Current page (Page {curPageIdx + 1})</span>
                </label>
                <label className="row" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="share-scope"
                    checked={sharePageScope === 'all'}
                    onChange={() => setSharePageScope('all')}
                  />
                  <span>All pages (1 – {curPages.length})</span>
                </label>
                <label className="row" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="share-scope"
                    checked={sharePageScope === 'range'}
                    onChange={() => setSharePageScope('range')}
                  />
                  <span>Page range</span>
                  {sharePageScope === 'range' && (
                    <input
                      type="text"
                      className="nn-input"
                      aria-label="Page range"
                      placeholder={`e.g. 1-${curPages.length}`}
                      value={shareRangeInput}
                      onChange={(e) => setShareRangeInput(e.target.value)}
                      style={{ flex: 1, minHeight: 34, marginLeft: 8 }}
                    />
                  )}
                </label>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button type="button" className="chip" onClick={() => void handlePrintPages()} style={{ gap: 6 }}>
                    <Printer size={15} /> <span>Print</span>
                  </button>
                  <button type="button" className="nn-create" onClick={() => void handleShareExportPdf()}>
                    <Share size={15} /> <span>Share / Save PDF</span>
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                  Exports the current page (Page {curPageIdx + 1}) as a high-resolution JPG image
                  {curPage ? ` (${Math.round(curPage.width * 2)} × ${Math.round(curPage.height * 2)} px)` : ''},
                  preserving aspect ratio independently of zoom and scroll.
                </p>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="nn-create" onClick={() => void handleShareExportJpg()}>
                    <Share size={15} /> <span>Share / Save JPG</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showFindModal && (
        <div className="modal-scrim" onClick={() => setShowFindModal(false)}>
          <div className="nn-dialog" style={{ width: 'min(380px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Find in Notebook</h2>
              <button type="button" className="nn-close" aria-label="Close Find" onClick={() => setShowFindModal(false)}>
                <X size={16} />
              </button>
            </div>
            <input
              type="text"
              className="nn-input"
              style={{ width: '100%' }}
              placeholder="Search text items..."
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              autoFocus
            />
            <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 10 }}>
              {findQuery.trim()
                ? curPages
                    .map((p, idx) => {
                      const hit = getTexts(p.id).find((it) =>
                        it.text.toLowerCase().includes(findQuery.toLowerCase()),
                      );
                      return hit ? { page: p, idx } : null;
                    })
                    .filter((x): x is { page: (typeof curPages)[number]; idx: number } => Boolean(x))
                    .map(({ page, idx }) => (
                      <button
                        key={page.id}
                        type="button"
                        className="nav-row"
                        onClick={() => {
                          actions.setPage(s.activePane, page.id);
                          setShowFindModal(false);
                        }}
                      >
                        <span>Page {idx + 1}</span>
                      </button>
                    ))
                : null}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="chip" onClick={() => setShowFindModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showPageJumpModal && (
        <div className="modal-scrim" onClick={() => setShowPageJumpModal(false)}>
          <div className="nn-dialog" style={{ width: 'min(320px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Go to Page (1 - {curPages.length})</h2>
              <button type="button" className="nn-close" aria-label="Close Page Jump" onClick={() => setShowPageJumpModal(false)}>
                <X size={16} />
              </button>
            </div>
            <input
              type="number"
              className="nn-input"
              style={{ width: '100%' }}
              min={1}
              max={curPages.length}
              value={jumpPageNum}
              onChange={(e) => setJumpPageNum(e.target.value)}
              autoFocus
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
              <button type="button" className="chip" onClick={() => setShowPageJumpModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="nn-create"
                onClick={() => {
                  const n = Number.parseInt(jumpPageNum, 10);
                  if (Number.isFinite(n) && n >= 1 && n <= curPages.length) {
                    actions.setPage(s.activePane, curPages[n - 1].id);
                  }
                  setShowPageJumpModal(false);
                }}
              >
                Go
              </button>
            </div>
          </div>
        </div>
      )}

      {showResizeModal && curPage && (
        <div className="modal-scrim" onClick={() => setShowResizeModal(false)}>
          <div className="nn-dialog" style={{ width: 'min(380px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Expand &amp; Resize Page</h2>
              <button type="button" className="nn-close" aria-label="Close Resize" onClick={() => setShowResizeModal(false)}>
                <X size={16} />
              </button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
              Current page size: {curPage.width} × {curPage.height} px. Expanding preserves all existing ink and items in place; shrinking below existing strokes may clip content outside the new bounds.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="chip" onClick={() => setShowResizeModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaperModal && curPage && curNb && (
        <div className="modal-scrim" onClick={() => setShowPaperModal(false)}>
          <div className="nn-dialog" style={{ width: 'min(360px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Paper Template &amp; Color</h2>
              <button type="button" className="nn-close" aria-label="Close Paper" onClick={() => setShowPaperModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Template</div>
            <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
              {(['blank', 'ruled', 'grid', 'dotted'] as const).map((tpl) => (
                <button
                  key={tpl}
                  type="button"
                  className={`nav-row ${curNb.template === tpl ? 'active' : ''}`}
                  onClick={() => {
                    void actions.patchNotebook(curNb.id, { template: tpl });
                    setShowPaperModal(false);
                  }}
                >
                  <span style={{ textTransform: 'capitalize' }}>{tpl}</span>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Paper Colour</div>
            <div className="swatches" style={{ padding: '4px 0' }}>
              {PAPER_COLORS.map((c) => (
                <button
                  key={c}
                  className={`sw ${s.paper.toLowerCase() === c.toLowerCase() ? 'sel' : ''}`}
                  style={{ background: c }}
                  aria-label={`Paper ${c}`}
                  aria-pressed={s.paper.toLowerCase() === c.toLowerCase()}
                  onClick={() => actions.setPaper(c)}
                />
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="chip" onClick={() => setShowPaperModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showGestureSettings && (
        <div className="modal-scrim" onClick={() => setShowGestureSettings(false)}>
          <div className="nn-dialog" style={{ width: 'min(360px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Gesture Settings</h2>
              <button type="button" className="nn-close" aria-label="Close Gesture Settings" onClick={() => setShowGestureSettings(false)}>
                <X size={16} />
              </button>
            </div>
            <label className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
              <span>Draw with Touch</span>
              <input
                type="checkbox"
                className="switch-pill"
                checked={T.fingerDrawing}
                onChange={(e) => actions.setTool({ fingerDrawing: e.target.checked })}
              />
            </label>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="chip" onClick={() => setShowGestureSettings(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showDocEditing && (
        <div className="modal-scrim" onClick={() => setShowDocEditing(false)}>
          <div className="nn-dialog" style={{ width: 'min(360px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="nn-head">
              <h2>Document Editing</h2>
              <button type="button" className="nn-close" aria-label="Close Document Editing" onClick={() => setShowDocEditing(false)}>
                <X size={16} />
              </button>
            </div>
            <label className="row" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={T.scribbleErase}
                onChange={(e) => actions.setTool({ scribbleErase: e.target.checked })}
              />{' '}
              Scribble to erase
            </label>
            <label className="row" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={T.shapeSnap}
                onChange={(e) => actions.setTool({ shapeSnap: e.target.checked })}
              />{' '}
              Draw &amp; hold shape snap
            </label>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="chip" onClick={() => setShowDocEditing(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="print-only-container" aria-hidden="true">
        {printPageUrls.map((url, idx) => (
          <div key={idx} className="print-page">
            <img src={url} alt={`Notebook page ${idx + 1}`} />
          </div>
        ))}
      </div>

      {copiedLinkMsg && (
        <div
          role="status"
          style={{
            position: 'fixed',
            bottom: 64,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(28, 28, 30, 0.94)',
            color: '#f5f5f7',
            padding: '8px 14px',
            borderRadius: 999,
            fontSize: 12,
            zIndex: 300,
          }}
        >
          {copiedLinkMsg}
        </div>
      )}
    </div>
  );
}
