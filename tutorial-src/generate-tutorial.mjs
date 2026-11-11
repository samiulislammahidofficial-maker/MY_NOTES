/**
 * Reproducible Tutorial Video Generator for My Notes
 * Produces:
 *   - public/tutorial/my-notes-tutorial.mp4 (H.264 MP4, 1280x720, 88s, faststart)
 *   - public/tutorial/poster.png (1280x720 PNG)
 *
 * Uses WebCodecs VideoEncoder ('avc1.42001f') + mp4-muxer in the browser environment
 * so no external cloud service or native binary install is required.
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const W = 1280;
const H = 720;
const FPS = 12;
const DURATION_S = 88;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawPointer(ctx, x, y, clicking = false) {
  ctx.save();
  if (clicking) {
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30, 136, 255, 0.32)';
    ctx.fill();
    ctx.strokeStyle = '#64D2FF';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#FEFB42';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#000000';
  ctx.stroke();
  ctx.restore();
}

function drawCaptionBanner(ctx, text, timeSec) {
  ctx.save();
  roundRect(ctx, 140, H - 68, W - 280, 48, 14);
  ctx.fillStyle = 'rgba(15, 15, 18, 0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H - 44);

  // Subtle progress bar at very bottom
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, H - 5, W, 5);
  ctx.fillStyle = '#1E88FF';
  ctx.fillRect(0, H - 5, (W * timeSec) / DURATION_S, 5);
  ctx.restore();
}

function drawLibraryShell(ctx, title = 'Notebooks') {
  // Background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // Sidebar
  ctx.fillStyle = '#151515';
  ctx.fillRect(0, 0, 260, H);
  ctx.strokeStyle = '#2C2C2E';
  ctx.beginPath();
  ctx.moveTo(260, 0);
  ctx.lineTo(260, H);
  ctx.stroke();

  // Brand
  ctx.fillStyle = '#0A84FF';
  roundRect(ctx, 22, 22, 28, 28, 7);
  ctx.fill();
  ctx.fillStyle = '#F2F2F2';
  ctx.font = '700 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('My Notes', 60, 42);

  // Nav rows
  const navItems = [
    { label: 'Notebooks', active: true, count: '' },
    { label: '  Untagged', active: false, count: '4' },
    { label: '  Unfiled', active: false, count: '4' },
    { label: '  Trashed', active: false, count: '0' },
    { label: 'Pinned', active: false, count: '' },
    { label: 'Export Backup', active: false, count: '' },
    { label: 'How It Works', active: false, count: '' },
    { label: 'About Us', active: false, count: '' },
  ];
  navItems.forEach((it, i) => {
    const y = 74 + i * 44;
    if (it.active) {
      ctx.fillStyle = '#3F3F3F';
      roundRect(ctx, 12, y, 236, 38, 19);
      ctx.fill();
    }
    ctx.fillStyle = it.active ? '#FFFFFF' : '#C8C8CE';
    ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(it.label, 28, y + 24);
    if (it.count) {
      ctx.fillStyle = '#8A8A8E';
      ctx.fillText(it.count, 224, y + 24);
    }
  });

  // Persistent storage badge
  ctx.fillStyle = '#30D158';
  ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('● Persistent storage granted', 22, H - 32);

  // Main Header
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(title, 300, 52);

  // Notebook cards
  const cards = [
    { title: 'Calculus II', color: '#385E51', locked: false, customPhoto: false },
    { title: 'Physics Lab', color: '#3560B0', locked: false, customPhoto: true },
    { title: 'Personal Journal', color: '#7A2E35', locked: true, customPhoto: false },
    { title: 'Dynamics', color: '#C8905A', locked: false, customPhoto: false },
  ];

  cards.forEach((c, idx) => {
    const x = 306 + idx * 210;
    const y = 96;
    roundRect(ctx, x, y, 142, 196, 8);
    if (c.customPhoto) {
      const grad = ctx.createLinearGradient(x, y, x + 142, y + 196);
      grad.addColorStop(0, '#1D4E89');
      grad.addColorStop(0.5, '#00B4D8');
      grad.addColorStop(1, '#90E0EF');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = c.color;
    }
    ctx.fill();

    // Spine band
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(x + 122, y, 8, 196);

    if (c.customPhoto) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, x + 10, y + 140, 96, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#FFF';
      ctx.font = '600 10px -apple-system, sans-serif';
      ctx.fillText('Custom Photo', x + 18, y + 155);
    }

    if (c.locked) {
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      roundRect(ctx, x + 10, y + 10, 68, 24, 12);
      ctx.fill();
      ctx.fillStyle = '#FEFB42';
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.fillText('🔒 Locked', x + 18, y + 26);
    }

    ctx.fillStyle = '#F2F2F2';
    ctx.font = '500 14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(c.title, x + 71, y + 220);
    ctx.textAlign = 'left';
  });
}

function drawEditorShell(ctx, progress = 1) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // Top bar
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, W, 52);
  ctx.fillStyle = '#0A84FF';
  ctx.font = '600 18px -apple-system, sans-serif';
  ctx.fillText('‹  Library', 18, 32);

  // Active tab
  ctx.fillStyle = '#3F3F3F';
  roundRect(ctx, 180, 8, 220, 36, 18);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '600 14px -apple-system, sans-serif';
  ctx.fillText('Calculus II — Lecture 4', 202, 31);

  ctx.fillStyle = '#30D158';
  ctx.font = '500 13px -apple-system, sans-serif';
  ctx.fillText('Saved locally', W - 210, 31);

  // Left tool rail
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 52, 56, H - 52);
  const tools = ['⊞', '✒', '🖍', '⌫', ' Lasso ', 'T', '✋', '✨', '△'];
  tools.forEach((lbl, i) => {
    const y = 66 + i * 44;
    if (i === 1) {
      ctx.fillStyle = 'rgba(10, 132, 255, 0.22)';
      roundRect(ctx, 6, y, 44, 38, 10);
      ctx.fill();
    }
    ctx.fillStyle = i === 1 ? '#0A84FF' : '#E5E5EA';
    ctx.font = '600 14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(lbl.trim(), 28, y + 24);
  });

  // Preset chips (.45 yellow, .50 white, .38 purple)
  const presets = [
    { label: '.45', color: '#FEFB42', active: true },
    { label: '.50', color: '#FFFFFF', active: false },
    { label: '.38', color: '#BD45E5', active: false },
  ];
  presets.forEach((p, i) => {
    const cy = H - 150 + i * 40;
    ctx.beginPath();
    ctx.arc(28, cy, 15, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    if (p.active) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#0A84FF';
      ctx.stroke();
    }
    ctx.fillStyle = '#000';
    ctx.font = '700 10px -apple-system, sans-serif';
    ctx.fillText(p.label, 28, cy + 4);
  });
  ctx.textAlign = 'left';

  // Handwritten strokes on dark canvas
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Line 1: yellow handwriting
  ctx.strokeStyle = '#FEFB42';
  ctx.lineWidth = 3.5;
  ctx.font = 'italic 600 32px Georgia, serif';
  ctx.fillStyle = '#FEFB42';
  if (progress > 0.15) {
    ctx.fillText('1) Handwriting to Font Text', 130, 150);
  }
  if (progress > 0.4) {
    ctx.fillStyle = '#64D2FF';
    ctx.fillText('2) Custom Pen Style & HSV Color Wheel', 130, 225);
  }
  if (progress > 0.65) {
    ctx.fillStyle = '#BD45E5';
    ctx.fillText('3) Optional Per-Notebook Password Lock', 130, 300);
  }
  ctx.restore();
}

export async function generateTutorialAssetsInBrowser() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Render frame helper for time t in [0, DURATION_S]
  const renderSceneAt = (t) => {
    ctx.clearRect(0, 0, W, H);

    if (t < 6) {
      // Scene 1: Title Card (0-6s)
      const grad = ctx.createRadialGradient(W / 2, H / 3, 40, W / 2, H / 2, 700);
      grad.addColorStop(0, '#1B2D48');
      grad.addColorStop(0.6, '#0E1015');
      grad.addColorStop(1, '#050507');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      // Notebook cover emblem
      roundRect(ctx, W / 2 - 58, 130, 116, 152, 12);
      ctx.fillStyle = '#385E51';
      ctx.fill();
      ctx.fillStyle = '#1E352D';
      ctx.fillRect(W / 2 + 38, 130, 10, 152);
      ctx.strokeStyle = '#FEFB42';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 34, 185);
      ctx.quadraticCurveTo(W / 2, 160, W / 2 + 24, 190);
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 52px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('My Notes', W / 2, 345);

      ctx.fillStyle = '#64D2FF';
      ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('100% Free • Local-First Offline Tablet Notebook PWA', W / 2, 390);

      ctx.fillStyle = '#A0A0A8';
      ctx.font = '400 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('For iPadOS, iOS, Android Tablets & Desktop Browsers', W / 2, 430);
      ctx.textAlign = 'left';

      drawCaptionBanner(
        ctx,
        'Welcome to My Notes — a 100% free, local-first offline notebook app for iPad, Android tablets, and desktop.',
        t,
      );
    } else if (t < 22) {
      // Scene 2: iOS / iPadOS Installation Walkthrough (6-22s)
      const p = (t - 6) / 16;
      ctx.fillStyle = '#0D0E12';
      ctx.fillRect(0, 0, W, H);

      // Clearly labeled instructional badge
      ctx.fillStyle = 'rgba(10, 132, 255, 0.18)';
      roundRect(ctx, 48, 28, 490, 36, 18);
      ctx.fill();
      ctx.fillStyle = '#64D2FF';
      ctx.font = '600 14px -apple-system, sans-serif';
      ctx.fillText('ILLUSTRATIVE INSTALLATION GUIDE • iOS & iPadOS (Safari)', 66, 51);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 30px -apple-system, sans-serif';
      ctx.fillText('Install My Notes on iPad & iPhone (Safari)', 48, 102);

      // Step cards on left
      const steps = [
        '1. Open My Notes in Safari on your iPad or iPhone.',
        '2. Tap the Share button (square with upward arrow) in the Safari toolbar.',
        '3. Scroll down and tap "Add to Home Screen", then tap "Add".',
        '4. Launch My Notes from your Home Screen — works 100% offline.',
      ];
      steps.forEach((st, idx) => {
        const active = p >= idx * 0.24;
        const y = 136 + idx * 96;
        roundRect(ctx, 48, y, 520, 80, 14);
        ctx.fillStyle = active ? '#1C2433' : '#151518';
        ctx.fill();
        ctx.strokeStyle = active ? '#1E88FF' : '#2C2C30';
        ctx.lineWidth = active ? 2 : 1;
        ctx.stroke();
        ctx.fillStyle = active ? '#FFFFFF' : '#8E8E93';
        ctx.font = '600 16px -apple-system, sans-serif';
        ctx.fillText(st, 68, y + 45);
      });

      // Simulated Safari browser toolbar + Share sheet diagram on right
      roundRect(ctx, 610, 110, 620, 480, 18);
      ctx.fillStyle = '#18181C';
      ctx.fill();
      ctx.strokeStyle = '#323238';
      ctx.stroke();

      // Safari top bar
      ctx.fillStyle = '#25252A';
      roundRect(ctx, 610, 110, 620, 54, 18);
      ctx.fill();
      ctx.fillStyle = '#E5E5EA';
      ctx.font = '500 14px -apple-system, sans-serif';
      ctx.fillText('🔒  mynotes.local', 840, 142);

      // Share button highlight
      roundRect(ctx, 1150, 120, 56, 34, 8);
      ctx.fillStyle = p > 0.2 ? '#1E88FF' : '#3A3A3E';
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('⬆ Share', 1156, 142);

      // Share sheet menu
      if (p > 0.35) {
        roundRect(ctx, 880, 174, 320, 220, 16);
        ctx.fillStyle = '#2C2C30';
        ctx.fill();
        ctx.strokeStyle = '#48484E';
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 15px -apple-system, sans-serif';
        ctx.fillText('My Notes — Offline Tablet PWA', 902, 210);

        roundRect(ctx, 896, 260, 288, 48, 10);
        ctx.fillStyle = p > 0.55 ? 'rgba(30, 136, 255, 0.3)' : '#3A3A3E';
        ctx.fill();
        ctx.strokeStyle = '#1E88FF';
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('➕  Add to Home Screen', 914, 290);

        drawPointer(ctx, 1040, 286, p > 0.6);
      } else {
        drawPointer(ctx, 1178, 137, p > 0.2);
      }

      drawCaptionBanner(
        ctx,
        'On iOS and iPadOS, open My Notes in Safari, tap Share, choose Add to Home Screen, and tap Add.',
        t,
      );
    } else if (t < 36) {
      // Scene 3: Android Installation Walkthrough (22-36s)
      const p = (t - 22) / 14;
      ctx.fillStyle = '#0D0E12';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = 'rgba(48, 209, 88, 0.16)';
      roundRect(ctx, 48, 28, 520, 36, 18);
      ctx.fill();
      ctx.fillStyle = '#30D158';
      ctx.font = '600 14px -apple-system, sans-serif';
      ctx.fillText('ILLUSTRATIVE INSTALLATION GUIDE • Android Tablets & Phones (Chrome)', 66, 51);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 30px -apple-system, sans-serif';
      ctx.fillText('Install My Notes on Android (Chrome)', 48, 102);

      const steps = [
        '1. Open My Notes in Google Chrome on your Android tablet or phone.',
        '2. Tap the three-dot menu (⋮) in the top-right corner of Chrome.',
        '3. Tap "Install app" or "Add to Home screen" and confirm.',
        '4. Open My Notes from your app drawer for full offline S-Pen & touch support.',
      ];
      steps.forEach((st, idx) => {
        const active = p >= idx * 0.24;
        const y = 136 + idx * 96;
        roundRect(ctx, 48, y, 520, 80, 14);
        ctx.fillStyle = active ? '#182B22' : '#151518';
        ctx.fill();
        ctx.strokeStyle = active ? '#30D158' : '#2C2C30';
        ctx.lineWidth = active ? 2 : 1;
        ctx.stroke();
        ctx.fillStyle = active ? '#FFFFFF' : '#8E8E93';
        ctx.font = '600 16px -apple-system, sans-serif';
        ctx.fillText(st, 68, y + 45);
      });

      // Simulated Chrome Android frame on right
      roundRect(ctx, 610, 110, 620, 480, 18);
      ctx.fillStyle = '#18181C';
      ctx.fill();
      ctx.strokeStyle = '#323238';
      ctx.stroke();

      ctx.fillStyle = '#25252A';
      roundRect(ctx, 610, 110, 620, 54, 18);
      ctx.fill();
      ctx.fillStyle = '#E5E5EA';
      ctx.font = '500 14px -apple-system, sans-serif';
      ctx.fillText('🔒  mynotes.local', 650, 142);

      // 3-dot button
      roundRect(ctx, 1176, 120, 40, 34, 8);
      ctx.fillStyle = '#3A3A3E';
      ctx.fill();
      ctx.fillStyle = '#FFF';
      ctx.fillText('⋮', 1192, 142);

      if (p > 0.3) {
        roundRect(ctx, 920, 170, 290, 210, 14);
        ctx.fillStyle = '#2C2C30';
        ctx.fill();
        ctx.strokeStyle = '#48484E';
        ctx.stroke();
        ctx.fillStyle = '#D1D1D6';
        ctx.font = '500 14px -apple-system, sans-serif';
        ctx.fillText('New tab', 944, 206);
        ctx.fillText('Bookmarks', 944, 240);

        roundRect(ctx, 932, 260, 266, 46, 10);
        ctx.fillStyle = 'rgba(48, 209, 88, 0.25)';
        ctx.fill();
        ctx.strokeStyle = '#30D158';
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 15px -apple-system, sans-serif';
        ctx.fillText('📲  Install app / Add to Home screen', 944, 288);
        drawPointer(ctx, 1060, 286, p > 0.55);
      } else {
        drawPointer(ctx, 1196, 137, true);
      }

      drawCaptionBanner(
        ctx,
        'On Android tablets and phones, tap the Chrome three-dot menu and choose Install app or Add to Home screen.',
        t,
      );
    } else if (t < 52) {
      // Scene 4: Create a Notebook, Custom Cover Photo & Write with Custom Style & Color Wheel (36-52s)
      const p = (t - 36) / 16;
      if (p < 0.42) {
        drawLibraryShell(ctx);
        // New Notebook modal overlay
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, 0, W, H);
        roundRect(ctx, 340, 84, 600, 520, 24);
        ctx.fillStyle = '#1F1F21';
        ctx.fill();
        ctx.strokeStyle = '#38383D';
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 18px -apple-system, sans-serif';
        ctx.fillText('New Notebook', 580, 120);

        roundRect(ctx, 844, 98, 80, 36, 18);
        ctx.fillStyle = '#0A84FF';
        ctx.fill();
        ctx.fillStyle = '#FFF';
        ctx.font = '600 14px -apple-system, sans-serif';
        ctx.fillText('Create', 862, 121);

        // Cover & Paper tabs + Upload Photo card
        ctx.fillStyle = '#D1D1D6';
        ctx.font = '600 14px -apple-system, sans-serif';
        ctx.fillText('Cover Style (Classic Colors or Upload Photo)', 372, 175);

        const covers = [
          { label: 'Upload Photo', color: '#2B3A4A' },
          { label: 'Classic 2', color: '#385E51' },
          { label: 'Classic 1', color: '#3560B0' },
          { label: 'Classic 3', color: '#C8905A' },
        ];
        covers.forEach((cv, i) => {
          const cx = 372 + i * 134;
          roundRect(ctx, cx, 195, 110, 148, 8);
          ctx.fillStyle = cv.color;
          ctx.fill();
          if (i === 0) {
            ctx.strokeStyle = '#0A84FF';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.fillStyle = '#64D2FF';
            ctx.font = '600 12px -apple-system, sans-serif';
            ctx.fillText('📷 Custom Photo', cx + 10, 270);
          }
          ctx.fillStyle = '#D1D1D6';
          ctx.font = '500 12px -apple-system, sans-serif';
          ctx.fillText(cv.label, cx + 20, 364);
        });

        ctx.fillStyle = '#D1D1D6';
        ctx.font = '600 14px -apple-system, sans-serif';
        ctx.fillText('Paper Template: Blank • Ruled • Grid • Dotted (12 Paper Colors)', 372, 415);
        drawPointer(ctx, 884, 116, p > 0.32);
      } else {
        drawEditorShell(ctx, (p - 0.42) / 0.58);
        // Show Custom Style & HSV Color Wheel Popover
        roundRect(ctx, 68, 96, 336, 480, 22);
        ctx.fillStyle = '#202022';
        ctx.fill();
        ctx.strokeStyle = '#38383E';
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 18px -apple-system, sans-serif';
        ctx.fillText('Custom Style & Color', 92, 134);

        // Size dots
        const sizes = ['0.35mm', '1.2mm', '1.9mm', '3.8mm', '5.0mm'];
        sizes.forEach((sz, idx) => {
          const sx = 94 + idx * 58;
          ctx.beginPath();
          ctx.arc(sx + 16, 175, 3 + idx * 2, 0, Math.PI * 2);
          ctx.fillStyle = idx === 1 ? '#1E88FF' : '#FFF';
          ctx.fill();
          ctx.fillStyle = '#A0A0A6';
          ctx.font = '500 11px -apple-system, sans-serif';
          ctx.fillText(sz, sx, 204);
        });

        // Pen circles (Ballpoint, Fountain, Brush)
        ['Ballpoint', 'Fountain', 'Brush'].forEach((pen, idx) => {
          const px = 114 + idx * 86;
          ctx.beginPath();
          ctx.arc(px, 268, 28, 0, Math.PI * 2);
          ctx.fillStyle = idx === 1 ? '#4AA3FF' : '#D8D8DC';
          ctx.fill();
          ctx.fillStyle = '#111';
          ctx.font = '600 11px -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(pen, px, 272);
          ctx.textAlign = 'left';
        });

        // Stroke styles (Solid, Dashed, Dotted)
        ['Solid', 'Dashed', 'Dotted', 'Rainbow'].forEach((st, idx) => {
          const bx = 88 + idx * 74;
          roundRect(ctx, bx, 326, 66, 44, 12);
          ctx.fillStyle = '#28282C';
          ctx.fill();
          ctx.strokeStyle = idx === 0 ? '#1E88FF' : '#3A3A3E';
          ctx.stroke();
          ctx.fillStyle = '#FFF';
          ctx.font = '500 11px -apple-system, sans-serif';
          ctx.fillText(st, bx + 12, 353);
        });

        // Segmented tabs (Grid | Wheel | Palettes | Style)
        roundRect(ctx, 86, 520, 300, 36, 18);
        ctx.fillStyle = '#2C2C30';
        ctx.fill();
        ['Grid', 'Wheel', 'Palettes', 'Style'].forEach((tb, idx) => {
          if (idx === 3) {
            roundRect(ctx, 88 + idx * 74, 523, 72, 30, 15);
            ctx.fillStyle = '#6C6C72';
            ctx.fill();
          }
          ctx.fillStyle = '#FFF';
          ctx.font = '600 12px -apple-system, sans-serif';
          ctx.fillText(tb, 106 + idx * 74, 542);
        });

        drawPointer(ctx, 200, 268, true);
      }

      drawCaptionBanner(
        ctx,
        'Create a custom notebook or photo cover, then write with Ballpoint, Fountain, or Brush pens and custom colors.',
        t,
      );
    } else if (t < 66) {
      // Scene 5: Select Handwriting, Convert to Font Text & Custom Fonts (52-66s)
      const p = (t - 52) / 14;
      drawEditorShell(ctx, 1);

      // Dashed lasso rectangle around stroke 1
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#0A84FF';
      ctx.lineWidth = 2;
      ctx.strokeRect(118, 114, 430, 52);
      ctx.restore();

      if (p > 0.3) {
        // Convert to Text Modal
        roundRect(ctx, 360, 120, 560, 430, 22);
        ctx.fillStyle = '#1F1F21';
        ctx.fill();
        ctx.strokeStyle = '#3A3A40';
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 18px -apple-system, sans-serif';
        ctx.fillText('Handwriting to Font Text', 390, 160);

        ctx.fillStyle = '#8A8A8E';
        ctx.font = '500 13px -apple-system, sans-serif';
        ctx.fillText(
          'Offline TrOCR pack (requires one-time download) + Custom .TTF/.OTF Font Support',
          390,
          192,
        );

        // Text box preview
        roundRect(ctx, 390, 212, 500, 84, 12);
        ctx.fillStyle = '#2C2C30';
        ctx.fill();
        ctx.fillStyle = '#FEFB42';
        ctx.font = '600 22px Georgia, serif';
        ctx.fillText('1) Handwriting to Font Text', 410, 262);

        // Font selector & Import .TTF/.OTF button
        roundRect(ctx, 390, 316, 260, 40, 10);
        ctx.fillStyle = '#2C2C30';
        ctx.fill();
        ctx.fillStyle = '#FFF';
        ctx.font = '500 14px -apple-system, sans-serif';
        ctx.fillText('Font: Editorial Serif (.TTF/.OTF) ▾', 406, 341);

        roundRect(ctx, 666, 316, 224, 40, 10);
        ctx.fillStyle = '#34343A';
        ctx.fill();
        ctx.fillStyle = '#64D2FF';
        ctx.fillText('⬆ Import .TTF / .OTF Font', 684, 341);

        // Replace Ink button
        roundRect(ctx, 670, 480, 220, 42, 21);
        ctx.fillStyle = '#0A84FF';
        ctx.fill();
        ctx.fillStyle = '#FFF';
        ctx.font = '600 14px -apple-system, sans-serif';
        ctx.fillText('Replace Ink with Text', 706, 506);

        drawPointer(ctx, 780, 500, p > 0.7);
      } else {
        drawPointer(ctx, 340, 140, true);
      }

      drawCaptionBanner(
        ctx,
        'Select handwriting with the Lasso tool, convert to editable text, and apply built-in or imported .TTF/.OTF fonts.',
        t,
      );
    } else if (t < 78) {
      // Scene 6: Optional Per-Notebook & Per-Page Password Protection (66-78s)
      const p = (t - 66) / 12;
      drawLibraryShell(ctx);

      // Show Set Password / Unlock Modal on Personal Journal while Calculus II stays unlocked
      roundRect(ctx, 430, 130, 420, 390, 22);
      ctx.fillStyle = '#1F1F21';
      ctx.fill();
      ctx.strokeStyle = '#38383E';
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 18px -apple-system, sans-serif';
      ctx.fillText('🔒 Set Password — Personal Journal', 460, 170);

      ctx.fillStyle = '#A0A0A8';
      ctx.font = '400 13px -apple-system, sans-serif';
      ctx.fillText('Protect Personal Journal with an optional password.', 460, 200);
      ctx.fillText('Other notebooks remain unlocked and open normally.', 460, 220);

      // Masked password inputs
      ctx.fillStyle = '#D1D1D6';
      ctx.font = '500 13px -apple-system, sans-serif';
      ctx.fillText('Password', 460, 256);
      roundRect(ctx, 460, 266, 360, 40, 10);
      ctx.fillStyle = '#2C2C30';
      ctx.fill();
      ctx.fillStyle = '#FFF';
      ctx.font = '700 18px monospace';
      ctx.fillText('••••••••••', 476, 292);

      ctx.fillStyle = '#D1D1D6';
      ctx.font = '500 13px -apple-system, sans-serif';
      ctx.fillText('Confirm Password', 460, 332);
      roundRect(ctx, 460, 342, 360, 40, 10);
      ctx.fillStyle = '#2C2C30';
      ctx.fill();
      ctx.fillStyle = '#FFF';
      ctx.font = '700 18px monospace';
      ctx.fillText('••••••••••', 476, 368);

      ctx.fillStyle = '#8A8A8E';
      ctx.font = '400 11px -apple-system, sans-serif';
      ctx.fillText('Encrypted locally (AES-GCM). Forgotten passwords cannot be recovered.', 460, 412);

      roundRect(ctx, 720, 446, 100, 38, 19);
      ctx.fillStyle = '#0A84FF';
      ctx.fill();
      ctx.fillStyle = '#FFF';
      ctx.font = '600 14px -apple-system, sans-serif';
      ctx.fillText('Done', 752, 470);

      drawPointer(ctx, 770, 465, p > 0.5);

      drawCaptionBanner(
        ctx,
        'Optionally protect any individual notebook or page with a password. Unprotected notebooks open normally.',
        t,
      );
    } else {
      // Scene 7: Offline Readiness, PDF/Backup Export & Creator Credit (78-88s)
      const grad = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, 700);
      grad.addColorStop(0, '#18283E');
      grad.addColorStop(1, '#08080B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      roundRect(ctx, 240, 96, 800, 470, 24);
      ctx.fillStyle = '#151518';
      ctx.fill();
      ctx.strokeStyle = '#2E2E34';
      ctx.stroke();

      ctx.fillStyle = '#30D158';
      ctx.font = '600 15px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✓ 100% Offline Ready • Local IndexedDB + OPFS Storage', W / 2, 150);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 32px -apple-system, sans-serif';
      ctx.fillText('Export Vector PDFs & Full .tabletnotes.zip Backups', W / 2, 205);

      ctx.fillStyle = '#B8B8BE';
      ctx.font = '400 17px -apple-system, sans-serif';
      ctx.fillText(
        'Keep your notes safe across browser resets by exporting portable backups anytime.',
        W / 2,
        248,
      );

      // Creator credit box
      roundRect(ctx, 390, 296, 500, 140, 18);
      ctx.fillStyle = '#1E1E24';
      ctx.fill();
      ctx.strokeStyle = '#1E88FF';
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 24px -apple-system, sans-serif';
      ctx.fillText('Made by Md samiul Islam', W / 2, 352);

      ctx.fillStyle = '#64D2FF';
      ctx.font = '600 18px -apple-system, sans-serif';
      ctx.fillText('samiulmahid.imp@gmail.com', W / 2, 395);

      ctx.textAlign = 'left';

      drawCaptionBanner(
        ctx,
        'All notes stay stored locally on your device. Export PDFs or .tabletnotes.zip backups anytime. Made by Md samiul Islam.',
        t,
      );
    }
  };

  // 1. Render poster.png (from Scene 1 Title Card)
  renderSceneAt(2.5);
  const posterDataUrl = canvas.toDataURL('image/png');
  const posterB64 = posterDataUrl.split(',')[1];

  // 2. Encode 88s H.264 MP4 using WebCodecs VideoEncoder + mp4-muxer
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: W,
      height: H,
    },
    fastStart: 'in-memory',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('VideoEncoder error:', e),
  });

  encoder.configure({
    codec: 'avc1.42001f',
    width: W,
    height: H,
    bitrate: 900_000,
    framerate: FPS,
  });

  const totalFrames = DURATION_S * FPS;
  for (let i = 0; i < totalFrames; i++) {
    const t = i / FPS;
    renderSceneAt(t);
    const timestampUs = Math.round(t * 1_000_000);
    const frame = new VideoFrame(canvas, { timestamp: timestampUs });
    encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
  }

  await encoder.flush();
  muxer.finalize();

  const mp4Bytes = new Uint8Array(target.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < mp4Bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...mp4Bytes.subarray(i, i + chunkSize));
  }
  const mp4B64 = btoa(binary);

  const saveRes = await fetch('/__save_tutorial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relPath: 'public/tutorial/my-notes-tutorial.mp4', base64: mp4B64 }),
  });
  await fetch('/__save_tutorial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relPath: 'public/tutorial/poster.png', base64: posterB64 }),
  });
  return await saveRes.json();
}
