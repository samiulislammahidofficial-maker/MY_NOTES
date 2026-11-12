import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Download, Trash2, X } from 'lucide-react';
import { InkSurface } from '../engine/surface';
import { writingDiagnostics } from '../engine/diagnostics';
import type { InkStroke } from '../domain/types';
import { useApp } from '../app/store';

export function WritingDiagnosticsModal({ onClose }: { onClose: () => void }) {
  const tool = useApp((s) => s.tool);
  const boardHostRef = useRef<HTMLDivElement>(null);
  const surfRef = useRef<InkSurface | null>(null);
  const boardStrokes = useRef<InkStroke[]>([]);
  const committedCount = useRef(0);
  const penDownCounts = useRef({ insideBoard: 0, outsideBoard: 0 });
  const [stats, setStats] = useState<ReturnType<InkSurface['getStats']> | null>(null);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);

  const buildId = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'v0.1.0 (local)';

  useEffect(() => {
    if (!boardHostRef.current) return;
    const host = boardHostRef.current;
    const surf = new InkSurface(host, {
      getTool: () => useApp.getState().tool,
      getPaper: () => ({ color: '#16161A', template: 'blank' }),
      getLayers: () => [{ id: 'diag-layer', name: 'Diagnostics', visible: true, locked: false, opacity: 1 }],
      activeLayerId: () => 'diag-layer',
      onStroke: (stroke) => {
        committedCount.current++;
        boardStrokes.current = [...boardStrokes.current, stroke];
        surf.setStrokes(boardStrokes.current);
      },
      onEdit: (_label, remove, add) => {
        const removedIds = new Set(remove.map((stroke) => stroke.id));
        boardStrokes.current = [
          ...boardStrokes.current.filter((stroke) => !removedIds.has(stroke.id)),
          ...add,
        ];
      },
    });
    surf.setPage(
      {
        id: 'diag-page',
        notebookId: 'diag-nb',
        width: 800,
        height: 600,
        layerIds: ['diag-layer'],
        revision: 1,
      },
      [],
    );
    surfRef.current = surf;
    const countPenDown = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      const location = event.composedPath().includes(host) ? 'insideBoard' : 'outsideBoard';
      penDownCounts.current[location]++;
    };
    window.addEventListener('pointerdown', countPenDown, true);

    const interval = setInterval(() => {
      if (surfRef.current) {
        setStats(surfRef.current.getStats());
      }
    }, 200);

    return () => {
      clearInterval(interval);
      window.removeEventListener('pointerdown', countPenDown, true);
      surf.destroy();
      surfRef.current = null;
    };
  }, []);

  const getReport = () => {
    const surface = surfRef.current;
    return {
      buildId,
      time: new Date().toISOString(),
      ballpointModel: tool.ballpointModel ?? 'normal',
      penSmoothing: tool.penSmoothing ?? 'low',
      penOnly: tool.penOnly,
      tool: tool.kind,
      stats: surface?.getStats(),
      committedStrokesSinceOpen: committedCount.current,
      penDownsSinceOpen: { ...penDownCounts.current },
      recentBoardEvents: surface ? writingDiagnostics.getRecentEvents(surface.diagnosticId) : [],
    };
  };

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(getReport(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const handleExportTestSamples = () => {
    const json = JSON.stringify(getReport(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `writing-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  const handleClearBoard = () => {
    boardStrokes.current = [];
    surfRef.current?.setStrokes([]);
  };

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal-box"
        role="dialog"
        aria-label="Writing Diagnostics"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 760, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>Stylus & Ink Diagnostics</h3>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(10, 132, 255, 0.2)',
                color: '#64D2FF',
                fontWeight: 600,
              }}
            >
              {buildId}
            </span>
          </div>
          <button type="button" className="icon sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflowY: 'auto' }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Write rapidly on the test board below to isolate consecutive stroke capture and visual ink geometry.
            No private notes or passwords are recorded.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: 8,
              background: '#141417',
              padding: 10,
              borderRadius: 10,
              fontSize: 12,
            }}
          >
            <div>
              <span style={{ color: 'var(--muted)' }}>PointerType:</span>{' '}
              <strong>{stats?.activePointerType || 'none'}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>PointerDowns:</span>{' '}
              <strong>{stats?.debug?.down ?? 0}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Accepted:</span>{' '}
              <strong style={{ color: '#30D158' }}>{stats?.debug?.accepted ?? 0}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Rejected:</span>{' '}
              <strong style={{ color: stats?.debug?.rejected ? '#FF453A' : '#8E8E93' }}>
                {stats?.debug?.rejected ?? 0}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Completed:</span>{' '}
              <strong>{stats?.debug?.completed ?? 0}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Canceled:</span>{' '}
              <strong>{stats?.debug?.cancel ?? 0}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Lost Capture:</span>{' '}
              <strong>{stats?.debug?.lostCapture ?? 0}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Last Gap:</span>{' '}
              <strong>{stats?.debug?.lastGapMs ? `${stats.debug.lastGapMs}ms` : '—'}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Pressure (min/max):</span>{' '}
              <strong>
                {stats && stats.debug.maxPressure > 0
                  ? `${stats.debug.minPressure.toFixed(2)} / ${stats.debug.maxPressure.toFixed(2)}`
                  : '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--muted)' }}>Surface Lifecycle:</span>{' '}
              <strong>#{stats?.surfaceLifecycles ?? 1}</strong>
            </div>
          </div>

          <div style={{ fontSize: 12 }}>
            Strokes on board {stats?.strokes ?? 0}. For a rapid-stroke test, reopen this dialog, draw 20 separate
            pen marks without pausing, then export the report and include how many marks you attempted.
          </div>

          {/* Test Board Canvas */}
          <div
            ref={boardHostRef}
            style={{
              width: '100%',
              height: 260,
              borderRadius: 10,
              overflow: 'hidden',
              position: 'relative',
              background: '#16161A',
              border: '1.5px dashed rgba(255, 255, 255, 0.18)',
              touchAction: 'none',
            }}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="chip" onClick={handleClearBoard}>
                <Trash2 size={14} /> Clear Test Board
              </button>
              <button type="button" className="chip" onClick={handleCopySummary}>
                {copied ? <CheckCircle2 size={14} color="#30D158" /> : <Copy size={14} />}
                <span>{copied ? 'Summary Copied!' : 'Copy Diagnostic Summary'}</span>
              </button>
            </div>
            <button type="button" className="chip" onClick={handleExportTestSamples}>
              {exported ? <CheckCircle2 size={14} color="#30D158" /> : <Download size={14} />}
              <span>{exported ? 'Exported!' : 'Export Test Samples JSON'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
