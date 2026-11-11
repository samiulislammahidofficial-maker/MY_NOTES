# My Notes — Vercel Hosting & 2,000-User Capacity Analysis

- **Verification Date**: `2026-11-12`
- **Source of Measured Asset Sizes**: [`docs/APP_SIZE_REPORT.md`](file:///e:/My_Notes/docs/APP_SIZE_REPORT.md) (`npm.cmd run size-report` on commit `main`)
- **Official Vercel Documentation References**:
  - Vercel Hobby Plan Limits: https://vercel.com/docs/plans/hobby
  - Vercel Pricing & Usage Allowances: https://vercel.com/pricing
  - Managing Builds & Concurrent Build Slots: https://vercel.com/docs/builds/managing-builds

---

## 1. Architecture & Why Local-First Handwriting Does Not Load the Server

**My Notes** is a **100% static, client-side, local-first PWA**:
- **Zero Backend Functions on the Drawing Path**: There are **no** Vercel Serverless or Edge Functions (`api/*`) in this repository. Pointer capture (`pointerdown` / `pointermove` / `getCoalescedEvents()`), `perfect-freehand` stroke outline generation, `Undo`/`Redo`, and `Dexie.js` (`IndexedDB`) + `OPFS` persistence run **entirely on the user's tablet/browser**.
- **Handwriting Concurrency != Server Compute Concurrency**: Once the static assets are cached by the browser's Service Worker, **2,000 users writing simultaneously with Apple Pencil or S-Pen generate `0` requests and `0 B` of bandwidth to Vercel**.
- **Where Server Traffic Actually Happens**:
  1. Initial cold-cache download of the app shell + Service Worker precache (`2.114 MB` Gzip / `1.900 MB` Brotli across `17` requests).
  2. Optional playback or offline save of the Welcome tutorial video (`3.380 MB` H.264 MP4 from Vercel CDN).
  3. Optional installation of the Offline Handwriting Pack (`5.277 MB` Gzip of `trocrWorker.js` + `ort-wasm.wasm` from Vercel CDN, plus ~`65.0 MB` of model weights from Hugging Face CDN `huggingface.co`).
  4. Tiny Service Worker update checks (`sw.js`, ~`1.1 KB`) on repeat visits and incremental app updates (~`0.147 MB` Gzip when a new deployment is published).
  5. Optional Vercel Web Analytics / Speed Insights beacons (`/_vercel/insights/*` and `/_vercel/speed-insights/*`, ~`1–2 KB` per pageview when online).

---

## 2. Measured Per-Action Network Transfer Breakdown

All figures below use the **actual measured production build sizes** from [`docs/APP_SIZE_REPORT.md`](file:///e:/My_Notes/docs/APP_SIZE_REPORT.md) (`1 MB = 1,000,000 bytes`, `1 GB = 1,000,000,000 bytes`):

| User Action | Vercel CDN Transfer (Gzip) | Vercel CDN Transfer (Brotli) | Vercel CDN Requests | External Host Transfer | External Host |
|---|---:|---:|---:|---:|---|
| **1. First Visit + Full Core Offline Install** | `2.114 MB` (`2,113,761 B`) | `1.900 MB` (`1,899,551 B`) | `17` requests | `0 MB` | None |
| **2. Warm Repeat Session (SW Cached)** | `0.002 MB` (~`1,620 B` `sw.js` check + analytics beacon) | `0.002 MB` | `2` requests | `0 MB` | None |
| **3. Tutorial Video Play / Offline Save** | `3.380 MB` (`3,379,502 B`) | `3.380 MB` | `1–3` requests (Range / full) | `0 MB` | None |
| **4. Install Offline Handwriting Pack (TrOCR)** | `5.277 MB` (`5,276,627 B` WASM + worker) | `3.179 MB` (`3,178,853 B`) | `2` requests | ~`65.000 MB` | Hugging Face CDN (`huggingface.co`) |
| **5. App Code Update (Version A -> B)** | `0.147 MB` (`146,920 B`) | `0.127 MB` | `4` requests | `0 MB` | None |
| **6. Opt-In Gemini OCR Call (BYOK)** | `0.000 MB` | `0.000 MB` | `0` requests | ~`0.045 MB` per crop | Google Gemini API (`generativelanguage.googleapis.com`) |

---

## 3. Measured Capacity Calculations for 2,000 Users

### A. Replacing Hypothetical Examples with Measured Totals (One-Time Cohort of 2,000 Users)

| Component (for 2,000 Users) | Measured Unit Size (Gzip) | 2,000 Users @ 100% Adoption | Realistic Adoption Assumption | Realistic Monthly Vercel Egress | External Host Egress (Hugging Face) |
|---|---:|---:|---:|---:|---:|
| **Core App + Offline SW Install** | `2.114 MB` | **`4.228 GB`** (`34,000` reqs) | `100%` of new users (`2,000`) | **`4.228 GB`** | `0 GB` |
| **Tutorial Video Full Download** | `3.380 MB` | **`6.759 GB`** (`4,000` reqs) | `60%` watch/save (`1,200`) + `15%` range retry overhead | **`4.664 GB`** | `0 GB` |
| **Offline Handwriting Pack (Vercel WASM + Worker)** | `5.277 MB` | **`10.553 GB`** (`4,000` reqs) | `35%` install HTR (`700`) | **`3.694 GB`** | — |
| **Offline Handwriting Pack (HF Model Weights)** | `65.000 MB` (external) | `0 GB` on Vercel (`130.0 GB` on HF) | `35%` install HTR (`700`) | `0 GB` on Vercel | ~**`45.500 GB`** on Hugging Face CDN |
| **2 App Updates / Month (`2,000` active devices)** | `0.147 MB` × 2 | **`0.588 GB`** (`16,000` reqs) | `80%` update twice (`1,600`) | **`0.470 GB`** | `0 GB` |
| **Combined Cohort Total** | — | **`22.128 GB` on Vercel** (+ `130.0 GB` on HF) | Realistic Mix | **`13.056 GB` on Vercel** | ~**`45.500 GB` on HF** |

> **Why Measured Vercel Egress Is 8× Lower Than the 180 GB Hypothetical**:
> 1. Excluding `ort-wasm` (`21.6 MB` raw / `5.05 MB` Gzip) from the automatic first-visit precache means users who do not install the handwriting pack only download **`2.114 MB` (Gzip)** for the entire core offline app.
> 2. Our local H.264 MP4 tutorial video is **`3.380 MB`** (rather than 20 MB), and it is excluded from automatic precache unless watched or saved.
> 3. The `65 MB` TrOCR model weights are fetched by Transformers.js from Hugging Face's CDN rather than Vercel's origin (note: external host bandwidth is subject to Hugging Face's own fair-use policies and availability).

---

### B. Distinguishing 2,000 Monthly vs. 2,000 Daily vs. 2,000 Simultaneous Users

*(Status: Spreadsheet traffic model based on measured build artifacts; high-volume concurrency is **unverified by live load testing**.)*

| User Metric Tier | Assumed Monthly Sessions & Cache Miss Rate | Estimated Monthly Vercel Fast Data Transfer (Gzip) | Estimated Monthly Vercel CDN Requests | Bottleneck / Risk Profile |
|---|---|---:|---:|---|
| **1. 2,000 Monthly Visitors** (`~67/day`, e.g., `1,500` new + `500` returning, `8` sessions/mo) | `1,500` cold installs + `15,000` warm sessions (`10%` cache eviction reload rate) + `50%` video + `30%` HTR | **~`12.9 GB / month`** (`22.1 GB` if 100% of all 2,000 users are brand-new and install both add-ons) | **~`68,000` requests / month** | Comfortably within standard static CDN allowances (`100 GB` Fast Data Transfer, `1,000,000` Edge Requests). |
| **2. 2,000 Daily Active Users (DAU)** (`~6,000–10,000 MAU`, `60,000` sessions/mo) | `3,000` new cold installs/mo + `15%` iOS/Android cache evictions (`9,000` re-fetches) + `3,500` video plays + `1,500` HTR installs + `4` updates/mo | **~`48.6 GB – 64.0 GB / month`** | **~`420,000` requests / month** | Fits within `100 GB` bandwidth if cache eviction stays `<= 15%`, but spikes if all 6,000+ users download the tutorial video and HTR pack in the same billing cycle (`~95+ GB`). |
| **3. 2,000 Simultaneous Users** (e.g., classroom/lecture hall burst at `t = 0`) | **Case A (Already Installed PWA)**: `2,000` tablets open My Notes offline/warm cache -> **~`4 MB` total** (`2,000` `sw.js` checks).<br>**Case B (2,000 Cold First-Time Installs + HTR + Video in 1 minute)**: `2,000 × 10.77 MB` = **`21.54 GB` burst** (`44,000` requests). | **`0.004 GB`** (warm) to **`21.54 GB`** (100% cold classroom burst with all add-ons) | `2,000` (warm) to `44,000` (cold burst) | Vercel's global Edge CDN serves static files without cold-starting serverless functions, so simultaneous handwriting is unaffected. However, 2,000 simultaneous downloads from a single school NAT IP to Hugging Face CDN may trigger third-party rate limits. |

---

## 4. Official Vercel Plan Allowances & Eligibility Notes

*(Verified against https://vercel.com/docs/plans/hobby and https://vercel.com/pricing on `2026-11-12`. Do not hardcode pricing in app code.)*

1. **Personal / Non-Commercial Use (Hobby Plan)**:
   - Vercel Hobby is restricted to **personal, non-commercial** projects. If My Notes is monetized or operated commercially, Vercel requires a **Pro** plan regardless of bandwidth usage.
   - Typical Hobby baseline allowances include **100 GB Fast Data Transfer / month** and **1,000,000 Edge Requests / month** (with hard pauses if limits are exceeded).
   - **Web Analytics & Speed Insights**: Free tier includes limited event/datapoint quotas per month; once exceeded, additional analytics events are dropped cleanly without affecting the app or handwriting.
2. **Pro Plan Is Not "Unlimited"**:
   - Pro includes a higher baseline (typically **1 TB Fast Data Transfer** and **10,000,000 Edge Requests**), after which **usage-based overage charges apply**. Never assume Pro means unlimited free egress.
3. **Concurrent Builds Affect Deployment Queue, Not Handwriting**:
   - Vercel Hobby includes **1 concurrent build slot** (builds queue when pushing commits rapidly). Because My Notes is static in the browser, build concurrency has **zero impact** on simultaneous users writing notes.

---

## 5. Owner Instructions: Reviewing Vercel Usage & Spend Controls

1. **Check Real-Time Bandwidth & Request Usage**:
   - Open your **Vercel Dashboard** -> select the **MY_NOTES** project -> click **Usage** (or Account **Usage** in the top navigation).
   - Inspect **Fast Data Transfer** (bytes delivered by the CDN), **Edge Requests** (total HTTP requests), **Web Analytics**, and **Speed Insights**.
2. **Configure Spend Management / Notifications (Before Any Upgrade)**:
   - In **Account Settings -> Billing -> Spend Management**, set a budget alert (e.g., at `50%`, `75%`, and `100%` of included transfer) and enable a hard spend cap if you ever move to a paid plan.
3. **If Bandwidth Approaches Plan Limits**:
   - Before upgrading plans, you can host `public/tutorial/my-notes-tutorial.mp4` (`3.38 MB`) or the ONNX WASM file (`5.05 MB` Gzip) on an object store with zero-egress CDN (such as Cloudflare R2) if authorized.

---

## 6. Bounded Authorized Staging Load-Test Plan (Optional)

> **Policy**: Never run automated load tests against production or third-party model hosts (`huggingface.co` / `generativelanguage.googleapis.com`) without explicit written authorization.

If you wish to verify static CDN delivery under concurrency on a staging preview deployment:
- **Target**: Staging URL only (exclude Hugging Face model URLs and Gemini API).
- **Profile**: `50` virtual users ramping over `60 seconds` fetching `index.html`, `assets/index-*.js`, and `assets/index-*.css` with `Accept-Encoding: br, gzip` (`max 300 requests`, `< 50 MB` total transfer, `$0.00` cost on included allowance).
- **Success Criteria**: `100%` HTTP `200`/`304`, `Cache-Control: public, max-age=31536000, immutable` on hashed `/assets/*` files, and `p95 < 250 ms` CDN response time.
