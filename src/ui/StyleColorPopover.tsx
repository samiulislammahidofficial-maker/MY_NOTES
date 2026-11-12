import { useEffect, useRef, useState } from 'react';
import { Pipette, Plus, Sparkles } from 'lucide-react';
import { mmToPt } from '../domain/types';
import { actions, useApp } from '../app/store';
import type { Nib, StrokeStyle } from '../engine/tools';

export type StylePopoverTab = 'grid' | 'wheel' | 'palettes' | 'style';

const QUICK_SIZES_MM = [0.35, 1.2, 1.9, 3.8, 5.0];

const GRID_COLORS = [
  // Row 1: Grayscale
  '#FFFFFF', '#E5E5EA', '#C7C7CC', '#AEAEB2', '#8E8E93', '#636366', '#48484A', '#2C2C2E', '#1C1C1E', '#000000',
  // Row 2: Vivid
  '#FEFB42', '#FFD60A', '#FF9F0A', '#FF6B22', '#FF453A', '#FF2D55', '#BF5AF2', '#5E5CE6', '#0A84FF', '#30D158',
  // Row 3: Light / Pastel
  '#FFF9B0', '#FFE58F', '#FFCCA7', '#FFABA3', '#FFACC5', '#E5B8FF', '#C4C3FF', '#A7D8FF', '#99F3BD', '#B7F0AD',
  // Row 4: Medium
  '#F4F436', '#F5A623', '#E67E22', '#E74C3C', '#D81B60', '#BD45E5', '#5856D6', '#1E88FF', '#00BCD4', '#2ECC71',
  // Row 5: Deep
  '#B8A800', '#B87300', '#A04000', '#922B21', '#880E4F', '#6A1B9A', '#283593', '#0D47A1', '#006064', '#1B5E20',
];

const CURATED_PALETTES: { name: string; colors: string[] }[] = [
  {
    name: 'Dark Paper Essentials',
    colors: ['#FEFB42', '#FFFFFF', '#BD45E5', '#64D2FF', '#30D158', '#FF9F0A', '#FF453A', '#FF85A1'],
  },
  {
    name: 'Academic & Study',
    colors: ['#1E88FF', '#0A84FF', '#E74C3C', '#2ECC71', '#F39C12', '#8E44AD', '#34495E', '#111111'],
  },
  {
    name: 'Soft Pastel',
    colors: ['#F4B8BC', '#F4B8D4', '#DCC4F0', '#C8CCF0', '#C4E4F8', '#B8DCCC', '#CDE8C4', '#FFF3B0'],
  },
];

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace('#', '').padEnd(6, '0');
  const num = parseInt(clean.slice(0, 6), 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h: h * 360, s, v };
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hh = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hh >= 0 && hh < 1) [r1, g1, b1] = [c, x, 0];
  else if (hh >= 1 && hh < 2) [r1, g1, b1] = [x, c, 0];
  else if (hh >= 2 && hh < 3) [r1, g1, b1] = [0, c, x];
  else if (hh >= 3 && hh < 4) [r1, g1, b1] = [0, x, c];
  else if (hh >= 4 && hh < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = v - c;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function StyleColorPopover({
  initialTab = 'style',
  onClose,
}: {
  initialTab?: StylePopoverTab;
  onClose: () => void;
}) {
  const s = useApp();
  const t = s.tool;
  const isHighlighter = t.kind === 'highlighter';
  const currentColor = isHighlighter ? t.hlColor : t.color;
  const currentWidthPt = isHighlighter ? t.hlWidth : t.width;
  const currentMm = +(currentWidthPt * 25.4 / 72).toFixed(2);

  const [tab, setTab] = useState<StylePopoverTab>(initialTab);
  const [customStyleOn, setCustomStyleOn] = useState(true);
  const [hsv, setHsv] = useState(() => hexToHsv(currentColor));

  const wheelRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHsv(hexToHsv(currentColor));
  }, [currentColor]);

  const applyColor = (hex: string) => {
    const formatted = hex.startsWith('#') ? hex.toUpperCase() : `#${hex.toUpperCase()}`;
    if (isHighlighter) {
      actions.setTool({ hlColor: formatted });
    } else {
      actions.setTool({ color: formatted });
      actions.updatePreset(s.activePreset, { color: formatted });
    }
  };

  const applyWidthMm = (mm: number) => {
    const clamped = Math.max(0.1, Math.min(isHighlighter ? 15 : 8, +mm.toFixed(2)));
    if (isHighlighter) {
      actions.setTool({ hlWidth: mmToPt(clamped) });
    } else {
      actions.setTool({ width: mmToPt(clamped) });
      actions.updatePreset(s.activePreset, { widthMm: clamped });
    }
  };

  const handleHuePointer = (clientX: number, clientY: number) => {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angleRad = Math.atan2(clientY - cy, clientX - cx);
    // Conic gradient starts at top (-90deg) or right (0deg); let's align 0deg at top (12 o'clock)
    const deg = ((angleRad * 180) / Math.PI + 90 + 360) % 360;
    const next = { ...hsv, h: deg };
    setHsv(next);
    applyColor(hsvToHex(next.h, next.s, next.v));
  };

  const handleSvPointer = (clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sVal = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const vVal = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    const next = { ...hsv, s: sVal, v: vVal };
    setHsv(next);
    applyColor(hsvToHex(next.h, next.s, next.v));
  };

  const handleEyedropper = async () => {
    const AnyWin = window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } };
    if (AnyWin.EyeDropper) {
      try {
        const dropper = new AnyWin.EyeDropper();
        const res = await dropper.open();
        if (res?.sRGBHex) applyColor(res.sRGBHex);
      } catch {
        /* cancelled */
      }
    }
  };

  // Hue handle position on ring (radius 96px inside 224x224 wheel)
  const hueRad = ((hsv.h - 90) * Math.PI) / 180;
  const ringRadius = 96;
  const hueX = 112 + Math.cos(hueRad) * ringRadius;
  const hueY = 112 + Math.sin(hueRad) * ringRadius;
  const pureHueHex = hsvToHex(hsv.h, 1, 1);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className="popover style-color-popover"
        role="dialog"
        aria-label="Custom Style and Color"
        onClick={(e) => e.stopPropagation()}
      >
        {tab === 'style' && (
          <div className="scp-body">
            <div className="scp-head">
              <span className="scp-title">Custom Style</span>
              <button
                type="button"
                role="switch"
                aria-checked={customStyleOn}
                aria-label="Custom Style"
                className={`nn-switch ${customStyleOn ? 'on' : ''}`}
                onClick={() => setCustomStyleOn(!customStyleOn)}
              >
                <span />
              </button>
            </div>

            <div className="scp-section">
              <div className="scp-label">Size</div>
              <div className="scp-quick-sizes">
                {QUICK_SIZES_MM.map((mm) => {
                  const active = Math.abs(currentMm - mm) < 0.06;
                  const dotPx = Math.max(4, Math.min(24, mm * 4.4));
                  return (
                    <button
                      key={mm}
                      type="button"
                      className={`scp-size-dot-btn ${active ? 'on' : ''}`}
                      onClick={() => applyWidthMm(mm)}
                    >
                      <span className="scp-dot-wrap">
                        <span
                          className="scp-dot"
                          style={{ width: dotPx, height: dotPx, background: active ? '#1E88FF' : '#FFFFFF' }}
                        />
                      </span>
                      <span className="scp-mm-txt">{mm.toFixed(mm < 1 ? 2 : 1)}mm</span>
                    </button>
                  );
                })}
              </div>

              <div className="scp-slider-row">
                <input
                  type="range"
                  className="scp-range"
                  min={isHighlighter ? 1.0 : 0.15}
                  max={isHighlighter ? 12.0 : 5.5}
                  step={0.05}
                  value={currentMm}
                  aria-label="Stroke width in millimeters"
                  onChange={(e) => applyWidthMm(+e.target.value)}
                />
                <div className="scp-size-readout">
                  <span
                    className="scp-live-dot"
                    style={{
                      width: Math.max(3, Math.min(22, currentMm * 4.2)),
                      height: Math.max(3, Math.min(22, currentMm * 4.2)),
                    }}
                  />
                  <span>{currentMm.toFixed(2)}mm</span>
                </div>
              </div>
            </div>

            <div className="scp-divider" />

            <div className="scp-section">
              <div className="scp-label">Pen</div>
              <div className="scp-pen-row">
                {(
                  [
                    { id: 'ballpoint', label: 'Ballpoint' },
                    { id: 'fountain', label: 'Fountain' },
                    { id: 'brush', label: 'Brush' },
                  ] as { id: Nib; label: string }[]
                ).map((pen) => {
                  const on = t.nib === pen.id;
                  return (
                    <button
                      key={pen.id}
                      type="button"
                      className={`scp-pen-circle ${on ? 'on' : ''}`}
                      aria-label={pen.label}
                      title={pen.label}
                      onClick={() => actions.setTool({ nib: pen.id })}
                    >
                      {pen.id === 'ballpoint' && (
                        <svg viewBox="0 0 48 48" width="42" height="42" aria-hidden>
                          <rect x="22" y="10" width="4" height="7" rx="1.5" fill="#2B2B2E" />
                          <rect x="19" y="16" width="10" height="12" rx="1" fill="#3A3A3E" />
                          <rect x="16" y="28" width="16" height="18" rx="2" fill="#222225" />
                          <line x1="16" y1="33" x2="32" y2="33" stroke="#555" strokeWidth="1.5" />
                        </svg>
                      )}
                      {pen.id === 'fountain' && (
                        <svg viewBox="0 0 48 48" width="42" height="42" aria-hidden>
                          <path d="M24 9 L17 24 L20 31 L28 31 L31 24 Z" fill="#E8E8ED" stroke="#8E8E93" strokeWidth="1.2" />
                          <line x1="24" y1="9" x2="24" y2="23" stroke="#555" strokeWidth="1.3" />
                          <circle cx="24" cy="23" r="1.8" fill="#444" />
                          <path d="M19 31 L18 45 L30 45 L29 31 Z" fill="#1F1F22" />
                        </svg>
                      )}
                      {pen.id === 'brush' && (
                        <svg viewBox="0 0 48 48" width="42" height="42" aria-hidden>
                          <path d="M24 11 C20 16 19 22 19 25 L29 25 C29 22 28 16 24 11 Z" fill="#1C1C1E" />
                          <path d="M17 25 L15 45 L33 45 L31 25 Z" fill="#3A3A3C" />
                          <line x1="17" y1="29" x2="31" y2="29" stroke="#636366" strokeWidth="1.5" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>

              {t.nib === 'ballpoint' && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#D1D1D6' }}>Ballpoint Model</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {(t.ballpointModel ?? 'normal') === 'compatibility' ? 'Compatibility' : 'Normal'}
                    </span>
                  </div>
                  <div className="seg" role="radiogroup" aria-label="Ballpoint model" style={{ margin: 0 }}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={(t.ballpointModel ?? 'normal') === 'normal'}
                      className={(t.ballpointModel ?? 'normal') === 'normal' ? 'on' : ''}
                      onClick={() => actions.setTool({ ballpointModel: 'normal' })}
                      style={{ fontSize: 11, minHeight: 28 }}
                    >
                      Normal
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={(t.ballpointModel ?? 'normal') === 'compatibility'}
                      className={(t.ballpointModel ?? 'normal') === 'compatibility' ? 'on' : ''}
                      onClick={() => actions.setTool({ ballpointModel: 'compatibility' })}
                      style={{ fontSize: 11, minHeight: 28 }}
                    >
                      Compatibility
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="scp-divider" />

            <div className="scp-section">
              <div className="scp-label">Stroke Style</div>
              <div className="scp-stroke-styles">
                {(
                  [
                    { id: 'solid', label: 'Solid stroke' },
                    { id: 'dashed', label: 'Dashed stroke' },
                    { id: 'dotted', label: 'Dotted stroke' },
                  ] as { id: StrokeStyle; label: string }[]
                ).map((st) => {
                  const on = (t.strokeStyle ?? 'solid') === st.id && !t.rainbow;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      className={`scp-style-box ${on ? 'on' : ''}`}
                      aria-label={st.label}
                      title={st.label}
                      onClick={() => actions.setTool({ strokeStyle: st.id, rainbow: false })}
                    >
                      <svg viewBox="0 0 40 40" width="32" height="32" aria-hidden>
                        <line
                          x1="9"
                          y1="31"
                          x2="31"
                          y2="9"
                          stroke="#FFFFFF"
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeDasharray={
                            st.id === 'dashed' ? '5 4' : st.id === 'dotted' ? '1.2 4.2' : undefined
                          }
                        />
                      </svg>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`scp-style-box ${t.rainbow ? 'on' : ''}`}
                  aria-label="Rainbow pen"
                  title="Rainbow gradient stroke"
                  onClick={() => actions.setTool({ rainbow: !t.rainbow })}
                >
                  <Sparkles size={20} color="#FEFB42" />
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'wheel' && (
          <div className="scp-body">
            <div className="scp-head" style={{ justifyContent: 'center', position: 'relative' }}>
              <span className="scp-title">Color</span>
              <button
                type="button"
                className="scp-eyedropper"
                aria-label="Pick color from screen"
                title="Eyedropper"
                onClick={() => void handleEyedropper()}
              >
                <Pipette size={19} />
              </button>
            </div>

            <div className="scp-wheel-wrap">
              <div
                ref={wheelRef}
                className="scp-hue-ring"
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  handleHuePointer(e.clientX, e.clientY);
                }}
                onPointerMove={(e) => {
                  if (e.buttons) handleHuePointer(e.clientX, e.clientY);
                }}
              >
                <div className="scp-hue-hole" />
                <span
                  className="scp-wheel-thumb"
                  style={{
                    left: hueX,
                    top: hueY,
                    background: pureHueHex,
                  }}
                />
              </div>

              <div
                ref={svRef}
                className="scp-sv-square"
                style={{
                  backgroundColor: pureHueHex,
                  backgroundImage:
                    'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
                }}
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  handleSvPointer(e.clientX, e.clientY);
                }}
                onPointerMove={(e) => {
                  if (e.buttons) handleSvPointer(e.clientX, e.clientY);
                }}
              >
                <span
                  className="scp-wheel-thumb"
                  style={{
                    left: `${hsv.s * 100}%`,
                    top: `${(1 - hsv.v) * 100}%`,
                    background: currentColor,
                  }}
                />
              </div>

              <span className="scp-hex-label">{currentColor.toUpperCase()}</span>
            </div>

            <div className="scp-section" style={{ marginTop: 6 }}>
              <div className="scp-label">Palette</div>
              <div className="scp-palette-row">
                {s.presets.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`preset scp-preset-chip ${s.activePreset === i ? 'on' : ''}`}
                    style={{ background: p.color }}
                    onClick={() => actions.selectPreset(i)}
                    aria-label={`Preset ${i + 1} (${p.widthMm}mm)`}
                  >
                    <span>.{Math.round(p.widthMm * 100)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="scp-add-preset"
                  aria-label="Add current color and size to palette"
                  title="Add preset"
                  onClick={() => actions.addPreset()}
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'grid' && (
          <div className="scp-body">
            <div className="scp-head" style={{ justifyContent: 'center' }}>
              <span className="scp-title">Color Grid</span>
            </div>
            <div className="scp-color-grid">
              {GRID_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`scp-grid-cell ${currentColor.toUpperCase() === c ? 'on' : ''}`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  onClick={() => applyColor(c)}
                />
              ))}
            </div>
            <div className="scp-section" style={{ marginTop: 12 }}>
              <div className="scp-label">Palette</div>
              <div className="scp-palette-row">
                {s.presets.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`preset scp-preset-chip ${s.activePreset === i ? 'on' : ''}`}
                    style={{ background: p.color }}
                    onClick={() => actions.selectPreset(i)}
                  >
                    <span>.{Math.round(p.widthMm * 100)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="scp-add-preset"
                  aria-label="Add preset"
                  onClick={() => actions.addPreset()}
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'palettes' && (
          <div className="scp-body">
            <div className="scp-head" style={{ justifyContent: 'center' }}>
              <span className="scp-title">Palettes</span>
            </div>
            {CURATED_PALETTES.map((pal) => (
              <div key={pal.name} className="scp-section" style={{ marginBottom: 12 }}>
                <div className="scp-label">{pal.name}</div>
                <div className="scp-swatch-row">
                  {pal.colors.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={` swatch ${currentColor.toUpperCase() === c ? 'on' : ''}`}
                      style={{ background: c }}
                      aria-label={`Select color ${c}`}
                      onClick={() => applyColor(c)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="scp-tabs" role="tablist">
          {(
            [
              { id: 'grid', label: 'Grid' },
              { id: 'wheel', label: 'Wheel' },
              { id: 'palettes', label: 'Palettes' },
              { id: 'style', label: 'Style' },
            ] as { id: StylePopoverTab; label: string }[]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`scp-tab ${tab === item.id ? 'on' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
