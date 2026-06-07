/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.13 — Admin Settings now has VERIFIED save (no more silent fails):
   * Problem: admin typed new WhatsApp number in Settings → Contact &
     Social, clicked Save, saw "Settings saved!", but on reload / on
     another device the old number came back. The upsert was returning
     {data: null, error: null} (silent RLS block) and the old code
     treated that as success.
   * Fix:
     1. saveMultipleSettings + saveSetting now do `.upsert(...).select(...)`
        so Supabase returns the actually-persisted rows. We verify every
        key we sent came back with the exact value (catches RLS blocks,
        triggers that mutate values, and partial writes).
     2. Errors now include Supabase code + hint + details + a plain-
        English explanation for common RLS / missing-table patterns —
        no more vague "Save error: " toasts.
     3. After successful save, the Settings tab re-renders so the admin
        sees the canonical DB values (with normalisation applied, e.g.
        WhatsApp stripped to digits-only).
     4. WhatsApp number is now normalised to digits-only BEFORE save —
        strips spaces, '+', '(' etc., so DB stores a clean wa.me-ready
        value. Plus basic 10-15 digit length validation and email format
        validation, surfaced as friendly warning toasts. */
const VERSION = 'hiq-v1.6.13';
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
