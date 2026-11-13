import { useRef, useState } from 'react';
import { Check, X, Tag, Smartphone, Tablet, ImagePlus } from 'lucide-react';
import { COVERS, PAPER_COLORS, PAPER_SIZES, TEMPLATES, isDark, type PaperSize, type Template } from '../domain/types';
import { actions } from './store';
import { blobStore, sha256Hex } from '../storage/blobStore';
import { db } from '../storage/db';

export function templateStyle(tpl: Template, bg: string): React.CSSProperties {
  const line = isDark(bg) ? '#ffffff30' : '#00000030';
  const base: React.CSSProperties = { backgroundColor: bg };
  if (tpl === 'ruled') return { ...base, backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 11px, ${line} 11px 12px)`, backgroundPosition: '0 14px' };
  if (tpl === 'grid') return { ...base, backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`, backgroundSize: '12px 12px' };
  if (tpl === 'dotted') return { ...base, backgroundImage: `radial-gradient(${line} 1px, transparent 1.5px)`, backgroundSize: '12px 12px' };
  return base;
}

export function NewNotebookDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'cover' | 'paper'>('paper');
  const [name, setName] = useState('');
  const [hasCover, setHasCover] = useState(true);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState<string | null>(null);
  const [tpl, setTpl] = useState<Template>('blank');
  const [bg, setBg] = useState('#000000');
  const [cover, setCover] = useState<{ id: string; label: string; color: string; assetId?: string; previewUrl?: string }>(COVERS[0]);
  const [customCover, setCustomCover] = useState<{ assetId: string; previewUrl: string } | null>(null);
  const [size, setSize] = useState<PaperSize>('A4');
  const [landscape, setLandscape] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const addTag = () => {
    const t = (tagInput ?? '').trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput(null);
  };

  const onUploadCoverPic = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    const assetId = `cover-${crypto.randomUUID()}`;
    const backend = await blobStore.put(assetId, bytes);
    await db.assets.put({
      id: assetId,
      kind: 'image',
      name: file.name,
      mimeType: file.type || 'image/jpeg',
      size: bytes.byteLength,
      sha256,
      backend,
      createdAt: Date.now(),
    });
    const previewUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: file.type || 'image/jpeg' }));
    setCustomCover({ assetId, previewUrl });
    setCover({ id: 'custom-pic', label: 'Custom Photo', color: '#222222', assetId, previewUrl });
    e.target.value = '';
  };

  const create = async () => {
    if (creatingRef.current || busy) return;
    creatingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await actions.createNotebook(name.trim() || 'Untitled', true, {
        cover: cover.color,
        coverAssetId: cover.assetId,
        hasCover,
        template: tpl,
        paper: bg,
        size,
        landscape,
        tags,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save notebook. Please try again.');
    } finally {
      creatingRef.current = false;
      setBusy(false);
    }
  };

  const ratio = PAPER_SIZES[size].width / PAPER_SIZES[size].height;
  const aspect = landscape ? 1 / ratio : ratio;
  const coverPreviewStyle: React.CSSProperties = cover.previewUrl
    ? { backgroundImage: `url(${cover.previewUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', aspectRatio: aspect }
    : { background: cover.color, aspectRatio: aspect };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New Notebook" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <button className="circle-btn" aria-label="Close" onClick={onClose}><X size={20} /></button>
          <h2>New Notebook</h2>
          <button className="primary pill" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
        {error && (
          <div role="alert" style={{ margin: '0 16px 8px', padding: '8px 12px', borderRadius: 8, background: 'rgba(255,69,58,0.14)', color: '#FF453A', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>{error}</span>
            <button type="button" className="chip" onClick={create} disabled={busy}>Retry</button>
          </div>
        )}
        <div className="modal-top">
          <div className="previews">
            {hasCover && (
              <button className={`prev ${tab === 'cover' ? 'sel' : ''}`} aria-pressed={tab === 'cover'} onClick={() => setTab('cover')}>
                <span>Cover</span>
                <div className="mini cover-mini" style={coverPreviewStyle}><i /></div>
              </button>
            )}
            <button className={`prev ${tab === 'paper' || !hasCover ? 'sel' : ''}`} aria-pressed={tab === 'paper'} onClick={() => setTab('paper')}>
              <span>Paper</span>
              <div className="mini" style={{ ...templateStyle(tpl, bg), aspectRatio: aspect }} />
            </button>
          </div>
          <div className="fields">
            <label className="field-row"><span>Name</span>
              <input id="notebook-name-input" name="notebookName" className="text-input" placeholder="Notebook Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} autoFocus />
            </label>
            <div className="field-row"><span>Notebook Cover</span>
              <button role="switch" aria-checked={hasCover} aria-label="Notebook Cover" className={`switch ${hasCover ? 'on' : ''}`} onClick={() => { setHasCover(!hasCover); if (hasCover) setTab('paper'); }}><i /></button>
            </div>
            <div className="field-row tags"><span>Tags</span>
              <div className="tag-list">
                {tags.map((t) => <button key={t} className="tag" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><Tag size={12} /> {t} <X size={12} /></button>)}
                {tagInput === null ? (
                  <button className="tag add" onClick={() => setTagInput('')}>+ Add</button>
                ) : (
                  <input id="notebook-tag-input" name="notebookTag" className="tag-input" autoFocus value={tagInput} onChange={(e) => setTagInput(e.target.value)} onBlur={addTag} onKeyDown={(e) => { if (e.key === 'Enter') addTag(); if (e.key === 'Escape') setTagInput(null); }} aria-label="New tag" />
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-body">
          {tab === 'paper' || !hasCover ? (
            <>
              <h3>Paper</h3>
              <div className="cards">
                {TEMPLATES.map((t) => (
                  <button key={t.id} className="card" aria-pressed={tpl === t.id} onClick={() => setTpl(t.id)}>
                    <div className="card-face" style={templateStyle(t.id, bg)}>{tpl === t.id && <span className="tick"><Check size={16} /></span>}</div>
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
              <div className="bg-row"><span>Background Color</span>
                <div className="dots">
                  {PAPER_COLORS.map((c) => (
                    <button key={c} className={`dot ${bg.toLowerCase() === c.toLowerCase() ? 'sel' : ''}`} style={{ background: c }} aria-label={`Background ${c}`} aria-pressed={bg.toLowerCase() === c.toLowerCase()} onClick={() => setBg(c)} />
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <h3>Cover</h3>
              <input ref={coverInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onUploadCoverPic} />
              <div className="cards">
                <button className="card" aria-pressed={cover.id === 'custom-pic'} onClick={() => coverInputRef.current?.click()}>
                  <div
                    className="card-face cover-face upload-cover-face"
                    style={customCover ? { backgroundImage: `url(${customCover.previewUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { background: '#2c2c2e' }}
                  >
                    {!customCover && <ImagePlus size={28} style={{ position: 'absolute', inset: 0, margin: 'auto', color: '#0A84FF' }} />}
                    <i />
                    {cover.id === 'custom-pic' && <span className="tick"><Check size={16} /></span>}
                  </div>
                  <span>{customCover ? 'Change Photo' : 'Upload Photo'}</span>
                </button>
                {COVERS.map((c) => (
                  <button key={c.id} className="card" aria-pressed={cover.id === c.id} onClick={() => setCover(c)}>
                    <div className="card-face cover-face" style={{ background: c.color }}><i />{cover.id === c.id && <span className="tick"><Check size={16} /></span>}</div>
                    <span>{c.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="size-row">
            <label htmlFor="paper-size-select">Paper Size
              <select id="paper-size-select" name="paperSize" value={size} onChange={(e) => setSize(e.target.value as PaperSize)}>
                {(Object.keys(PAPER_SIZES) as PaperSize[]).map((k) => <option key={k}>{k}</option>)}
              </select>
            </label>
            <div className="seg" role="radiogroup" aria-label="Orientation">
              <button role="radio" aria-checked={!landscape} aria-label="Portrait" className={!landscape ? 'on' : ''} onClick={() => setLandscape(false)}><Smartphone size={18} /></button>
              <button role="radio" aria-checked={landscape} aria-label="Landscape" className={landscape ? 'on' : ''} onClick={() => setLandscape(true)}><Tablet size={18} style={{ transform: 'rotate(90deg)' }} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
