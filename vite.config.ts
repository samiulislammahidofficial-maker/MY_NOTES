import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function readBuildMetadata() {
  let pkgVersion = '0.1.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) pkgVersion = pkg.version;
  } catch {
    /* ignore */
  }
  let commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    } catch {
      commit = 'local';
    }
  }
  const builtAt = new Date().toISOString();
  const buildId = `v${pkgVersion} (${commit})`;
  return { pkgVersion, commit, builtAt, buildId };
}

const buildMeta = readBuildMetadata();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(buildMeta.pkgVersion),
    __APP_COMMIT__: JSON.stringify(buildMeta.commit),
    __APP_BUILD_ID__: JSON.stringify(buildMeta.buildId),
    __APP_BUILT_AT__: JSON.stringify(buildMeta.builtAt),
  },
  resolve: {
    alias: {
      '@vercel/analytics/next': '@vercel/analytics/react',
      '@vercel/speed-insights/next': '@vercel/speed-insights/react',
    },
  },
  plugins: [
    react(),
    {
      name: 'tutorial-writer-dev',
      configureServer(server) {
        server.middlewares.use('/__save_tutorial', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end('Method not allowed');
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(Buffer.from(c)));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                relPath: string;
                base64: string;
              };
              const safeRel = body.relPath.replace(/^[/\\]+/, '');
              if (safeRel.includes('..')) throw new Error('Invalid path');
              const outPath = path.resolve(process.cwd(), safeRel);
              fs.mkdirSync(path.dirname(outPath), { recursive: true });
              fs.writeFileSync(outPath, Buffer.from(body.base64, 'base64'));
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, bytes: Buffer.from(body.base64, 'base64').byteLength }));
            } catch (e) {
              res.statusCode = 500;
              res.end(String(e));
            }
          });
        });
      },
    },
    VitePWA({
      registerType: 'prompt',
      includeAssets: [
        'icons/icon-512.svg',
        'fonts/NotoSansBengali-Regular.ttf',
        'tutorial/poster.png',
        'tutorial/captions.en.vtt',
        'tutorial/captions.bn.vtt',
      ],
      manifest: {
        name: 'My Notes',
        short_name: 'My Notes',
        description: '100% Free, Local-First Offline Tablet Notebook PWA for iPad & Android',
        theme_color: '#151518',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-512.svg',
            sizes: '192x192 512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Keep the tutorial MP4 AND the 21.6 MB ONNX Runtime WASM out of critical first-visit precache!
        // Include pdf.worker.min.mjs in precache so offline PDF import/rendering works 100% offline.
        globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,vtt,ttf,webmanifest}'],
        globIgnores: ['**/tutorial/*.mp4', '**/ort-wasm*.wasm', '**/trocrWorker*.js'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [
          /\/assets\/.*/,
          /\/tutorial\/.*/,
          /\/icons\/.*/,
          /\/fonts\/.*/,
          /\/pen-input-test\.html$/,
          /\.(?:js|mjs|css|wasm|json|png|svg|mp4|vtt|ttf|zip)$/i,
        ],
        runtimeCaching: [
          {
            urlPattern: /\/tutorial\/.*\.(mp4|vtt|png)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'my-notes-tutorial-v1',
              rangeRequests: true,
            },
          },
          {
            urlPattern: /\/assets\/(ort-wasm.*|trocrWorker.*)\.(wasm|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'my-notes-htr-runtime-v1',
            },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          if (id.includes('pdf-lib') || id.includes('@pdf-lib/fontkit')) return 'pdflib';
          if (id.includes('katex')) return 'katex';
        },
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
