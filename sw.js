/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.20 — Decline-with-reason flow + persistent user notifications.
   * Problem: when a user clicked "I made the payment" but no money actually
     reached our account, the admin's only option was a silent rejectOrder()
     that flipped the order to status='failed' with no explanation. Users
     re-clicked Buy in confused loops and never knew WHY their payment was
     rejected. There was also no email contact path.
   * Fix:
     1. NEW SUPABASE_NOTIFICATIONS_MIGRATION.sql — creates the
        public.notifications table with proper RLS (users own their rows,
        admins can write any), plus orders.decline_reason / declined_at /
        declined_by columns. Also includes a cleanup block that drops the
        broken audit_log_trigger left over from earlier copy-pasted
        migrations (it tried to INSERT into a non-existent audit_logs
        table and silently broke every UPDATE/DELETE on profiles).
     2. NEW decline modal in admin: rejectOrder(id) now opens a richer
        modal with 5 preset reasons (no payment received, unclear
        screenshot, wrong amount, duplicate transaction, expired) plus a
        custom-reason textarea override. Admin picks a reason and clicks
        "Decline & Notify User".
     3. confirmDeclineOrder() does THREE things atomically:
          (a) UPDATE orders SET status='failed', decline_reason=...,
              declined_at=NOW(), declined_by=admin_id  (with graceful
              fallback to legacy schema if migration not yet run).
          (b) INSERT into notifications a payment_declined row with full
              context in metadata (order_id, course_id, course_title,
              amount, reason).
          (c) Open a prefilled mailto: link in the admin's mail client
              (subject + plain-text body with the same details). Zero
              backend infrastructure required — works immediately.
     4. NEW user-side notification surface: fetchMyNotifications() runs
        on login + hydrate, populating APP.myNotifications. New
        renderUserNotificationBanner() injects a colour-coded alert
        strip into the user-menu dropdown showing up to 3 unread
        notifications with "Try Again" + "Dismiss" buttons. Avatar gets
        a red badge when unread > 0.
     5. retryDeclinedPayment() — clicking "Try Again" marks the
        notification read and re-opens the standard enroll flow for
        that course (the prior failed order doesn't block re-purchase
        because submitPaymentForApproval only checks status pending/
        completed/approved).
     6. Logout + SIGNED_OUT both clear APP.myNotifications cleanly.
   * Why this matters: users now ALWAYS know why a payment was rejected
     and have a one-click path to re-attempt. Admin still owns the
     verification but communication is no longer a black hole.
   Carries forward from v1.6.19:
   * In-app Auth Setup Helper for Supabase URL Configuration.
   * getAuthRedirectUrl() shared helper that canonicalises the URL.
   Carries forward from v1.6.18:
   * handleAuthHashErrors() + AuthRecoveryModal for expired email links.
   Carries forward from v1.6.17:
   * resolveWhatsappTarget() shared resolver with live DB fallback. */
const VERSION = 'hiq-v1.6.20';
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
