/* HealthIQ Service Worker — shell cache + stale-while-revalidate
   v1.6.26 — Migration hotfix: ALTER existing notifications table.
   * Problem: after running the v1.6.25 migration, admins still hit
     "Could not find the 'body' column of 'notifications' in the
     schema cache" on every approve/decline. Root cause:
       1. A partial earlier run had created `public.notifications`
          WITHOUT the `body` column (older schema shape).
       2. The migration uses `CREATE TABLE IF NOT EXISTS`, which
          is a no-op when the table already exists — so the new
          column definitions in the CREATE block were never
          applied to the partially-built table.
       3. Even if the column had been added, PostgREST caches the
          table shape and waits ~10 minutes to refresh on its own,
          so the next INSERT would still report the missing column.
   * Fix (SUPABASE_NOTIFICATIONS_MIGRATION.sql only — no JS change):
     1. Added an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block
        for EVERY column of `notifications`. Brings any
        pre-existing partial table up to the current shape on
        re-run. Each new column is nullable / has a default so
        adding to a table with existing rows is safe.
     2. Backfill UPDATEs set NULL metadata → '{}'::jsonb and
        NULL is_read → false so the constraints below are
        actually satisfiable.
     3. NOT NULL re-asserted on `type` and `title` only if every
        existing row already satisfies it. Wrapped in a DO block
        with EXCEPTION so a clean error message replaces a
        cryptic constraint-violation if there's bad data.
     4. `NOTIFY pgrst, 'reload schema'` at the end forces
        PostgREST to refresh its cache immediately — otherwise
        the new column appears in Postgres but the REST API
        still rejects INSERTs for ~10 minutes.
     5. Verify block grew two extra rows (body column +
        metadata column existence checks). Now reports 6 rows;
        every one should show exists_count = 1.
   * Why this matters: v1.6.25 set up the realtime + RLS
     infrastructure correctly, but admins running on an older
     partial migration would still see the schema-cache error
     forever. This makes the migration truly idempotent.
   Carries forward from v1.6.25:
   * Realtime + 45s poll fallback for student notifications.
   * Loud toasts on admin INSERT failures.
   * Dual-admin RLS on notifications. */
const VERSION = 'hiq-v1.6.26';
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
