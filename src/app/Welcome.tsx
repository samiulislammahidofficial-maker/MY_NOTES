import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ExternalLink,
  Mail,
  PenTool,
  Play,
  RefreshCw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { actions, useApp } from './store';

const STORYBOARD_SCENES = [
  {
    time: '0:00 – 0:06',
    title: 'My Notes — Free Offline Tablet Notebook',
    desc: 'Introduces My Notes, a 100% free, local-first notebook app for iPad, Android tablets, and desktop browsers.',
  },
  {
    time: '0:06 – 0:22',
    title: 'Installing on iOS & iPadOS (Safari)',
    desc: 'Open My Notes in Safari, tap the Share button in the toolbar, choose "Add to Home Screen", and tap Add to launch it full-screen offline.',
  },
  {
    time: '0:22 – 0:36',
    title: 'Installing on Android (Chrome)',
    desc: 'Open My Notes in Chrome, tap the three-dot browser menu, and choose "Add to Home screen" or "Install app" for standalone offline access.',
  },
  {
    time: '0:36 – 0:52',
    title: 'Creating a Notebook, Custom Cover & Writing with Pens',
    desc: 'Create a custom notebook (dark, ruled, grid, dotted, or custom cover photo), write with Ballpoint, Fountain, Brush, or Highlighter, and pick custom stroke styles and HSV wheel colors.',
  },
  {
    time: '0:52 – 1:06',
    title: 'Lasso Selection, Handwriting-to-Text & Custom Fonts',
    desc: 'Select handwritten notes with the Lasso tool, convert ink to editable text (using the instant geometric estimate or after downloading the offline TrOCR pack), and apply built-in or imported .TTF/.OTF fonts.',
  },
  {
    time: '1:06 – 1:18',
    title: 'Optional Per-Notebook & Per-Page Password Lock',
    desc: 'Protect an individual notebook or page from the three-dot menu (Set Password). Protected items require their password to open, while unprotected notebooks open normally.',
  },
  {
    time: '1:18 – 1:30',
    title: 'Offline Storage, PDF Export & Full Backup',
    desc: 'All notes stay in local device storage (IndexedDB + OPFS). Export vector PDFs or full .tabletnotes.zip backups anytime to keep your notes safe.',
  },
];

export function Welcome() {
  const anchor = useApp((s) => s.welcomeAnchor);
  const videoRef = useRef<HTMLVideoElement>(null);
  const howRef = useRef<HTMLElement>(null);
  const aboutRef = useRef<HTMLElement>(null);

  const [platformTab, setPlatformTab] = useState<'ios' | 'android'>('ios');
  const [videoError, setVideoError] = useState(false);
  const [videoReloadKey, setVideoReloadKey] = useState(0);
  const [videoDuration, setVideoDuration] = useState('~1m 24s');

  useEffect(() => {
    if (anchor === 'how-it-works') {
      howRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (anchor === 'about-us') {
      aboutRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [anchor]);

  // Check if tutorial video is already cached for offline viewing


  const handleWatchDemo = () => {
    howRef.current?.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => {
      videoRef.current?.focus();
      videoRef.current?.play().catch(() => {
        /* user can click play manually */
      });
    }, 250);
  };

  return (
    <div className="welcome-page">
      {/* 1. Header */}
      <header className="welcome-header">
        <div className="welcome-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <span className="welcome-logo" aria-hidden>
            <BookOpen size={20} />
          </span>
          <span className="welcome-brand-name">My Notes</span>
        </div>
        <nav className="welcome-nav" aria-label="Welcome navigation">
          <a
            href="#how-it-works"
            onClick={(e) => {
              e.preventDefault();
              howRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            How It Works
          </a>
          <a
            href="#about-us"
            onClick={(e) => {
              e.preventDefault();
              aboutRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            About Us
          </a>
          <button type="button" className="nn-create welcome-open-btn" onClick={() => actions.openLibrary()}>
            Open My Notes
          </button>
        </nav>
      </header>

      <main className="welcome-main">
        {/* 2. Compact Hero */}
        <section className="welcome-hero" aria-labelledby="hero-heading">
          <div className="welcome-badge">100% Free • Local-First • Offline Tablet PWA</div>
          <h1 id="hero-heading">My Notes</h1>
          <p className="welcome-lead">
            A calm, high-precision handwriting and personal notebook workspace for iPad, Android tablets, and desktop.
            Write naturally with Apple Pencil or S-Pen, customize pens and covers, convert handwriting to font text, and
            keep every note stored privately on your own device.
          </p>
          <div className="welcome-hero-actions">
            <button type="button" className="nn-create welcome-cta-primary" onClick={() => actions.openLibrary()}>
              <BookOpen size={18} /> Open My Notes
            </button>
            <button type="button" className="chip welcome-cta-secondary" onClick={handleWatchDemo}>
              <Play size={16} /> Watch Demo
            </button>
          </div>
        </section>

        {/* 3. How it works on iOS & Android */}
        <section id="how-it-works" ref={howRef} className="welcome-section" aria-labelledby="how-heading">
          <div className="welcome-section-head">
            <h2 id="how-heading">How it works on iOS &amp; Android</h2>
            <p>
              Watch the walkthrough of the real My Notes workspace below, or read the step-by-step installation guide
              for your tablet.
            </p>
          </div>

          <div className="welcome-video-card">
            <div className="welcome-video-frame">
              <video
                key={videoReloadKey}
                ref={videoRef}
                className="welcome-video"
                controls
                controlsList="nodownload"
                onContextMenu={(e) => e.preventDefault()}
                playsInline
                preload="metadata"
                poster="/tutorial/poster.png"
                aria-label="My Notes tutorial walkthrough video"
                onError={() => setVideoError(true)}
                onLoadedData={() => setVideoError(false)}
                onLoadedMetadata={(e) => {
                  const dur = e.currentTarget.duration;
                  if (dur && Number.isFinite(dur)) {
                    const mins = Math.floor(dur / 60);
                    const secs = Math.floor(dur % 60);
                    setVideoDuration(`${mins}m ${secs.toString().padStart(2, '0')}s`);
                  }
                }}
              >
                <source src="/tutorial/my-notes-tutorial.mp4" type="video/mp4" />
                <track
                  kind="captions"
                  src="/tutorial/captions.en.vtt"
                  srcLang="en"
                  label="English"
                  default
                />
                <track kind="captions" src="/tutorial/captions.bn.vtt" srcLang="bn" label="বাংলা (Bangla)" />
                Your browser does not support HTML5 video. Use the written step-by-step guide below.
              </video>
            </div>

            {videoError && (
              <div className="welcome-video-fallback" role="alert">
                <p>
                  The tutorial video could not be loaded right now. You can retry loading the video or follow the full
                  written installation and feature guide below.
                </p>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    setVideoError(false);
                    setVideoReloadKey((k) => k + 1);
                  }}
                >
                  <RefreshCw size={15} /> Retry Video
                </button>
              </div>
            )}

            <div className="welcome-video-bar">
              <div className="welcome-video-meta">
                <span>Duration: {videoDuration} • Captions: English &amp; বাংলা</span>
              </div>
            </div>
          </div>

          {/* Platform-specific installation tabs & written cards */}
          <div className="welcome-platform-tabs" role="tablist" aria-label="Platform installation guides">
            <button
              type="button"
              role="tab"
              aria-selected={platformTab === 'ios'}
              className={`welcome-plat-tab ${platformTab === 'ios' ? 'on' : ''}`}
              onClick={() => setPlatformTab('ios')}
            >
              <Tablet size={16} /> iOS &amp; iPadOS (Safari)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={platformTab === 'android'}
              className={`welcome-plat-tab ${platformTab === 'android' ? 'on' : ''}`}
              onClick={() => setPlatformTab('android')}
            >
              <Smartphone size={16} /> Android Tablets &amp; Phones (Chrome)
            </button>
          </div>

          <div className="welcome-platform-grid">
            <article
              className={`welcome-plat-card ${platformTab === 'ios' ? 'highlight' : ''}`}
              aria-label="iOS and iPadOS installation steps"
            >
              <h3>
                <Tablet size={18} /> iOS &amp; iPadOS Installation
              </h3>
              <ol>
                <li>
                  Open <strong>My Notes</strong> in <strong>Safari</strong> on your iPad or iPhone (iOS/iPadOS does not
                  show an automatic install banner).
                </li>
                <li>
                  Tap the <strong>Share</strong> button (the square with an upward arrow) in the Safari address bar.
                </li>
                <li>
                  Scroll down the Share sheet and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
                </li>
                <li>
                  Launch <strong>My Notes</strong> from your Home Screen. It opens in full-screen standalone mode and
                  works offline. Use <strong>Export Backup (.tabletnotes.zip)</strong> regularly to protect against
                  browser storage resets.
                </li>
              </ol>
              <p
                style={{
                  marginTop: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--line)',
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: 'var(--text)',
                }}
              >
                If Apple Pencil strokes are skipped in My Notes, open iPad Settings → Apple Pencil → Scribble and turn
                Scribble off. Then reopen My Notes. You can still handwrite and draw with Apple Pencil.
                Handwriting-to-text in text fields is turned off.
              </p>
            </article>

            <article
              className={`welcome-plat-card ${platformTab === 'android' ? 'highlight' : ''}`}
              aria-label="Android installation steps"
            >
              <h3>
                <Smartphone size={18} /> Android Installation
              </h3>
              <ol>
                <li>
                  Open <strong>My Notes</strong> in <strong>Google Chrome</strong> (or Samsung Internet) on your Android
                  tablet or phone.
                </li>
                <li>
                  Tap the browser <strong>three-dot menu (⋮)</strong> in the top-right corner.
                </li>
                <li>
                  Tap <strong>Install app</strong> or <strong>Add to Home screen</strong> and confirm in the prompt.
                </li>
                <li>
                  Open <strong>My Notes</strong> from your app drawer or Home screen for full offline writing with S-Pen
                  or stylus support.
                </li>
              </ol>
            </article>
          </div>

          {/* Readable Transcript & Walkthrough Guide */}
          <details className="welcome-transcript">
            <summary>Read Full Walkthrough Transcript &amp; Feature Guide</summary>
            <div className="welcome-transcript-list">
              {STORYBOARD_SCENES.map((sc) => (
                <div key={sc.time} className="welcome-transcript-row">
                  <span className="welcome-transcript-time">{sc.time}</span>
                  <div>
                    <strong>{sc.title}</strong>
                    <p>{sc.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </section>

        {/* 4. About Us */}
        <section id="about-us" ref={aboutRef} className="welcome-section welcome-about" aria-labelledby="about-heading">
          <div className="welcome-about-card">
            <div className="welcome-about-icon" aria-hidden>
              <PenTool size={24} />
            </div>
            <h2 id="about-heading">About Us</h2>
            <p className="welcome-about-intro">
              My Notes is a simple place to write, organize and keep personal notes on your tablet or computer—100% free
              and stored locally on your device.
            </p>
            <div className="welcome-creator-box">
              <p className="welcome-creator-name">Made by Md samiul Islam</p>
              <a
                href="mailto:samiulmahid.imp@gmail.com"
                className="welcome-creator-email"
                aria-label="Send email to Md samiul Islam at samiulmahid.imp@gmail.com"
              >
                <Mail size={16} aria-hidden />
                <span>samiulmahid.imp@gmail.com</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* 5. Footer */}
      <footer className="welcome-footer">
        <span>Made by Md samiul Islam</span>
        <button type="button" className="welcome-footer-link" onClick={() => actions.openLibrary()}>
          Open My Notes <ExternalLink size={14} />
        </button>
      </footer>
    </div>
  );
}
