# My Notes Tutorial Video Storyboard & Production Guide

## Overview
- **Output Video**: `public/tutorial/my-notes-tutorial.mp4` (H.264 MP4, 1280×720, 88 seconds, web-friendly `faststart` metadata)
- **Poster Image**: `public/tutorial/poster.png` (1280×720 PNG)
- **Captions**:
  - `public/tutorial/captions.en.vtt` (English WebVTT)
  - `public/tutorial/captions.bn.vtt` (Bangla WebVTT)
- **Generator Script**: `tutorial-src/generate-tutorial.mjs`

## Storyboard (88 Seconds)

| Time | Scene | Visual & Action | Caption Summary |
|---|---|---|---|
| `0:00 – 0:06` | **1. Title Card** | Original My Notes notebook emblem, app title, and subtitle ("100% Free • Local-First Offline Tablet Notebook"). | Welcome to My Notes — a 100% free, local-first offline notebook app for iPad, Android tablets, and desktop. |
| `0:06 – 0:22` | **2. iOS / iPadOS Installation Walkthrough** | Clearly labeled instructional walkthrough showing Safari address bar -> Share icon -> "Add to Home Screen" -> "Add". | On iOS and iPadOS, open My Notes in Safari, tap the Share button in the toolbar, choose Add to Home Screen, and tap Add. |
| `0:22 – 0:36` | **3. Android Installation Walkthrough** | Clearly labeled instructional walkthrough showing Chrome browser -> three-dot menu (`⋮`) -> "Install app" / "Add to Home screen". | On Android tablets and phones, open My Notes in Chrome, tap the three-dot menu, and choose Install app or Add to Home screen. |
| `0:36 – 0:52` | **4. Create Notebook, Custom Cover & Write** | Real captured My Notes UI: New Notebook modal (Cover/Paper templates, custom photo cover upload), writing handwritten strokes on dark paper, and opening the Custom Style & HSV Color Wheel popover. | Create a custom notebook with Blank, Ruled, Grid, or Dotted paper — or upload a custom photo cover — then write with custom pen styles and colors. |
| `0:52 – 1:06` | **5. Lasso Selection & Handwriting to Text** | Real captured My Notes UI: Lasso selection around handwritten strokes, opening "Handwriting to Font Text" modal, choosing font & size, and converting ink to text. | Use the Lasso tool to select handwriting, convert ink to editable font text (or download the offline TrOCR pack), and choose built-in or custom .TTF/.OTF fonts. |
| `1:06 – 1:18` | **6. Optional Password Protection** | Real captured My Notes UI: Three-dot menu -> Set Password modal with masked password fields, locked notebook badge on cover, and an unprotected notebook opening normally. | Optionally protect any individual notebook or page with a password from the three-dot menu. Unprotected notebooks continue to open normally. |
| `1:18 – 1:28` | **7. Offline Storage, Backup & Creator Credit** | Real captured My Notes UI: Persistent local storage status, PDF / `.tabletnotes.zip` backup export, and end card: `Made by Md samiul Islam` (`samiulmahid.imp@gmail.com`). | All notes stay stored locally on your device. Export vector PDFs or full .tabletnotes.zip backups anytime. Made by Md samiul Islam. |

## Rebuilding the Video
Run:
```bash
node tutorial-src/generate-tutorial.mjs
```
This script captures live screenshots of each real My Notes screen and modal (or uses the captured UI frames in `tutorial-src/frames/`) and encodes `public/tutorial/my-notes-tutorial.mp4` and `public/tutorial/poster.png`.
