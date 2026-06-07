/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.16 — Fix the broken wa.me/91 link bug (truncated WhatsApp number).
   * Problem: user reported the FAB WhatsApp button opened
     https://api.whatsapp.com/send/?phone=91&text&type=phone_number&app_absent=0
     — phone=91 only, not their full 12-digit number. Root cause: the
     DEFAULT_SETTINGS.whatsapp_number was set to the placeholder
     '91XXXXXXXXXX', and our defensive .replace(/\D/g, '') stripped the
     X chars leaving just '91'. When the FAB fell back to this default
     (race condition: clicked before fetchSettings hydrated APP.settings,
     or DB read failed), the resolved value was '91' → wa.me/91 →
     WhatsApp's broken redirect URL.
   * Fix:
     1. DEFAULT_SETTINGS.whatsapp_number and contact_email are now both
        EMPTY strings. A placeholder pattern that strips to something
        shorter than a real value is more dangerous than no default at
        all — empty values cleanly trigger the "being set up" toast and
        hide the footer link.
     2. FAB whatsapp action now validates the resolved number is 10-15
        digits (E.164 phone-number length) BEFORE opening wa.me/. Any
        shorter and it's a malformed/placeholder → show the friendly
        toast + log a console.warn with the rejected value for debugging.
     3. Footer WhatsApp link applies the same min-10-digit guard. If
        the resolved number is too short, the link stays hidden instead
        of rendering as a clickable but broken link.
   * Why this matters: even if someone in the future adds another
     placeholder default by mistake, the link can never open a
     half-formed wa.me URL. The contract is now strict: must be a real
     phone number or nothing at all.
   Carries forward from v1.6.15:
   * Smart source classification (DEFAULT (DB empty) vs DEFAULT (no row)).
   * Friendly info banner for empty-row defaults instead of false alarms.
   Carries forward from v1.6.14:
   * Live database diagnostic panel in admin Settings.
   * Test-write probe catches silent RLS blocks.
   Carries forward from v1.6.13:
   * Verified-save via .upsert(...).select() on every settings write. */
const VERSION = 'hiq-v1.6.16';
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
