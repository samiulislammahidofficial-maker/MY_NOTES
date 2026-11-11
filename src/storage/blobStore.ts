import { db } from './db';

/** Compute SHA-256 hex digest of an ArrayBuffer or Uint8Array. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array
    ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    : bytes;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let opfsSupported: boolean | null = null;

async function getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (opfsSupported === false) return null;
  try {
    if (!navigator.storage?.getDirectory) {
      opfsSupported = false;
      return null;
    }
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('assets', { create: true });
    if (opfsSupported === null) {
      // Real write/read probe
      const probe = await dir.getFileHandle('.probe', { create: true });
      const w = await probe.createWritable();
      await w.write(new Uint8Array([1, 2, 3]));
      await w.close();
      const f = await probe.getFile();
      opfsSupported = f.size === 3;
      await dir.removeEntry('.probe').catch(() => {});
    }
    return opfsSupported ? dir : null;
  } catch {
    opfsSupported = false;
    return null;
  }
}

export const blobStore = {
  async put(id: string, bytes: Uint8Array): Promise<'opfs' | 'idb'> {
    const dir = await getOpfsDir();
    if (dir) {
      try {
        const tmpName = `${id}.staging`;
        const tmpFh = await dir.getFileHandle(tmpName, { create: true });
        const w = await tmpFh.createWritable();
        await w.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        await w.close();
        const verifyTmp = await tmpFh.getFile();
        if (verifyTmp.size === bytes.byteLength) {
          const fh = await dir.getFileHandle(id, { create: true });
          const wf = await fh.createWritable();
          await wf.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
          await wf.close();
          await dir.removeEntry(tmpName).catch(() => {});
          const verify = await fh.getFile();
          if (verify.size === bytes.byteLength) return 'opfs';
        }
      } catch {
        // Fall through to IndexedDB blob store
      }
    }
    await db.blobs.put({ id, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    return 'idb';
  },

  async sweepOrphans(referencedAssetIds: Set<string>): Promise<number> {
    let removed = 0;
    const dir = await getOpfsDir();
    if (dir && 'keys' in dir) {
      try {
        for await (const k of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (k === '.probe') continue;
          if (k.endsWith('.staging') || !referencedAssetIds.has(k)) {
            await dir.removeEntry(k).catch(() => {});
            removed++;
          }
        }
      } catch {
        // ignore
      }
    }
    const idbKeys = await db.blobs.toCollection().primaryKeys();
    for (const k of idbKeys) {
      if (!referencedAssetIds.has(String(k))) {
        await db.blobs.delete(String(k)).catch(() => {});
        removed++;
      }
    }
    return removed;
  },

  async get(id: string): Promise<Uint8Array | null> {
    const dir = await getOpfsDir();
    if (dir) {
      try {
        const fh = await dir.getFileHandle(id);
        const file = await fh.getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        // Check IDB fallback
      }
    }
    const row = await db.blobs.get(id);
    return row ? new Uint8Array(row.data) : null;
  },

  async delete(id: string): Promise<void> {
    const dir = await getOpfsDir();
    if (dir) await dir.removeEntry(id).catch(() => {});
    await db.blobs.delete(id).catch(() => {});
  },

  async list(): Promise<string[]> {
    const ids = new Set<string>(await db.blobs.toCollection().primaryKeys());
    const dir = await getOpfsDir();
    if (dir && 'keys' in dir) {
      try {
        for await (const k of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (k !== '.probe') ids.add(k);
        }
      } catch {
        // ignore
      }
    }
    return [...ids];
  },
};
