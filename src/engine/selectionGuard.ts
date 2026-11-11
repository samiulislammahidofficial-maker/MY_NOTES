import type { ToolKind } from './tools';

export interface SelectionDiagnosticEvent {
  timestamp: number;
  eventType: 'selectstart' | 'contextmenu' | 'selectionchange' | 'mode-transition';
  toolKind: ToolKind;
  pointerType: string;
  targetTag: string;
  targetClass: string;
  targetRole: string | null;
  activeElementTag: string;
  activeElementEditable: boolean;
  selectionAnchorChain: string;
  computedUserSelect: string;
  computedWebkitUserSelect: string;
  canceled: boolean;
}

const MAX_DIAG_LOG = 50;
const devDiagnosticLog: SelectionDiagnosticEvent[] = [];

export function getSelectionDiagnosticLog(): SelectionDiagnosticEvent[] {
  return [...devDiagnosticLog];
}

export function clearSelectionDiagnosticLog(): void {
  devDiagnosticLog.length = 0;
}

/**
 * Returns true if the given ToolKind is a drawing/canvas manipulation mode where
 * accidental DOM text selection / iOS callout menus must be suppressed.
 */
export function isDrawingOrManipulationTool(kind: ToolKind): boolean {
  return (
    kind === 'pen' ||
    kind === 'highlighter' ||
    kind === 'eraser' ||
    kind === 'shape' ||
    kind === 'lasso' ||
    kind === 'hand' ||
    kind === 'laser'
  );
}

/**
 * Returns true if the target node is inside an explicitly allowed text-interaction region
 * (e.g., `<input>`, `<textarea>`, `[contenteditable="true"]`, `[data-allow-text-selection="true"]`,
 * or inside `.modal-scrim` / `.nn-dialog`).
 */
export function isAllowedTextSelectionTarget(node: Node | null): boolean {
  if (!node) return false;
  const el =
    node.nodeType === 1
      ? (node as HTMLElement)
      : (node.parentElement as HTMLElement | null);
  if (!el) return false;

  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // However, range inputs or checkboxes inside the rail/popovers should not trigger text selection
    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type?.toLowerCase();
      if (type === 'range' || type === 'checkbox' || type === 'radio' || type === 'button' || type === 'file') {
        return false;
      }
    }
    return true;
  }

  if (el.isContentEditable) return true;

  if (typeof el.closest === 'function') {
    if (
      el.closest(
        'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [data-allow-text-selection="true"], .modal-scrim, .nn-dialog',
      )
    ) {
      return true;
    }
  }

  return false;
}

function describeNodeChain(node: Node | null): string {
  if (!node) return 'none';
  const parts: string[] = [];
  let cur: HTMLElement | null =
    node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  let depth = 0;
  while (cur && depth < 5) {
    const tag = cur.tagName.toLowerCase();
    const cls =
      typeof cur.className === 'string' && cur.className.trim()
        ? `.${cur.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    parts.push(`${tag}${cls}`);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' <- ') || 'unknown';
}

function recordDiagnostic(
  eventType: SelectionDiagnosticEvent['eventType'],
  toolKind: ToolKind,
  target: Node | null,
  canceled: boolean,
  pointerType = 'unknown',
): void {
  // Never log private note text or password contents; record only DOM tag/class/role metadata in dev/debug mode.
  const isDev =
    (typeof import.meta !== 'undefined' && Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)) ||
    (typeof window !== 'undefined' && Boolean((window as unknown as { __MYNOTES_DEBUG_SELECTION__?: boolean }).__MYNOTES_DEBUG_SELECTION__));
  if (!isDev) return;

  const el =
    target && target.nodeType === 1
      ? (target as HTMLElement)
      : target?.parentElement ?? null;
  const activeEl = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;

  let computedUserSelect = '';
  let computedWebkitUserSelect = '';
  if (el && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      computedUserSelect = cs.userSelect || '';
      computedWebkitUserSelect = cs.getPropertyValue('-webkit-user-select') || '';
    } catch {
      /* ignore */
    }
  }

  const entry: SelectionDiagnosticEvent = {
    timestamp: Date.now(),
    eventType,
    toolKind,
    pointerType,
    targetTag: el?.tagName?.toLowerCase() ?? 'none',
    targetClass: typeof el?.className === 'string' ? el.className : '',
    targetRole: el?.getAttribute?.('role') ?? null,
    activeElementTag: activeEl?.tagName?.toLowerCase() ?? 'none',
    activeElementEditable: Boolean(
      activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable),
    ),
    selectionAnchorChain: describeNodeChain(sel?.anchorNode ?? target),
    computedUserSelect,
    computedWebkitUserSelect,
    canceled,
  };

  devDiagnosticLog.push(entry);
  if (devDiagnosticLog.length > MAX_DIAG_LOG) {
    devDiagnosticLog.shift();
  }
}

/**
 * Safely blurs any focused non-allowed editor chrome element (such as `.layer-input`)
 * and clears stale DOM selection ONLY if its anchor/focus belongs to the non-editable workspace.
 */
export function clearWorkspaceStaleSelectionAndFocus(
  workspaceRoot: HTMLElement | null,
  toolKind: ToolKind,
): boolean {
  let cleared = false;
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    const active = document.activeElement;
    if (
      workspaceRoot &&
      workspaceRoot.contains(active) &&
      (active.classList.contains('layer-input') || !isAllowedTextSelectionTarget(active))
    ) {
      try {
        active.blur();
        cleared = true;
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      const insideWorkspace =
        !workspaceRoot ||
        (anchor && workspaceRoot.contains(anchor)) ||
        (focus && workspaceRoot.contains(focus));
      const allowed = isAllowedTextSelectionTarget(anchor) || isAllowedTextSelectionTarget(focus);
      if (insideWorkspace && !allowed) {
        try {
          sel.removeAllRanges();
          cleared = true;
          recordDiagnostic('mode-transition', toolKind, anchor, true);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return cleared;
}

/**
 * Attaches mode-scoped capture listeners (`selectstart`, `contextmenu`, and reentrancy-guarded `selectionchange`)
 * to the `.editor` workspace root so drawing/pen interactions near the left `.rail`, `.preset` numbers,
 * `.pager`, or `.ed-head` never trigger the iPad Copy / Look Up / Translate / Search Web callout menu.
 */
export function attachEditorSelectionGuard(
  workspaceRoot: HTMLElement,
  getToolKind: () => ToolKind,
): () => void {
  let cleaningSelection = false;
  let lastPointerType = 'unknown';

  const onPointerDownCapture = (e: PointerEvent) => {
    lastPointerType = e.pointerType || 'unknown';
    const kind = getToolKind();
    if (!isDrawingOrManipulationTool(kind)) return;
    const target = e.target as Node | null;
    if (!isAllowedTextSelectionTarget(target)) {
      // If a stale input (e.g. .layer-input) had focus, blur it when pen/touch starts in drawing mode
      if (
        typeof document !== 'undefined' &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== e.target &&
        workspaceRoot.contains(document.activeElement)
      ) {
        document.activeElement.blur();
      }
    }
  };

  const onSelectStartCapture = (e: Event) => {
    const kind = getToolKind();
    if (!isDrawingOrManipulationTool(kind)) return;
    const target = e.target as Node | null;
    if (isAllowedTextSelectionTarget(target)) {
      recordDiagnostic('selectstart', kind, target, false, lastPointerType);
      return;
    }
    if (e.cancelable) {
      e.preventDefault();
    }
    recordDiagnostic('selectstart', kind, target, true, lastPointerType);
  };

  const onContextMenuCapture = (e: Event) => {
    const kind = getToolKind();
    if (!isDrawingOrManipulationTool(kind)) return;
    const target = e.target as Node | null;
    if (isAllowedTextSelectionTarget(target)) return;
    if (e.cancelable) {
      e.preventDefault();
    }
    recordDiagnostic('contextmenu', kind, target, true, lastPointerType);
  };

  const onSelectionChange = () => {
    if (cleaningSelection) return;
    const kind = getToolKind();
    if (!isDrawingOrManipulationTool(kind)) return;
    if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    const insideWorkspace =
      (anchor && workspaceRoot.contains(anchor)) || (focus && workspaceRoot.contains(focus));
    if (!insideWorkspace) return;
    if (isAllowedTextSelectionTarget(anchor) || isAllowedTextSelectionTarget(focus)) return;

    cleaningSelection = true;
    try {
      sel.removeAllRanges();
      recordDiagnostic('selectionchange', kind, anchor, true, lastPointerType);
    } catch {
      /* ignore */
    } finally {
      cleaningSelection = false;
    }
  };

  workspaceRoot.addEventListener('pointerdown', onPointerDownCapture, { capture: true });
  workspaceRoot.addEventListener('selectstart', onSelectStartCapture, { capture: true });
  workspaceRoot.addEventListener('contextmenu', onContextMenuCapture, { capture: true });
  document.addEventListener('selectionchange', onSelectionChange);

  return () => {
    workspaceRoot.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
    workspaceRoot.removeEventListener('selectstart', onSelectStartCapture, { capture: true });
    workspaceRoot.removeEventListener('contextmenu', onContextMenuCapture, { capture: true });
    document.removeEventListener('selectionchange', onSelectionChange);
  };
}
