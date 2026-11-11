import type { ImageBox, InkStroke, Notebook, Page, PasswordEnvelope, TextBox } from '../domain/types';
import { db, repo } from '../storage/db';

const PBKDF2_ITERATIONS = 120_000;

export interface EncryptedPagePayload {
  version: 1;
  strokes: Array<Omit<InkStroke, 'samples'> & { samples: number[] }>;
  texts: TextBox[];
  images?: ImageBox[];
}

export interface EncryptedNotebookPayload {
  version: 1;
  pages: Record<string, EncryptedPagePayload>;
  pageOrder?: string[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJsonPayload<T>(password: string, payload: T): Promise<PasswordEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, plaintext),
  );
  return {
    saltB64: bytesToBase64(salt),
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(ciphertext),
    updatedAt: Date.now(),
  };
}

export async function decryptJsonPayload<T>(password: string, envelope: PasswordEnvelope): Promise<T> {
  const salt = base64ToBytes(envelope.saltB64);
  const iv = base64ToBytes(envelope.ivB64);
  const ciphertext = base64ToBytes(envelope.ciphertextB64);
  const key = await deriveAesKey(password, salt);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
  } catch {
    throw new Error('Incorrect password.');
  }
  const json = new TextDecoder().decode(plainBuf);
  return JSON.parse(json) as T;
}

function serializeStrokes(strokes: InkStroke[]): Array<Omit<InkStroke, 'samples'> & { samples: number[] }> {
  return strokes.map((s) => ({
    ...s,
    samples: Array.from(s.samples),
  }));
}

function deserializeStrokes(raw: Array<Omit<InkStroke, 'samples'> & { samples: number[] }>): InkStroke[] {
  return raw.map((s) => ({
    ...s,
    samples: new Float32Array(s.samples),
  }));
}

/**
 * In-memory session map of currently unlocked passwords for active editing.
 * Never persisted to storage. Cleared on Lock Now or page reload.
 */
const sessionPasswords = new Map<string, string>();

export function isDocumentUnlockedInSession(docId: string): boolean {
  return sessionPasswords.has(docId);
}

export function getSessionPassword(docId: string): string | undefined {
  return sessionPasswords.get(docId);
}

export function clearSessionUnlock(docId: string): void {
  sessionPasswords.delete(docId);
}

/**
 * Encrypts all strokes & texts of a notebook into `notebook.passwordLock` and wipes
 * plaintext strokes & texts from IndexedDB so locked notebooks are genuinely encrypted at rest.
 */
export async function lockNotebookAtRest(
  notebook: Notebook,
  password: string,
  inMemoryStrokesByPage?: Record<string, InkStroke[]>,
  inMemoryTextsByPage?: Record<string, TextBox[]>,
  inMemoryImagesByPage?: Record<string, ImageBox[]>,
): Promise<PasswordEnvelope> {
  const pages = await repo.getPages(notebook.id);
  const orderedIds = notebook.pageIds?.length ? notebook.pageIds : pages.map((p) => p.id);
  const payload: EncryptedNotebookPayload = { version: 1, pages: {}, pageOrder: orderedIds };

  for (const p of pages) {
    const strokes = inMemoryStrokesByPage?.[p.id] ?? (await repo.getStrokes(p.id));
    const texts = inMemoryTextsByPage?.[p.id] ?? (await repo.getTexts(p.id));
    const images = inMemoryImagesByPage?.[p.id] ?? (await repo.getImages(p.id));
    payload.pages[p.id] = {
      version: 1,
      strokes: serializeStrokes(strokes),
      texts,
      images,
    };
  }

  const envelope = await encryptJsonPayload(password, payload);

  await db.transaction('rw', [db.notebooks, db.strokes, db.texts, db.images], async () => {
    for (const p of pages) {
      await db.strokes.where('pageId').equals(p.id).delete();
      await db.texts.where('pageId').equals(p.id).delete();
      await db.images.where('pageId').equals(p.id).delete();
    }
    await db.notebooks.update(notebook.id, {
      passwordLock: envelope,
      updatedAt: Date.now(),
    });
  });

  return envelope;
}

/**
 * Verifies the password for a protected notebook, decrypts its pages' strokes, texts and images
 * into memory, and marks it unlocked in the current session.
 */
export async function unlockNotebookToMemory(
  notebook: Notebook,
  password: string,
): Promise<{
  strokesByPage: Record<string, InkStroke[]>;
  textsByPage: Record<string, TextBox[]>;
  imagesByPage: Record<string, ImageBox[]>;
}> {
  if (!notebook.passwordLock) {
    throw new Error('This notebook does not have a password set.');
  }
  const payload = await decryptJsonPayload<EncryptedNotebookPayload>(password, notebook.passwordLock);
  const strokesByPage: Record<string, InkStroke[]> = {};
  const textsByPage: Record<string, TextBox[]> = {};
  const imagesByPage: Record<string, ImageBox[]> = {};

  const entries = Object.entries(payload.pages);
  const targetPageIds = notebook.pageIds ?? [];

  for (let i = 0; i < entries.length; i++) {
    const [origPageId, pageData] = entries[i];
    // If notebook was restored with remapped pageIds, map by pageOrder index or fallback to origPageId
    const mappedPageId =
      payload.pages[origPageId] && targetPageIds.includes(origPageId)
        ? origPageId
        : payload.pageOrder
          ? targetPageIds[payload.pageOrder.indexOf(origPageId)] ?? targetPageIds[i] ?? origPageId
          : targetPageIds[i] ?? origPageId;

    strokesByPage[mappedPageId] = deserializeStrokes(pageData.strokes ?? []).map((s) => ({
      ...s,
      pageId: mappedPageId,
    }));
    textsByPage[mappedPageId] = (pageData.texts ?? []).map((tb) => ({
      ...tb,
      pageId: mappedPageId,
    }));
    imagesByPage[mappedPageId] = (pageData.images ?? []).map((img) => ({
      ...img,
      pageId: mappedPageId,
    }));
  }

  sessionPasswords.set(notebook.id, password);
  return { strokesByPage, textsByPage, imagesByPage };
}

/**
 * Removes password protection from a notebook after verifying the current password,
 * restoring decrypted strokes, texts and images back to IndexedDB.
 */
export async function removeNotebookPassword(
  notebook: Notebook,
  currentPassword: string,
  inMemoryStrokesByPage?: Record<string, InkStroke[]>,
  inMemoryTextsByPage?: Record<string, TextBox[]>,
  inMemoryImagesByPage?: Record<string, ImageBox[]>,
): Promise<{
  strokesByPage: Record<string, InkStroke[]>;
  textsByPage: Record<string, TextBox[]>;
  imagesByPage: Record<string, ImageBox[]>;
}> {
  if (!notebook.passwordLock) {
    throw new Error('This notebook does not have a password set.');
  }
  const decrypted = await decryptJsonPayload<EncryptedNotebookPayload>(currentPassword, notebook.passwordLock);
  const strokesByPage: Record<string, InkStroke[]> = {};
  const textsByPage: Record<string, TextBox[]> = {};
  const imagesByPage: Record<string, ImageBox[]> = {};

  const pages = await repo.getPages(notebook.id);
  for (const p of pages) {
    const pageData = decrypted.pages[p.id];
    strokesByPage[p.id] = inMemoryStrokesByPage?.[p.id] ?? (pageData ? deserializeStrokes(pageData.strokes) : []);
    textsByPage[p.id] = inMemoryTextsByPage?.[p.id] ?? (pageData ? pageData.texts : []);
    imagesByPage[p.id] = inMemoryImagesByPage?.[p.id] ?? (pageData ? pageData.images ?? [] : []);
  }

  await db.transaction('rw', [db.notebooks, db.strokes, db.texts, db.images], async () => {
    for (const p of pages) {
      await db.strokes.where('pageId').equals(p.id).delete();
      await db.texts.where('pageId').equals(p.id).delete();
      await db.images.where('pageId').equals(p.id).delete();
      const s = strokesByPage[p.id] ?? [];
      const t = textsByPage[p.id] ?? [];
      const im = imagesByPage[p.id] ?? [];
      if (s.length) await db.strokes.bulkPut(s as never);
      if (t.length) await db.texts.bulkPut(t);
      if (im.length) await db.images.bulkPut(im);
    }
    await db.notebooks.update(notebook.id, {
      passwordLock: null,
      updatedAt: Date.now(),
    });
  });

  sessionPasswords.delete(notebook.id);
  return { strokesByPage, textsByPage, imagesByPage };
}

/**
 * Per-page optional password lock helpers
 */
export async function lockPageAtRest(
  page: Page,
  password: string,
  strokes: InkStroke[],
  texts: TextBox[],
  images?: ImageBox[],
): Promise<PasswordEnvelope> {
  const payload: EncryptedPagePayload = {
    version: 1,
    strokes: serializeStrokes(strokes),
    texts,
    images: images ?? [],
  };
  const envelope = await encryptJsonPayload(password, payload);
  await db.transaction('rw', [db.pages, db.strokes, db.texts, db.images], async () => {
    await db.strokes.where('pageId').equals(page.id).delete();
    await db.texts.where('pageId').equals(page.id).delete();
    await db.images.where('pageId').equals(page.id).delete();
    await db.pages.update(page.id, { passwordLock: envelope });
  });
  return envelope;
}

export async function unlockPageToMemory(
  page: Page,
  password: string,
): Promise<{ strokes: InkStroke[]; texts: TextBox[]; images: ImageBox[] }> {
  if (!page.passwordLock) {
    throw new Error('This page does not have a password set.');
  }
  const payload = await decryptJsonPayload<EncryptedPagePayload>(password, page.passwordLock);
  sessionPasswords.set(page.id, password);
  return {
    strokes: deserializeStrokes(payload.strokes ?? []),
    texts: payload.texts ?? [],
    images: payload.images ?? [],
  };
}

export async function removePagePassword(
  page: Page,
  currentPassword: string,
  inMemoryStrokes?: InkStroke[],
  inMemoryTexts?: TextBox[],
  inMemoryImages?: ImageBox[],
): Promise<{ strokes: InkStroke[]; texts: TextBox[]; images: ImageBox[] }> {
  if (!page.passwordLock) {
    throw new Error('This page does not have a password set.');
  }
  const payload = await decryptJsonPayload<EncryptedPagePayload>(currentPassword, page.passwordLock);
  const strokes = inMemoryStrokes ?? deserializeStrokes(payload.strokes ?? []);
  const texts = inMemoryTexts ?? (payload.texts ?? []);
  const images = inMemoryImages ?? (payload.images ?? []);

  await db.transaction('rw', [db.pages, db.strokes, db.texts, db.images], async () => {
    await db.strokes.where('pageId').equals(page.id).delete();
    await db.texts.where('pageId').equals(page.id).delete();
    await db.images.where('pageId').equals(page.id).delete();
    if (strokes.length) await db.strokes.bulkPut(strokes as never);
    if (texts.length) await db.texts.bulkPut(texts);
    if (images.length) await db.images.bulkPut(images);
    await db.pages.update(page.id, { passwordLock: null });
  });
  sessionPasswords.delete(page.id);
  return { strokes, texts, images };
}
