/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.30 — Notification action-button bug fixes.
   * Problem A (menu banner buttons completely dead):
     The v1.6.29 banner used inline onclick handlers like
       onclick="markNotificationRead(' + n.id + ')"
       onclick="retryDeclinedPayment(' + n.id + ',\'...\')"
     The real schema (per the section-5 diagnostic) has notifications.id
     as `uuid`, not bigserial. So n.id is a string like
     "abc-123-def-456" — embedded UNQUOTED into the JS attribute it
     parses as a hyphen-subtraction expression with undefined
     identifiers, throws ReferenceError, and the click silently does
     nothing. Both Try Again AND Dismiss in the avatar menu looked
     dead because of this.
   * Problem B (toast Try Again opened nothing visible):
     retryDeclinedPayment was calling enrollCourse, which checks
     APP.myOrders for a pending order. After admin declined, the
     server's order.status is now 'failed', but the client's
     APP.myOrders cache still holds the OLD 'pending' row until the
     next fetch. enrollCourse sees pending → fires
       "Payment already submitted, waiting for admin approval."
     ...which lives in the toast container, right where the rich
     notification toast just was. The user perceived "nothing
     happened".
   * Fixes (index.html only — no SQL, no Edge Function changes):
     1. renderUserNotificationBanner now emits NO inline onclicks.
        Every button has data-notif-action="dismiss|retry|open|mark-all"
        + data-notif-id="<uuid>" + (for retry) data-course-id="<uuid>".
        A single handleNotificationBannerClick delegated handler reads
        the dataset and dispatches. data-* attributes are preserved
        as strings by the browser — no quoting / escaping bugs ever.
     2. retryDeclinedPayment rewritten:
        a) Marks the notification read in the background (no await).
        b) Calls fetchOrders() FIRST so the now-failed order is
           reflected locally before any pending-check runs.
        c) If the course isn't in APP.courses (slow load / unpublished
           / etc.), fetches it directly from the DB by id with
           .maybeSingle() — so the user gets the QR even when the
           local cache is empty.
        d) Calls showPaymentModal DIRECTLY rather than enrollCourse,
           so the stale-pending check can't fire. The user explicitly
           clicked Try Again — they want the QR, not a status warning.
        e) console.log at every step so the next "doesn't work"
           report is one DevTools panel away from root cause.
   * Net effect after re-running the migration once more is unchanged:
     v1.6.28's section 2c already cleaned the schema. This release is
     pure JS bug-fixing on the action handlers. Hard-refresh to load
     hiq-v1.6.30.
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
const VERSION = 'hiq-v1.6.30';
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
