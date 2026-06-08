/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.27 — Migration hotfix #2: relax legacy NOT NULL columns.
   * Problem: after running the v1.6.26 migration, admins now hit
     a NEW error on approve/decline:
       "null value in column 'message' of relation 'notifications'
        violates not-null constraint"
     Root cause: their pre-existing `notifications` table (created
     by an older HealthIQ shape OR a totally unrelated app sharing
     the project) carries extra mandatory columns like `message
     TEXT NOT NULL`. Our v1.6.20+ INSERT only sets the columns
     defined in the migration's section 2 (id, user_id, type,
     title, body, metadata, is_read, created_at). Any legacy
     NOT NULL column outside that set stays NULL on every INSERT
     and trips the constraint.
   * Fix (SUPABASE_NOTIFICATIONS_MIGRATION.sql only — no JS change):
     1. New section 2b: a DO block that queries
        information_schema.columns for every column on
        public.notifications where is_nullable='NO' AND
        column_name NOT IN ('id','type','title'), then runs
          ALTER TABLE public.notifications
            ALTER COLUMN <col> DROP NOT NULL
        on each one. Columns are NOT dropped — any legacy reader
        still gets the data — they just become optional going
        forward. RAISE NOTICE prints each column it touched and
        a summary count.
     2. New section 5: a diagnostic SELECT that lists every
        column on notifications with its data_type, is_nullable,
        default, and a `health` column flagging any remaining
        legacy NOT NULL. Run it any time to triage a future
        "it broke again" report.
   * Why this matters: v1.6.26 made the migration idempotent for
     MISSING columns. v1.6.27 makes it idempotent for SURPLUS
     NOT NULL columns. Together, the migration now self-heals
     against virtually any pre-existing schema drift.
   Carries forward from v1.6.26:
   * ALTER TABLE ADD COLUMN IF NOT EXISTS for every column.
   * NOTIFY pgrst 'reload schema' to refresh PostgREST cache.
   Carries forward from v1.6.25:
   * Realtime + 45s poll fallback for student notifications.
   * Loud toasts on admin INSERT failures.
   * Dual-admin RLS on notifications. */
const VERSION = 'hiq-v1.6.27';
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
