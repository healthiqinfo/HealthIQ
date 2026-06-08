/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.22 — Fully-automated email for BOTH approve & decline.
   * Problem: v1.6.21 shipped the Edge Function and made the decline
     email automatic, but (a) the decline modal still had a "Also
     open my email client" checkbox + mailto: fallback that confused
     admins ("why does it ask me when SMTP is configured?"), and
     (b) approvals fired NO email at all — students had to log in
     and check My Courses to know their payment cleared.
   * Fix:
     1. Edge Function `send-decline-email` is now TYPE-AWARE.
        Accepts `type: 'declined' | 'approved'` and renders two
        distinct, mobile-friendly, brand-styled HTML templates:
        – Decline: red alert card + clear next-steps + Open HealthIQ CTA.
        – Approve: 🎉 green confirmation + bullet quick-start + big
          "Start Learning Now" gradient CTA + gold-medalist badge.
        Subject lines, preheader text, and plain-text fallbacks all
        flip per type. Same dual admin check + secret redaction.
     2. Client-side `confirmDeclineOrder()` now ALWAYS sends via the
        Edge Function — no checkbox, no mailto: fallback. The
        decline modal carries a green confirmation strip showing
        the recipient address so the admin sees the commitment up
        front. `openDeclineEmailDraft()` is now a no-op stub for
        backwards-compat with stale browser caches.
     3. NEW generic `sendTransactionalEmail({ type, ... })` helper
        wraps both flows. Single call site, single error-handling
        path, identical fallback toasts.
     4. `approveOrder()` + `approveAllPending()` now both:
        (a) insert a `payment_approved` notification row so the
            user sees the good news on their bell, and
        (b) fire the branded approval email automatically.
        Distinct toasts ("approved + email sent", "approved + email
        failed", "approved + no address") give the admin precise
        feedback per outcome. Bulk approve summarises N emails
        sent / M failed at the end.
     5. Decline modal cleanup: zero choice points. Admin picks a
        reason, clicks Decline, the user gets a beautiful email
        and an in-app notification. Done.
   * Why this matters: zero-click email automation in EVERY scenario
     — approve and decline both ship gorgeous HTML with proper
     branding, headers, and CTAs. SMTP creds stay in Supabase
     Secrets, the repo stays clean, the admin never opens another
     mail client window.
   Carries forward from v1.6.21:
   * Supabase Edge Function + Gmail SMTP (denomailer).
   * Dual admin check (profiles.role OR bootstrap email).
   * Secret redaction in error logs.
   * Persistent in-app notifications + audit trigger cleanup. */
const VERSION = 'hiq-v1.6.22';
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
