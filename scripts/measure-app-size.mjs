import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIST_DIR = path.resolve(process.cwd(), 'dist');

function walk(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function classify(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (relPath.endsWith('.map')) return 'Source Maps';
  if (relPath.includes('tutorial/') && ext === '.mp4') return 'Tutorial Video (MP4)';
  if (ext === '.wasm' || relPath.includes('Worker') || relPath.includes('worker')) return 'Workers & WASM';
  if (ext === '.js' || ext === '.mjs') return 'JavaScript';
  if (ext === '.css') return 'CSS';
  if (ext === '.ttf' || ext === '.otf' || ext === '.woff' || ext === '.woff2') return 'Fonts';
  if (ext === '.png' || ext === '.svg' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.ico') {
    return 'Images & Icons';
  }
  if (ext === '.vtt') return 'Captions (WebVTT)';
  return 'HTML & Manifest';
}

function fmtMB(bytes) {
  return (bytes / 1_000_000).toFixed(3) + ' MB';
}

function fmtMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(3) + ' MiB';
}

const files = walk(DIST_DIR).map((full) => {
  const rel = path.relative(DIST_DIR, full).replace(/\\/g, '/');
  const buf = fs.readFileSync(full);
  const rawBytes = buf.byteLength;
  const isAlreadyCompressed = /\.(mp4|png|woff2|jpg|jpeg|webp)$/i.test(rel);
  const gzipBytes = isAlreadyCompressed ? rawBytes : zlib.gzipSync(buf, { level: 9 }).byteLength;
  const brotliBytes = isAlreadyCompressed
    ? rawBytes
    : zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }).byteLength;
  return {
    rel,
    category: classify(rel),
    rawBytes,
    gzipBytes,
    brotliBytes,
  };
});

files.sort((a, b) => b.rawBytes - a.rawBytes);

const byCategory = {};
let totalRaw = 0;
let totalGzip = 0;
let totalBrotli = 0;

for (const f of files) {
  if (f.category === 'Source Maps') continue;
  totalRaw += f.rawBytes;
  totalGzip += f.gzipBytes;
  totalBrotli += f.brotliBytes;
  byCategory[f.category] ??= { count: 0, rawBytes: 0, gzipBytes: 0, brotliBytes: 0 };
  byCategory[f.category].count++;
  byCategory[f.category].rawBytes += f.rawBytes;
  byCategory[f.category].gzipBytes += f.gzipBytes;
  byCategory[f.category].brotliBytes += f.brotliBytes;
}

// Parse dist/sw.js precache manifest entries
let precacheEntries = [];
const swPath = path.join(DIST_DIR, 'sw.js');
if (fs.existsSync(swPath)) {
  const swText = fs.readFileSync(swPath, 'utf8');
  const matches = [...swText.matchAll(/url:\s*"([^"]+)"/g)];
  precacheEntries = matches.map((m) => m[1]);
}

const precacheFiles = files.filter((f) => precacheEntries.includes(f.rel));
const precacheRaw = precacheFiles.reduce((s, f) => s + f.rawBytes, 0);
const precacheGzip = precacheFiles.reduce((s, f) => s + f.gzipBytes, 0);

// Core initial entry (index.html + index-*.js + index-*.css + registerSW.js + manifest.webmanifest + icon-512.svg)
const firstLoadFiles = files.filter(
  (f) =>
    f.rel === 'index.html' ||
    f.rel === 'registerSW.js' ||
    f.rel === 'manifest.webmanifest' ||
    f.rel === 'icons/icon-512.svg' ||
    /^assets\/index-[^/]+\.(js|css)$/.test(f.rel),
);
const firstLoadRaw = firstLoadFiles.reduce((s, f) => s + f.rawBytes, 0);
const firstLoadGzip = firstLoadFiles.reduce((s, f) => s + f.gzipBytes, 0);

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    fileCount: files.length,
    rawBytes: totalRaw,
    rawDecimalMB: fmtMB(totalRaw),
    rawMiB: fmtMiB(totalRaw),
    gzipBytes: totalGzip,
    gzipDecimalMB: fmtMB(totalGzip),
    brotliBytes: totalBrotli,
    brotliDecimalMB: fmtMB(totalBrotli),
  },
  firstLoadCore: {
    fileCount: firstLoadFiles.length,
    files: firstLoadFiles.map((f) => f.rel),
    rawBytes: firstLoadRaw,
    rawDecimalMB: fmtMB(firstLoadRaw),
    gzipBytes: firstLoadGzip,
    gzipDecimalMB: fmtMB(firstLoadGzip),
  },
  serviceWorkerPrecache: {
    entryCount: precacheFiles.length,
    entries: precacheFiles.map((f) => f.rel),
    rawBytes: precacheRaw,
    rawDecimalMB: fmtMB(precacheRaw),
    gzipBytes: precacheGzip,
    gzipDecimalMB: fmtMB(precacheGzip),
  },
  byCategory,
  top10Largest: files.slice(0, 10),
  allFiles: files,
};

console.log(JSON.stringify(report, null, 2));
