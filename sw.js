/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.37 — Triple code-audit bug-fix pass (no user-facing regressions, all
            three are latent bugs found during a deep code review).

   BUG 1 — Mobile watermark blank when user name contains a non-breaking space.
   ------------------------------------------------------------------------
   v1.6.35 introduced a single-element SVG-background watermark on mobile
   to fix the pinch-zoom OOM crash. The SVG content was built with the
   existing Utils.escapeHtml() helper, which uses the BROWSER'S HTML
   serializer (textContent setter → innerHTML getter). HTML serialization
   emits `&nbsp;` for U+00A0 (non-breaking space) — perfectly valid HTML,
   but `&nbsp;` is NOT a predefined XML entity. SVG parsers reject any
   unknown entity as a fatal well-formedness error, so the data-URI
   refused to render and mobile users whose names contained an nbsp
   (very common when a name is pasted from Word, a PDF, or an
   auto-formatted form) saw a BLANK watermark on mobile.

   Fix: buildWatermarkGrid's mobile branch now uses a local xmlEscape()
   that emits NUMERIC entities only (&#160; for U+00A0) plus strips
   zero-width spaces / BOM characters that can also break XML parsing.
   Desktop path unchanged.

   BUG 2 — Frozen watermark timestamp on iPhone Plus / Pro Max landscape.
   ------------------------------------------------------------------------
   The 60-second watermark-refresh interval inside openSecureViewer
   captured `_wmIntervalIsMobile = window.innerWidth < 700` ONCE at
   viewer-open time and then used that captured value for every tick.

   iPhone 14 Plus portrait is 428 px (mobile), landscape is 926 px
   (desktop) — the threshold IS crossed by a simple rotation. After
   rotating, the resize handler correctly rebuilds the watermark as a
   desktop DOM grid… but the interval kept the stale "mobile" value
   and skipped every subsequent rebuild. Result: desktop-style DOM
   watermark with a frozen timestamp until the viewer was closed and
   re-opened.

   Fix: read `window.innerWidth < 700` INSIDE the interval callback so
   the strategy follows the current viewport. Trivial change, was
   genuinely missed in v1.6.35.

   BUG 3 — Two stacked toasts on the 📧 Resend button.
   ------------------------------------------------------------------------
   v1.6.36's resendOrderEmail showed "Sending welcome email…" then
   immediately stacked the result toast on top. Both were visible for a
   few seconds, looking like the admin had double-clicked.

   Fix: capture the loading toast element, programmatically click its
   close button before showing the result. Uses the same dismiss path
   the user would (slide-out animation, then DOM removal) so it looks
   intentional, not glitchy.

   FILES CHANGED
   ------------------------------------------------------------------------
   * index.html
     - buildWatermarkGrid mobile branch: xmlEscape() helper
     - openSecureViewer interval: re-evaluates threshold per tick
     - resendOrderEmail: dismisses loading toast before result toast
     - APP_VERSION 1.6.36 → 1.6.37
   * sw.js
     - VERSION hiq-v1.6.36 → hiq-v1.6.37 (forces refresh)

   NO SQL changes. NO Edge Function changes.

   === CARRIED FORWARD FROM v1.6.36 ===============================
   v1.6.36 — Welcome-email diagnostics + auto-retry + Resend button.

   USER REPORT
   -----------
   "I approve from my laptop and it works fine. If I approve or decline
    from my PC I get: 'Payment approved ✓ — course unlocked, but welcome
    email failed: Edge Function returned a non-2xx status code'."

   ROOT CAUSE — diagnostic blackout in sendTransactionalEmail().
   ------------------------------------------------------------------------
   supabase-js's FunctionsHttpError class wraps every non-2xx response
   from an Edge Function and HARDCODES its `.message` property to the
   useless string "Edge Function returned a non-2xx status code". The
   ACTUAL server-side error (EAUTH 535, "Admin role required" with a
   debug.hint SQL fix, ETIMEDOUT, ECONNECTION, etc.) lives on
   `error.context` — a raw Response object the SDK never reads.

   The old client code only looked at `error.message`, so every email
   failure surfaced the same generic toast regardless of cause. Result:
   the admin had no way to tell whether the PC's profile.role was wrong,
   whether SMTP creds had rotated, whether it was a cold-start
   timeout, or anything else. The reason WHY the laptop succeeded and
   the PC didn't was effectively invisible.

   FIXES
   ------------------------------------------------------------------------
   (A) sendTransactionalEmail now reads the real Response body via
       `error.context.clone().json()` (with .text() fallback). The toast
       now shows e.g.:
         "HTTP 403 Admin role required — Your profile has role='student'.
          Run the SQL fix to set it to 'admin'."
         "HTTP 500 [EAUTH / SMTP 535] Invalid login: Username and
          Password not accepted."
         "HTTP 504 Gateway timeout (after 1 auto-retry)"
       — actionable, copy-pasteable, no DevTools required.

   (B) ONE silent auto-retry on transient errors (HTTP 5xx OR network
       failure with no status). Wait 1.5 s, try again. Edge Function
       cold starts (5–15 s) and Gmail SMTP socket flakes both succeed
       on the second attempt. The admin only sees the final outcome.

   (C) New 📧 Resend button on every COMPLETED and FAILED order in the
       admin Orders table. Calls a new resendOrderEmail() that re-fires
       JUST the welcome / decline email using data already on the order
       row — does NOT touch the order, enrollment, or in-app
       notification. Lets the admin recover from any one-off email
       failure without re-approving (which would trip the enrollments
       unique constraint).

   FILES CHANGED
   ------------------------------------------------------------------------
   * index.html
     - sendTransactionalEmail: extract real reason + auto-retry
     - renderOrderRows: 📧 Resend button on completed + failed rows
     - resendOrderEmail (NEW): admin-confirm + replay email
     - APP_VERSION 1.6.35 → 1.6.36
   * sw.js
     - VERSION hiq-v1.6.35 → hiq-v1.6.36 (forces refresh)

   NO SQL changes. NO Edge Function changes — the function already
   returns a rich JSON error body; we just finally read it.

   === CARRIED FORWARD FROM v1.6.35 ===============================
   v1.6.35 — Mobile zoom-crash fix + iOS Safari fullscreen fix.

   BUG A — "A problem repeatedly occurred on #courses" Chrome mobile crash.
   ------------------------------------------------------------------------
   Pinch-zooming a PDF past a certain threshold blew through Chrome's
   per-tab memory cap and triggered the OOM kill. Triple cause:
     (1) 189 absolutely-positioned watermark <span> elements all needing
         re-rasterisation at the new zoom level.
     (2) THREE simultaneous backdrop-filter layers (bar + panel + corner)
         — backdrop-filter must re-blur the underlying iframe at every
         paint, cost scales with zoom factor SQUARED.
     (3) The iframe rendering Drive's high-DPI PDF.
   Together: OOM → tab killed.

   Fixes (cut chrome memory ~80% on mobile):
     • Watermark on mobile now a SINGLE element with a CSS background-image
       SVG data-URI tile (360×180px, background-repeat:repeat). The DOM
       .pdf-watermark-tile grid is hidden via CSS. Same per-user stamp
       (name • email • timestamp • #shortId) at the same -26° angle — just
       composited as ONE GPU texture instead of 189 layout nodes.
     • backdrop-filter dropped on mobile from .pdf-viewer-bar /
       .pdf-display-panel / .pdf-secure-corner. Replaced with semi-opaque
       solid backgrounds (visually near-identical, zero re-blur cost).
     • contain: layout style paint on .pdf-viewer scopes paint regions
       so iframe redraws don't invalidate our chrome tree.
     • touch-action: manipulation on icon buttons removes iOS 300ms tap
       delay AND prevents the gesture-event flood that triggers extra
       layout passes during pinch-zoom.
     • iframe gets transform:translateZ(0) + will-change:transform on
       mobile, promoting it to its own compositor layer so pinch-zoom
       only rasterises ONE surface (the PDF) not the whole tree.
     • Mobile watermark refresh interval REMOVED inside Viewer.timer
       (SVG is set-once, scales for free). Desktop interval also slowed
       from 25s → 60s — minute-granular timestamp is what the watermark
       shows anyway.
     • window.resize listener now only rebuilds the watermark when the
       viewport crosses the desktop/mobile threshold (same-strategy
       rotates are no-ops).

   BUG B — "Fullscreen is not supported in this browser" on iOS.
   ------------------------------------------------------------------------
   iOS Safari (and iOS Chrome / iOS Edge, which are forced onto WebKit)
   does NOT expose requestFullscreen / webkitRequestFullscreen on non-
   video elements. Old code optimistically called req.call(el) → silent
   no-op → toast "Fullscreen is not supported in this browser". UX-hostile.

   Fix — pdfTogglePdfFullscreen now feature-detects FIRST:
     • Real-FS available (Chrome / Firefox / Edge desktop, Chrome Android)
       → toggle real FS, .catch() falls back to URL-bar collapse + toast.
     • Real-FS missing (iOS Safari / iOS Chrome / iOS Edge)
       → window.scrollTo(0,1) to collapse the URL bar + truthful toast:
           "📱 Already filling your screen. Rotate to landscape for the
            biggest reading area, or Add to Home Screen for true
            full-screen." (portrait variant)
           "📱 Already filling your screen. Add HealthIQ to your Home
            Screen for true full-screen mode." (landscape variant)
       Our viewer is already position:fixed inset:0 z-index:9000 so it
       genuinely IS full-screen apart from the browser chrome — and the
       manifest's display:standalone gives true OS-level full-screen
       once added to Home Screen.

   Pure index.html-only release (no SQL, no Edge Function, no migration changes).

   === CARRIED FORWARD FROM v1.6.34 ===============================
   v1.6.34 — Removed visible "View-Only" + "Watermarked" labels from
   the secure viewer UI per user request.
   * The two badges `👁 View-Only` and `💧 Watermarked` are removed from
     the top bar. The `🔒 DRM` badge stays — single clean trust indicator.
   * Loading splash sub-line "DRM · Watermark · View-only" → "End-to-end
     protected" (no banned words).
   * Secure-corner pill "Secure · watermarked" → "Secure session".
   * CSS cleanup: removed orphan .pdf-badge.view-only + .pdf-badge.wm
     rules; removed nth-child(2)/(3) entrance animations that no longer
     have any badges to animate.
   * Underlying SECURITY UNCHANGED: the per-user diagonal watermark
     overlay (name • email • timestamp • #id) is still rendered every
     25s. Drive's download chrome is still covered by all three
     blockers. CSS @media print, oncopy/dragstart/contextmenu, all
     keyboard guards, theme/brightness, milestones — all intact.
   Pure index.html-only release (no SQL, no Edge Function, no migration changes).

   === CARRIED FORWARD FROM v1.6.33 ===============================
   v1.6.33 — Removed the bottom-center "Live · Watermarked · Secure Session ·
   End-to-End Protected" info strip from the secure viewer per user request.
   The trust signal lives in the top bar (3 badges) and the bottom-left
   secure-corner pill, so the bottom strip was redundant chrome eating
   reading space. Removal is pure deletion — CSS block, the unused
   @keyframes pdfStripGradient, mobile media-query overrides, the
   reduced-motion selector entry, the HTML element, and the three JS
   dim/restore references all gone. Nothing else in the viewer pipeline
   touched.
   Pure index.html-only release (no SQL, no Edge Function, no migration changes).

   === CARRIED FORWARD FROM v1.6.32 (Super Elite foundation) ======
   v1.6.32 — SUPER ELITE PDF Viewer (themes, brightness, milestones, micro-UX).
   Pure index.html-only release (no SQL, no Edge Function, no migration changes).

   === SUPER ELITE UPGRADES (v1.6.32, additive on top of Elite) ===
   * Glassmorphic header bar (rgba bg + 22px backdrop-blur + 180% saturate)
     with a 1px gradient accent line (blue → emerald) at the bottom edge.
   * Title now renders with a 3-stop gradient text fill (white → sky → mint).
   * Staggered entrance animations on viewer open: title slides down (0 ms);
     badges fade-up at 100 / 180 / 260 ms; action group at 180 ms. Each
     badge also gets a continuous 4.5 s shimmer halo.
   * Buttons: cinematic 550 ms gradient sweep on hover + soft glow halo.
   * Loading splash gets a multi-ring "shield" spinner — 3 counter-rotating
     rings (blue / emerald / pink) around a pulsing 🛡️ core.
   * NEW: Display popover (🎨 icon in bar). Two sections:
       - Reading theme pills: ☀ Light · 📜 Sepia · 🌙 Dark
       - Brightness slider 40–100 % (gradient thumb + glow)
     Slides + scales in from the bar; outside click closes; ARIA labelled.
   * Theme system uses browser-composited CSS `filter` on the iframe element
     — works cross-origin against Drive WITHOUT touching its content.
     Stage background swaps in sync so letterbox / load areas don't flash
     white. Persisted via localStorage (hiq_pdf_theme + hiq_pdf_brightness).
   * Brightness overlay (z-index 6, above watermark, below blockers) dims
     uniformly across the entire reading surface.
   * Bottom-center info strip — glass pill with continuously animated gradient
     text "🛡️ Live · Watermarked · Secure · End-to-End Protected" (5.5s loop).
     Dims in step with focus-mode.
   * Secure-corner now also surfaces keyboard shortcuts (desktop only):
       Esc close · F screen · R reload · T theme
   * NEW single-key shortcuts (viewer open + target not editable):
       F → toggle fullscreen
       R → reload PDF
       T → cycle theme
   * Reading milestone toasts at 5 / 10 / 15 / 30 / 60 minutes — 🎯 ⭐ 🔥 🏆 👑
     with motivating copy. Reset per session.
   * Subtle 10 ms haptic feedback on button taps (mobile only; no-op
     where navigator.vibrate is absent).
   * @media (prefers-reduced-motion) honoured — shimmer / sweep / spin
     animations disabled for users with the accessibility setting.

   === CARRIED FORWARD FROM v1.6.31 (Elite foundation) ============
   v1.6.31 — Elite PDF Viewer + 30% lighter watermark + hardened security.
   Pure index.html-only release (no SQL, no Edge Function, no migration changes).

   === ELITE VIEWER UX ===========================================
   * Premium gradient bar with two-line layout: title above; meta + live
     reading-time chip + three security badges (DRM / View-Only /
     Watermarked) below. Two icon buttons (reload, fullscreen) +
     gradient close button on the right.
   * Loading splash with spinner + "Securing your document…" + sub-line,
     plus a slim shimmering gradient progress bar at the top of the
     stage. Both fade out 600ms after the iframe fires `load`.
   * Reading-time HUD updates every second (MM:SS, monospace, badge-style).
   * Focus mode: 5.5s of mouse / touch / keyboard inactivity dims the
     header + corner badge to 18% opacity. Any input restores them; CSS
     :hover on the bar also reveals it while dimmed.
   * Subtle "Secure session · watermarked" badge bottom-left with a
     pulsing emerald dot. Dimmable in step with focus mode.
   * Animated viewer fade-in (scale 0.985 → 1, 350ms cubic-bezier).
   * Reload button re-arms the same URL (about:blank → original) so
     transient Drive errors can be recovered without closing the viewer.
   * Fullscreen button uses native Fullscreen API with Safari/MS prefixes.
   * Escape now routes through closeSecureViewer (cleans every timer).

   === WATERMARK -30% DENSITY =====================================
   * CSS opacity 0.13 → 0.11; gap 90 → 110px; padding 26 → 32px.
   * JS desktop 36 rows × 12 = 432 spans → 25 × 12 = 300 spans (-30.5%).
   * JS mobile  30 rows × 9  = 270 spans → 21 × 9  = 189 spans (-30.0%).
   * Mobile CSS gap 60 → 75px; padding 22 → 28px.
   * Net effect: cleaner, more elegant reading surface; same per-user
     stamp (name • email • timestamp • #shortId) at the same -26° angle.

   === HARDENED SECURITY ==========================================
   * iframe sandbox dropped `allow-forms` — Drive preview doesn't need
     it, removal prevents any future hostile content from submitting a
     hidden download form.
   * Wider top-right pop-out blocker (140×56 → 160×62) to cover newer
     Drive toolbar variants that show an extra icon.
   * NEW bottom-right FAB blocker (84×84 desktop / 68×68 mobile)
     covering Drive's mobile floating download button.
   * Viewer root now also has ondragstart="return false" + oncopy="return
     false" alongside the existing oncontextmenu — drag-to-save and
     selection-copy are both rejected at the boundary.
   * Document-level copy/cut listener (while viewer open) shows a toast
     and preventDefault()s, in case anything escapes the inline handler.
   * window.beforeprint activates the black blocker AND a toast — fires
     even on OS-menu / browser-menu print (which bypasses keydown).
   * @media print CSS blanks the entire body and replaces it with
     "🔒 Printing is disabled for HealthIQ protected course content."
     Belt-and-braces alongside the beforeprint JS handler.
   * window.afterprint clears the blocker so the user can resume.
   * user-select / -webkit-user-select / -moz-user-select / -ms-user-select
     / -webkit-touch-callout all set to none on .pdf-viewer root —
     mobile long-press save-image / copy-text menus suppressed.

   === EXISTING DEFENSES (unchanged, still active) ================
   * Ctrl/Cmd + S / P / U → preventDefault + toast.
   * Ctrl/Cmd + Shift + I / J / C and F12 → preventDefault (dev-tools).
   * PrintScreen / Ctrl+Shift+S → black blocker overlay.
   * Drive `/preview?usp=embed_facebook&rm=minimal` strips Drive's own
     download/popout chrome at the URL level.
   * Per-user identifying watermark refreshed every 25s.
   * visibilitychange → logCourseView('blur') (audit trail).

   Carries forward from v1.6.30:
   * Notification action-button bug fixes (data-* delegation +
     showPaymentModal direct call).
   Carries forward from v1.6.29:
   * Rich toast + themed banner + pulsing avatar dot + tab title flash.
   Carries forward from v1.6.28:
   * Section 2c — drop legacy CHECK constraints generically.
   Carries forward from v1.6.27:
   * Section 2b — relax legacy NOT NULL columns.
   Carries forward from v1.6.26:
   * ALTER TABLE ADD COLUMN IF NOT EXISTS + NOTIFY pgrst reload.
   Carries forward from v1.6.25:
   * Realtime + 45s poll fallback + dual-admin RLS. */
const VERSION = 'hiq-v1.6.37';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(VERSION)
            .then(c => c.addAll(SHELL))
            // Do NOT call skipWaiting() here — let the page decide when to activate
            // so users don't lose unsaved form data mid-action. The page posts
            // { type: 'SKIP_WAITING' } when it's safe to swap.
            .catch(err => { /* shell install failed; SW still installs for runtime caching */ console.warn('[SW] shell precache failed:', err); })
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Allow the page to trigger immediate activation after the user confirms.
self.addEventListener('message', e => {
    if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch (_) { return; }

    // Never intercept non-http(s) schemes (chrome-extension:, data:, etc.)
    if (!/^https?:$/.test(url.protocol)) return;

    // Never cache live data / auth / 3rd-party services that must be fresh.
    if (
        url.hostname.includes('supabase.co') ||
        url.hostname.includes('supabase.in') ||
        url.hostname.includes('drive.google.com') ||
        url.hostname.includes('qrserver.com') ||
        url.hostname.includes('googleusercontent.com')
    ) return;

    // HTML: network-first (so updates are fast). Only cache successful, same-origin responses.
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        e.respondWith(
            fetch(req)
                .then(res => {
                    if (res && res.ok && res.type === 'basic') {
                        const copy = res.clone();
                        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
                    }
                    return res;
                })
                .catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
        );
        return;
    }

    // Other GET (fonts, CSS, JS, CDN): stale-while-revalidate.
    // Only cache successful basic/cors responses; skip opaque (status 0) and errors.
    e.respondWith(
        caches.match(req).then(cached => {
            const network = fetch(req)
                .then(res => {
                    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                        const copy = res.clone();
                        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
                    }
                    return res;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
