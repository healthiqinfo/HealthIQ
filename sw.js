/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.23 — Hotfix: swap denomailer → nodemailer (Gmail TLS bug).
   * Problem: v1.6.22 emails were intermittently failing in
     production with:
       "peer closed connection without sending TLS close_notify"
       + "BadResource: Bad resource ID" event-loop exceptions.
     Root cause: denomailer@1.6.0 doesn't gracefully handle
     Gmail closing the SMTP socket without a TLS close_notify
     frame. The email IS accepted by Gmail (and often delivered),
     but denomailer throws while reading the closing handshake,
     so our function returns 500 and the admin sees "email
     delivery failed" even though Gmail received the message.
   * Fix:
     1. Edge Function `send-decline-email` now imports
        `nodemailer` via Deno's `npm:` specifier
        (`import nodemailer from "npm:nodemailer@^6.9.7"`).
        Nodemailer is the battle-tested Node.js SMTP library;
        it handles Gmail's no-close_notify cleanly and exposes
        proper SMTP error codes (EAUTH, ECONNECTION, EENVELOPE,
        etc.) so the admin sees actionable reasons.
     2. Error responses now include the SMTP error code +
        responseCode so the failure mode is obvious from the
        toast alone (e.g. "[EAUTH / SMTP 535] Username and
        Password not accepted").
     3. Client toasts in confirmDeclineOrder, approveOrder, and
        approveAllPending now surface the failure reason
        directly — no more "Check Edge Function logs" dead-end.
        Bulk approve shows the first failure's reason as a
        representative sample.
     4. Connection/greeting/socket timeouts (15s/10s/20s) added
        to fail fast if Gmail is unreachable, instead of burning
        the Edge Function's 25s execution budget.
   * Why this matters: the email pipeline is now reliable AND
     self-diagnosing. When something does break, the admin sees
     "[EAUTH] Username and Password not accepted" in the toast
     and knows immediately to rotate the app password — no
     log-digging required.
   Carries forward from v1.6.22:
   * Type-aware Edge Function (decline + approve templates).
   * Zero-click email automation for both approve and decline.
   * Persistent in-app notifications for both outcomes.
   * Dual admin check + secret redaction in errors. */
const VERSION = 'hiq-v1.6.23';
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
