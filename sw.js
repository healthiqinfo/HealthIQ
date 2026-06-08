/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.28 — Migration hotfix #3: drop legacy CHECK constraints.
   * Problem: after v1.6.27 cleared the legacy NOT NULL columns,
     admins now hit a THIRD generation of the same problem:
       "new row for relation 'notifications' violates check
        constraint 'notifications_type_check'"
     Their pre-existing notifications table ships with a CHECK
     constraint that only allows a narrow legacy enum like
       CHECK (type IN ('info','warning','success','error'))
     which rejects our app's 'payment_approved' /
     'payment_declined' values on every INSERT.
   * Fix (SUPABASE_NOTIFICATIONS_MIGRATION.sql only — no JS change):
     1. New section 2c: a DO block that enumerates every CHECK
        constraint on public.notifications (pg_constraint.contype
        = 'c') and drops them with ALTER TABLE ... DROP CONSTRAINT.
        We deliberately do NOT touch FOREIGN KEY, UNIQUE, or
        PRIMARY KEY constraints — only CHECK. RAISE NOTICE prints
        each constraint name it dropped.
     2. We do NOT re-add our own CHECK on `type`. The app already
        validates type values client-side, and a DB-side enum has
        bitten us twice now — every time we add a new notification
        type (e.g. 'order_update', 'course_completed') someone
        would have to re-migrate. The app is the source of truth
        for which type values exist.
     3. New section 5b: a diagnostic SELECT that lists any
        remaining CHECK constraints on notifications with their
        full definitions. After running the migration this should
        return zero rows; if not, the output tells admin exactly
        which legacy rule is still blocking INSERTs.
   * Why this matters: v1.6.26 fixed MISSING columns. v1.6.27
     fixed SURPLUS NOT NULL columns. v1.6.28 fixes SURPLUS CHECK
     constraints. Together the migration now self-heals against
     every form of legacy schema drift we've seen on
     public.notifications.
   Carries forward from v1.6.27:
   * Section 2b — relax legacy NOT NULL columns.
   * Section 5 — diagnostic shape listing.
   Carries forward from v1.6.26:
   * ALTER TABLE ADD COLUMN IF NOT EXISTS for every column.
   * NOTIFY pgrst 'reload schema' to refresh PostgREST cache.
   Carries forward from v1.6.25:
   * Realtime + 45s poll fallback for student notifications.
   * Loud toasts on admin INSERT failures.
   * Dual-admin RLS on notifications. */
const VERSION = 'hiq-v1.6.28';
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
