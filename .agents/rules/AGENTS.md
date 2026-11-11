# Project Rules & Architecture: Offline Tablet Notebook PWA (iPad & Android)

## 1. 100% Free & Local-First Storage
- All user notebooks, vector ink strokes, custom `.ttf`/`.otf` fonts, and PDFs **MUST** be stored locally on the tablet using `IndexedDB` (`Dexie.js`) and Origin Private File System (OPFS).
- On application startup, invoke `navigator.storage.persist()` to ensure persistent storage grant, preventing iPad Safari / WebKit from evicting local data under storage pressure.

## 2. 100% Offline PWA
- Configure `vite-plugin-pwa` with a comprehensive Service Worker caching strategy and Web App Manifest (`manifest.json` configured with `"display": "standalone"`).
- Ensure the app installs seamlessly on iPad (Safari Add to Home Screen) and Android (Chrome PWA install prompt) without requiring an app store or APK, remaining 100% functional without an active network connection.

## 3. High-Precision Stylus Engine
- Utilize HTML5 `<canvas>` with Pointer Events (`pointerdown`, `pointermove`, `pointerup`).
- Leverage `event.getCoalescedEvents()` for high-frequency sub-pixel stroke capture.
- Support Apple Pencil and Samsung S-Pen hardware capabilities:
  - Pressure sensitivity (`event.pressure`)
  - Stylus tilt angles (`event.tiltX`, `event.tiltY`)
  - Robust palm rejection (`event.pointerType === 'pen'` vs `'touch'`).

## 4. Handwriting-to-Text (updated to follow SPEC.md, user-approved)
- Primary engine: offline local handwriting model (`Xenova/trocr-small-handwritten` via Transformers.js in a worker). Never blocks the canvas.
- Gemini is an optional, off-by-default, opt-in provider using the user's own key (never in source/VITE_*). Configurable model ID; no automatic local-to-cloud fallback. Within the opt-in provider, a waterfall on HTTP 429/503 may go `gemini-2.5-flash` -> `gemini-2.5-flash-lite` -> `gemini-2.0-flash`.
- `Tesseract.js` is for printed-document OCR only and must not silently replace the handwriting engine.
- Failures never lose ink; originals are always recoverable.

## 5. Always Verify
- Use the `context7` MCP server to inspect up-to-date documentation and best practices for core dependencies (`pdfjs-dist`, `dexie`, `tesseract.js`, `vite-plugin-pwa`).
- Use the `chrome-devtools` MCP server to inspect execution, layout, and verify zero console errors during test runs.
