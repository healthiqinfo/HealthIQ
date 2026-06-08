/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.24 — Polish: bulletproof approval email template.
   * Problem: v1.6.23 fixed deliverability (denomailer → nodemailer)
     and the decline email rendered beautifully, but the APPROVAL
     email looked "junky" in many clients. Two root causes:
       1. The CTA button used `linear-gradient(...)` for its
          background. Outlook (and several mobile clients) ignore
          CSS gradients completely → button rendered as bare text
          floating in white space.
       2. The button was wrapped in MSO conditional comments +
          VML `<v:roundrect>` markup. Gmail's parser occasionally
          leaks the raw `<!--[if mso]>` tags into the visible body,
          which looks like garbled HTML to the recipient.
     Net effect: a celebratory welcome email that looked broken.
   * Fix:
     1. Rewrote `buildApproveHtml()` using the SAME bulletproof
        rules as the decline template:
          - Solid-color (#059669) brand ribbon + CTA, no gradients.
          - 100% table-based layout (no flex/grid).
          - Inline styles only, no `<style>` block.
          - Removed every MSO conditional comment + VML element.
          - Classic "bgcolor + nested table" button trick that
            renders identically in Outlook, Gmail, Apple Mail,
            Outlook.com, Yahoo, ProtonMail, and mobile clients.
     2. Added genuinely useful content for the celebratory moment:
          - 3-up "What's included" benefits grid (📝 notes ·
            ♾️ lifetime · 📱 any device).
          - Trust-badge row (🏅 Gold Medalist · 👥 100+ students
            · 🔒 verified pay).
          - Blue "Need help? Just reply" support strip.
          - Copy-paste fallback URL under the CTA for clients
            that suppress link clicking.
     3. Plain-text fallback polished to match (benefits list,
        30-second start guide, support line).
   * Why this matters: a successful purchase deserves a welcome
     email that looks as good as the product. Now both decline
     and approve render identically polished across every major
     email client — no more "junky" surprises.
   Carries forward from v1.6.23:
   * Nodemailer SMTP (handles Gmail's TLS quirk).
   * SMTP error code surfaced in toasts (e.g. EAUTH/SMTP 535).
   * Connection/greeting/socket timeouts (15s/10s/20s). */
const VERSION = 'hiq-v1.6.24';
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
