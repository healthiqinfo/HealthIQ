/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.14 — Live Database Diagnostic Panel in admin Settings tab.
   * Problem: admin reported the WhatsApp number was "still showing the
     default 919999999999 even after saving from admin panel". v1.6.13
     added verified-save (so the save itself can't fail silently), but
     the admin had no way to SEE what was actually in the database
     versus the local cache versus the hardcoded DEFAULT_SETTINGS
     fallback. Every "it's not saving" report has been impossible to
     diagnose without dropping into devtools.
   * Fix:
     1. New diagnoseSettings() function runs a fresh SELECT on
        site_settings (no cache), attempts a write+read test, and
        builds a full per-key comparison: DB value vs APP.settings
        cache vs DEFAULT_SETTINGS fallback vs what's actually shown
        to users.
     2. New diagnostic panel at the TOP of the admin Settings tab,
        auto-runs the moment the tab opens and after every save. Shows
        colour-coded rows (🟢 DB drives UI, 🟡 cache mismatch,
        🔴 default fallback being used because no DB row exists).
        Explicit test-write result line so admin instantly sees if
        RLS is silently blocking writes.
     3. New "Force Refresh from DB" button that re-fetches and
        re-renders the form — useful when admin suspects stale cache.
     4. Banner at the top of the diagnostic shows the count of rows
        in site_settings — if it's 0, a loud red warning explains
        every UI value is coming from defaults.
   * Why this matters: instead of guessing whether a save persisted,
     the admin gets an immediate visual confirmation panel showing
     EXACTLY what the database has and EXACTLY what users see.
   Carries forward from v1.6.13:
   * Verified-save via .upsert(...).select() on every settings write.
   * Detailed Supabase error formatting (RLS / missing-table patterns).
   * WhatsApp digits-only normalisation + length validation. */
const VERSION = 'hiq-v1.6.14';
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
