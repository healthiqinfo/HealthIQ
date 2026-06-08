/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.25 — Real-time in-app notifications for students.
   * Problem: emails were landing perfectly (decline + approve), but
     students never saw the in-app notification we were inserting
     into the notifications table. Three layered root causes:
       1. fetchMyNotifications() ran only on initial page load + on
          login. A student already in the app when admin acted saw
          NOTHING until they reloaded the tab — which they never do.
       2. The notification UI lives inside the avatar dropdown.
          Without a toast actively grabbing attention, the user
          had no way to know something arrived.
       3. The RLS policy "admins insert any notification" required
          profiles.role='admin'. If the admin was authed via the
          bootstrap-email fallback (no profile.role set), every
          INSERT silently failed RLS — the row never existed and
          there was nothing to render. The code only console.warn'd
          this, never surfaced it to the admin.
   * Fix:
     1. subscribeToMyNotifications() opens a Supabase Realtime
        channel (postgres_changes INSERT filter scoped to the
        user's own user_id). Sub-second push when the project has
        Realtime enabled on the table.
     2. 45-second polling fallback baked into the same function.
        Runs only while document.visibilityState === 'visible',
        diffs against existing IDs so the toast fires exactly
        once per genuinely new row. Covers projects where
        Realtime isn't enabled.
     3. announceNotificationToast() — green confetti success for
        payment_approved, amber warning for payment_declined,
        blue info for everything else. Dedupe set caps unbounded
        growth on long sessions.
     4. Lifecycle hooks: subscribe on hydrateUserFromSession +
        handleLogin; teardown on logout + SIGNED_OUT.
     5. Admin-side INSERT failures now surface as warning toasts
        instead of silent console.warn — so RLS/migration issues
        are visible at the moment of the action.
     6. SUPABASE_NOTIFICATIONS_MIGRATION.sql patched:
          - RLS for admin INSERT + SELECT now uses the dual check
            (profiles.role='admin' OR bootstrap email), mirroring
            the client + Edge Function.
          - ALTER PUBLICATION supabase_realtime ADD TABLE
            public.notifications wrapped in an idempotent DO block.
            Without this, Realtime delivers no events even when
            the channel subscribes successfully.
          - Verify block grew a 4th check for the publication row.
   * Why this matters: students now see "🎉 Payment confirmed —
     course unlocked!" appear as a toast the moment the admin
     clicks Approve, with no reload required. Same for declines
     ("⚠️ Payment declined — open your profile menu to see
     details"). The notification bell on the avatar updates live.
   Carries forward from v1.6.24:
   * Bulletproof approval email template.
   * Nodemailer SMTP (handles Gmail's TLS close quirk).
   * SMTP error codes surfaced in toasts. */
const VERSION = 'hiq-v1.6.25';
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
