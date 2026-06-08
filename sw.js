/* HealthIQ Service Worker — shell cache + stale-while-revalidate
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
const VERSION = 'hiq-v1.6.31';
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
