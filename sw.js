/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.18 — Recover from expired Supabase auth email links.
   * Problem: user reported new sign-ups were getting redirected to
     http://localhost:3000/#error=access_denied&error_code=otp_expired
     &error_description=Email+link+is+invalid+or+has+expired
     when they clicked the confirmation email. Two root causes:
       1. Supabase Dashboard's Site URL is still 'localhost:3000' (the
          default after creating a new project). The {{ .ConfirmationURL }}
          template token uses Site URL as its base, so every confirmation
          email pointed at localhost. (This MUST be fixed by the admin in
          the dashboard — code can't change it.)
       2. Even after fixing Site URL, links can still fail because they're
          single-use AND expire in 1 hour. Corporate email scanners
          (Microsoft Defender, Gmail safelinks) often pre-open links to
          check for malware, consuming them before the user clicks.
   * Fix:
     1. New handleAuthHashErrors() runs on every page load — parses
        location.hash for #error=...&error_code=... patterns. If found,
        cleans the hash from the URL and shows an AuthRecoveryModal with
        a friendly title + explanation + one-click "Resend Confirmation
        Email" button. Different copy per error code (otp_expired,
        access_denied, invalid_link).
     2. New resendConfirmation(email) helper — wraps db.auth.resend({
        type:'signup', email, options:{ emailRedirectTo }}). Validates
        email format, surfaces Supabase errors via toast, returns boolean
        for callers to know if it worked.
     3. handleRegister() and the resend path BOTH pass an explicit
        emailRedirectTo: window.location.origin + window.location.pathname
        to signUp/resend. This overrides any stale Site URL in the
        dashboard — provided the same origin is in the dashboard's
        Redirect URLs allow-list.
     4. Verify modal (shown after sign-up) now includes a "Resend
        Confirmation Email" button, troubleshooting tips, and an explicit
        "expires in 1 hour, single-use" note so users don't sit on the
        link waiting and then click an expired one.
     5. email-templates/README.md gets a loud SITE URL CONFIGURATION
        section at the top with step-by-step dashboard fix instructions.
   * Why this matters: even when the email link fails (expired,
     pre-scanned, etc.), the user lands on a friendly recovery modal
     instead of an inscrutable URL hash, and can self-serve a new link
     without re-registering.
   Carries forward from v1.6.17:
   * resolveWhatsappTarget() shared resolver with live DB fallback.
   * "Test WhatsApp Link" diagnostic button with full chain visibility.
   * Build version stamp in diagnostic panel.
   Carries forward from v1.6.16/15/14:
   * Live database diagnostic panel with smart source classification.
   Carries forward from v1.6.13:
   * Verified-save via .upsert(...).select() on every settings write. */
const VERSION = 'hiq-v1.6.18';
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
