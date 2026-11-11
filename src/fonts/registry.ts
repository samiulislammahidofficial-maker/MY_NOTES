import type { CustomFontRecord } from '../domain/types';
import { repo } from '../storage/db';
import { blobStore, sha256Hex } from '../storage/blobStore';

export interface FontOption {
  id: string;
  label: string;
  family: string;
  group: 'system' | 'curated' | 'custom';
  assetId?: string;
}

export const SYSTEM_FONTS: FontOption[] = [
  { id: 'sys-sans', label: 'System Sans', family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', group: 'system' },
  { id: 'sys-serif', label: 'Georgia / Serif', family: 'Georgia, "Times New Roman", serif', group: 'system' },
  { id: 'sys-mono', label: 'Monospace', family: 'ui-monospace, SFMono-Regular, Consolas, monospace', group: 'system' },
  { id: 'cur-hand', label: 'Casual Script', family: '"Segoe Print", "Bradley Hand", Chilanka, cursive', group: 'curated' },
  { id: 'cur-round', label: 'Rounded Note', family: '"Trebuchet MS", "Hiragino Maru Gothic ProN", sans-serif', group: 'curated' },
];

const MAX_FONT_BYTES = 20 * 1024 * 1024; // 20 MB

/** Check OpenType/TrueType magic header bytes. */
export function detectFontFormat(bytes: Uint8Array): 'ttf' | 'otf' | null {
  if (bytes.byteLength < 12) return null;
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  // TrueType: 0x00010000 or 'true'
  if ((b0 === 0 && b1 === 1 && b2 === 0 && b3 === 0) || (b0 === 0x74 && b1 === 0x72 && b2 === 0x75 && b3 === 0x65)) {
    return 'ttf';
  }
  // OpenType CFF: 'OTTO'
  if (b0 === 0x4f && b1 === 0x54 && b2 === 0x54 && b3 === 0x4f) {
    return 'otf';
  }
  return null;
}

const loadedFontIds = new Set<string>();

export async function registerFontBytes(family: string, bytes: Uint8Array): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
  if (loadedFontIds.has(family)) return;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  loadedFontIds.add(family);
}

export async function loadSavedCustomFonts(): Promise<CustomFontRecord[]> {
  const fonts = await repo.allFonts();
  for (const f of fonts) {
    try {
      const bytes = await blobStore.get(f.assetId);
      if (bytes) await registerFontBytes(f.family, bytes);
    } catch {
      // Corrupt or missing asset; fall back gracefully
    }
  }
  return fonts;
}

export async function importCustomFontFile(file: File): Promise<CustomFontRecord> {
  if (file.size > MAX_FONT_BYTES) throw new Error('Font file exceeds 20 MB limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFontFormat(bytes);
  if (!format) throw new Error('Unsupported or corrupt font file (must be valid .ttf or .otf).');
  const sha256 = await sha256Hex(bytes);
  const existing = (await repo.allFonts()).find((f) => f.sha256 === sha256);
  if (existing) {
    await registerFontBytes(existing.family, bytes);
    return existing;
  }
  const cleanBase = file.name.replace(/\.(ttf|otf)$/i, '').replace(/[^a-zA-Z0-9_-]/g, ' ').trim() || 'CustomFont';
  const id = crypto.randomUUID();
  const family = `Custom_${cleanBase}_${id.slice(0, 6)}`;
  const assetId = `font-${id}`;
  await registerFontBytes(family, bytes);
  const backend = await blobStore.put(assetId, bytes);
  const now = Date.now();
  const fontRec: CustomFontRecord = { id, family, assetId, format, size: bytes.byteLength, sha256, createdAt: now };
  await repo.saveCustomFont(fontRec, {
    id: assetId,
    kind: 'font',
    name: file.name,
    mimeType: format === 'otf' ? 'font/otf' : 'font/ttf',
    size: bytes.byteLength,
    sha256,
    backend,
    createdAt: now,
  });
  return fontRec;
}
