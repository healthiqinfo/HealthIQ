/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.29 — Notification UI/UX polish. No schema or backend changes.
   * Goal: now that the v1.6.22-v1.6.28 notification pipeline actually
     works (Edge Function + Realtime + RLS + idempotent migration), the
     visible surface deserved the same level of attention. The in-menu
     banner was using a 60-line inline-styled template literal with
     hardcoded hex colors that ignored dark mode entirely. The toast
     was a plain one-liner with an emoji. The avatar dot was a static
     red circle that just appeared. v1.6.29 modernises all of it.
   * Changes (index.html only — no SQL / no Edge Function changes):
     1. NEW CSS classes for the in-menu notification banner —
        .notif-banner, .notif-banner-header, .notif-banner-title,
        .notif-banner-clear, .notif-banner-more, .notif-item (+ three
        modifiers .is-decline / .is-approve / .is-info), .notif-item-
        icon / -body / -title / -text / -meta / -actions / -btn. All
        colors come from CSS vars so light / dark / OLED themes all
        just work. Each card has a stagger fade-in via --i so the
        dropdown feels alive without being noisy. Animation respects
        prefers-reduced-motion.
     2. NEW .user-avatar-dot CSS class (was inline styles) with a
        pop-in entrance and an opt-in .is-pulsing modifier that runs
        a two-iteration box-shadow ring pulse for ~2.4s when a fresh
        notification arrives. Pure CSS keyframes, no JS animation loop.
     3. NEW showRichToast({ icon, title, body, meta, actions, duration })
        helper that reuses the .toast chassis (so it inherits the
        slide-in animation, dark-mode styling, dismiss button, and
        progress bar) but adds an icon avatar, bold title, body line,
        small meta line, and a row of inline action buttons. Used
        from announceNotificationToast so the student now sees:
          "Payment confirmed — course unlocked! \u{1F389}
           Pharmacology — \u20B92,499 confirmed
           just now
           [Open My Courses] [Dismiss]"
        instead of the old "\u{1F389} <title>" one-liner.
     4. NEW formatRelativeTime(ts) — "just now" / "5m ago" / "3h ago"
        / "yesterday" / "4d ago" / formatted date. Used by both the
        banner and the rich toast.
     5. NEW tab-title flash — when a notification arrives while the
        tab is hidden (document.visibilityState === 'hidden'), we
        prepend "\u{1F514} (N) " to the page title and alternate
        every 1.2s until the tab regains focus, then restore the
        original title on visibilitychange. Now the student notices
        even if they switched to another tab while waiting for the
        admin to approve.
     6. announceNotificationToast now also pulses the avatar dot for
        ~3s on every new notification so the eye is drawn there even
        after the toast fades. Uses requestAnimationFrame + forced
        layout flush to restart the CSS animation on repeat arrivals.
   * Why this matters: the notification pipeline works perfectly
     under the hood now; the UI just needed to communicate that
     quality. The student gets a celebratory rich toast with confetti
     on approval, a clear actionable toast with a "Try Again" button
     on decline, a persistent visual cue (pulsing avatar dot + tab
     title flash), and a polished themed notification banner inside
     the avatar menu.
   Carries forward from v1.6.28:
   * Section 2c — drop legacy CHECK constraints generically.
   Carries forward from v1.6.27:
   * Section 2b — relax legacy NOT NULL columns.
   * Section 5 / 5b — diagnostic queries.
   Carries forward from v1.6.26:
   * ALTER TABLE ADD COLUMN IF NOT EXISTS for every column.
   * NOTIFY pgrst 'reload schema' to refresh PostgREST cache.
   Carries forward from v1.6.25:
   * Realtime + 45s poll fallback for student notifications.
   * Loud toasts on admin INSERT failures.
   * Dual-admin RLS on notifications. */
const VERSION = 'hiq-v1.6.29';
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
