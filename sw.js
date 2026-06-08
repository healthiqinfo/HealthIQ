/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.21 — Automated decline-email delivery via Supabase Edge Function.
   * Problem: v1.6.20 shipped a decline-with-reason flow but the email
     step was a mailto: link — admin had to manually click Send in
     their mail client every time. User asked for full automation.
   * Fix:
     1. NEW Supabase Edge Function `send-decline-email`
        (supabase/functions/send-decline-email/index.ts) running on
        Deno. Verifies the caller's JWT is an admin, reads
        GMAIL_USER + GMAIL_APP_PASSWORD from Supabase Secrets
        (encrypted at rest, NEVER in code or git), and sends a
        branded HTML email via Gmail SMTP using denomailer.
     2. supabase/config.toml + supabase/functions/README.md walk
        through CLI install, login, link, secret-set and deploy.
        Reasoning explained for --no-verify-jwt + the security model
        of never storing the SMTP password in the repo.
     3. Client gains sendDeclineEmailAutomated() that calls
        db.functions.invoke('send-decline-email'). On any failure
        (function not deployed, secrets missing, network error)
        it gracefully falls back to the v1.6.20 mailto: draft so
        the admin is never blocked. Distinct toasts inform the
        admin which path was taken.
     4. Repo-root .gitignore now blocks .env, .env.*, supabase/.env,
        *.secret, *.key, *.pem, _commit_msg.txt, etc. — defensive
        protection against accidental secret commits.
   * Why this matters: admins now click ONE button and the user
     receives a polished, brand-styled email automatically — no
     mail-client juggling. The SMTP credentials never touch the
     client, the repo, or the database; they live only in Supabase
     Edge Function Secrets.
   Carries forward from v1.6.20:
   * Decline-with-reason modal + persistent user notifications.
   * In-app banner with Try Again button.
   * Audit trigger cleanup. */
const VERSION = 'hiq-v1.6.21';
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
