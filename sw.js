/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.17 — Self-diagnosing WhatsApp link with live DB fallback.
   * Problem: user saved a valid WhatsApp number (910000000000) from the
     admin panel — the diagnostic showed 🟢 DATABASE for the value, the
     row exists in site_settings — but clicking the FAB WhatsApp button
     STILL showed "WhatsApp contact is being set up..." toast. The
     resolution chain was somehow failing despite APP.settings having
     the right value, and there was no way to see WHY without devtools.
   * Fix:
     1. New resolveWhatsappTarget() shared async function — single source
        of truth for "what URL would the FAB open?". Used by both the FAB
        click handler AND the new admin diagnostic button. Returns a
        structured {ok, num, url, source, reason, chain} so the FAB shows
        a precise toast (e.g. "Configured value '91' is only 2 digits —
        needs at least 10") instead of a generic "being set up" message.
     2. LIVE DB FALLBACK: if APP.settings, APP._waNumber AND
        DEFAULT_SETTINGS all fail validation, the resolver does a fresh
        one-row Supabase query (.eq('key','whatsapp_number').maybeSingle())
        as a last resort. Recovers from race conditions where the initial
        fetchSettings() didn't complete or APP.settings got corrupted.
        Successful live query also backfills the cache for next time.
     3. New "Test WhatsApp Link" button on the admin diagnostic panel —
        runs the same resolver and displays the full resolution chain
        INLINE with: each source's raw value + digits-only count + which
        one was picked (highlighted) + the wa.me URL as a clickable
        test link + a precise pass/fail reason. Eliminates "I saved
        it but the FAB still complains" debugging cycles entirely.
     4. Build version stamp (APP_VERSION = '1.6.17', also exposed as
        window.HEALTHIQ_VERSION) shown in the diagnostic footer so
        the admin can verify they're not running stale cached code.
   * Why this matters: the FAB and the diagnostic now share ONE code
     path, so if the diagnostic says "Would OPEN: wa.me/910000000000"
     then the FAB will too. Any divergence becomes provably impossible.
   Carries forward from v1.6.16:
   * 10-15 digit length validation (E.164 phone-number range).
   * Empty DEFAULT_SETTINGS for whatsapp_number + contact_email.
   Carries forward from v1.6.15/14:
   * Live database diagnostic panel with smart source classification.
   Carries forward from v1.6.13:
   * Verified-save via .upsert(...).select() on every settings write. */
const VERSION = 'hiq-v1.6.17';
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
