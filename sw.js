/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.19 — In-app "Auth Setup Helper" for Supabase URL Configuration.
   * Problem: user shared their production URL
     (https://healthiqinfo.github.io/HealthIQ) so we now know the exact
     values that must be pasted into Supabase Dashboard → Authentication
     → URL Configuration. Two issues to address:
       1. Easy to typo when manually copying URLs into the dashboard
          (especially with the /HealthIQ sub-path on GitHub Pages).
       2. The path normalisation matters: GitHub Pages serves the same
          page at /HealthIQ, /HealthIQ/, and /HealthIQ/index.html, so
          the allow-list must cover all variants OR the redirect URL
          we send to Supabase must collapse to one canonical form.
   * Fix:
     1. New getAuthRedirectUrl() shared helper — strips trailing
        'index.html' from window.location.pathname so the URL we send
        to Supabase as emailRedirectTo is always canonical (no matter
        how the user navigated to the site). Used by handleRegister,
        resendConfirmation AND handleForgotPassword.
     2. New "🔐 Auth Setup Helper" button on the admin diagnostic
        panel — opens an inline panel showing:
          - Detected origin + path + canonical URL
          - The exact Site URL value to paste (single value)
          - The exact Redirect URLs to paste (4 variants: no-slash,
            with-slash, /index.html, wildcard /**)
          - Copy-to-clipboard buttons for each block
          - Step-by-step Supabase Dashboard walkthrough
          - "Why 4 redirect URLs?" explainer
        Eliminates typos when configuring the dashboard.
     3. email-templates/README.md now lists the user's exact production
        URL (https://healthiqinfo.github.io/HealthIQ) with copy-paste-
        ready blocks for Site URL + Redirect URLs.
   * Why this matters: the user can now configure Supabase auth correctly
     in 30 seconds with zero typos, and any future change to the hosting
     URL (custom domain, etc.) will be immediately reflected in the
     helper's output.
   Carries forward from v1.6.18:
   * handleAuthHashErrors() + AuthRecoveryModal for expired email links.
   * Explicit emailRedirectTo on every auth call.
   * "Check your email" verify modal with Resend button + tips.
   Carries forward from v1.6.17:
   * resolveWhatsappTarget() shared resolver with live DB fallback.
   * "Test WhatsApp Link" diagnostic button.
   Carries forward from v1.6.16/15/14:
   * Live database diagnostic panel with smart source classification.
   Carries forward from v1.6.13:
   * Verified-save via .upsert(...).select() on every settings write. */
const VERSION = 'hiq-v1.6.19';
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
