# My Notes — Free Local-First Offline Tablet Notebook PWA

**My Notes** is a 100% free, local-first, offline-capable tablet handwriting and personal notebook Progressive Web App (PWA) for iPadOS, iOS, Android tablets, and desktop browsers.

Made by **Md samiul Islam** (`samiulmahid.imp@gmail.com`).

## Key Features
- **100% Free & Local-First Storage**: All notebooks, pages, layers, vector ink strokes, custom `.ttf`/`.otf` fonts, custom cover photos, and imported PDFs are stored locally on your device using `IndexedDB` (`Dexie.js`) and the Origin Private File System (`OPFS`).
- **High-Precision Stylus Engine**: Supports `PointerEvent.getCoalescedEvents()`, Apple Pencil & S-Pen pressure, palm rejection (`penOnly` mode), Ballpoint / Fountain / Brush nibs, Solid / Dashed / Dotted stroke styles, Rainbow Pen, Highlighter, Scribble-to-Erase, Draw-and-Hold Shape Snapping, Draggable Ruler, and a Magnified Writing Window.
- **Custom Style & Color Wheel Popover**: Interactive 4-tab popover (`Grid`, `Wheel`, `Palettes`, `Style`) with millimeter dot presets (`0.35mm`–`5.0mm`), continuous slider, HSV color wheel + saturation/brightness square, eyedropper, and customizable preset chips.
- **Custom Notebook Covers**: Choose from classic spine-banded covers, paper-only covers, or upload your own photo as a custom notebook cover.
- **Handwriting-to-Text & Custom Fonts**: Select handwriting with the Lasso tool, convert ink to editable text (with an optional offline `Xenova/trocr-small-handwritten` neural pack or opt-in BYOK Gemini), render LaTeX math via `KaTeX`, and apply built-in or user-imported `.ttf`/`.otf` fonts.
- **Simple Optional Password Protection**: Protect any individual notebook or page from the three-dot menu (`Set Password`, `Change Password`, `Remove Password`, `Lock Now`) backed by Web Crypto `PBKDF2` + `AES-GCM` (256-bit) local encryption. Unprotected notebooks open normally.
- **PDF Import/Export & Full `.tabletnotes.zip` Backups**: Import PDFs or scanned images to annotate, export vector PDFs with embedded custom fonts, and create or restore complete `.tabletnotes.zip` archives.

## Commands

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run unit tests
npm test

# Type-check and build production offline PWA bundle
npm run typecheck
npm run build
```
