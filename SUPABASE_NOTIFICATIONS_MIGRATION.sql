-- ============================================================
--  HealthIQ — v1.6.20+ Migration: Decline-with-reason + Notifications
--
--  Run this ONCE in Supabase Dashboard → SQL Editor.
--  Idempotent — safe to re-run if anything was partially applied.
--
--  v1.6.25 update: dual-admin RLS (mirrors client + Edge Function
--  dual-check: profiles.role='admin' OR bootstrap email) and an
--  ALTER PUBLICATION statement so Supabase Realtime delivers INSERT
--  events for `notifications` without any dashboard clicks. If you
--  already ran an older version of this migration, re-running it is
--  safe — the DROP POLICY IF EXISTS clauses tidy up the old shape.
--
--  v1.6.26 update: idempotent ALTER TABLE ADD COLUMN IF NOT EXISTS
--  for EVERY notifications column, because CREATE TABLE IF NOT EXISTS
--  short-circuits when a partial / older version of the table is
--  already present (e.g. without the `body` column). PostgREST then
--  reports "Could not find the 'body' column of 'notifications' in
--  the schema cache" on every INSERT. The ALTER block below patches
--  any pre-existing table to the current shape; the NOTIFY pgrst
--  reload at the end forces PostgREST to pick up the new columns
--  immediately (otherwise PostgREST waits ~10 minutes to refresh).
--
--  v1.6.27 update: relax legacy NOT NULL columns. Some earlier
--  HealthIQ deployments (or unrelated apps sharing the project)
--  created `notifications` with extra mandatory columns like
--  `message TEXT NOT NULL` or `link TEXT NOT NULL`. Our app only
--  writes the columns defined in section 2 below, so those legacy
--  NOT NULL columns cause INSERT failures:
--    "null value in column 'message' of relation
--     'notifications' violates not-null constraint"
--  Section 2b enumerates every NOT NULL column on `notifications`
--  except our required set (id, type, title) and drops the NOT
--  NULL constraint. Columns are NOT removed so any legacy reader
--  still works — they just become optional from now on.
--
--  v1.6.28 update: drop legacy CHECK constraints. After v1.6.27
--  cleared the NULL-column blocker, admins hit a third generation
--  of the same issue:
--    "new row for relation 'notifications' violates check
--     constraint 'notifications_type_check'"
--  Legacy tables ship with a CHECK like
--    CHECK (type IN ('info','warning','success','error'))
--  which rejects our 'payment_approved' / 'payment_declined'
--  values. Section 2c enumerates every CHECK constraint on the
--  table (pg_constraint.contype='c') and drops it. We do NOT
--  re-add a CHECK — the app validates `type` client-side, and
--  every time we add a new notification type a DB-side enum has
--  to be re-migrated. Section 5 diagnostic was extended to also
--  list any remaining CHECK constraints.
-- ============================================================

-- ------------------------------------------------------------
-- 0. CLEANUP: drop the broken audit_log_trigger left over from
--    a copy-pasted migration. It tries to INSERT into a table
--    called `audit_logs` that doesn't exist, which silently
--    breaks every UPDATE/DELETE on public.profiles (and blocks
--    the Supabase Dashboard "Delete user" button with the error
--    `relation "audit_logs" does not exist`).
-- ------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT event_object_schema  AS schema_name,
               event_object_table   AS table_name,
               trigger_name
        FROM information_schema.triggers
        WHERE action_statement ILIKE '%audit_log_trigger%'
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON %I.%I',
            r.trigger_name, r.schema_name, r.table_name
        );
        RAISE NOTICE 'Dropped trigger % on %.%',
            r.trigger_name, r.schema_name, r.table_name;
    END LOOP;
    DROP FUNCTION IF EXISTS public.audit_log_trigger() CASCADE;
END
$$;

-- ------------------------------------------------------------
-- 1. orders table — add decline metadata so we can tell users
--    EXACTLY why their payment was rejected.
-- ------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS decline_reason text,
    ADD COLUMN IF NOT EXISTS declined_at    timestamptz,
    ADD COLUMN IF NOT EXISTS declined_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 2. notifications table — persistent in-app notifications.
--    Powers:
--      • The unread banner in the user-menu dropdown
--      • Future bell icons / push-style alerts
--      • Audit trail for admin actions affecting a user
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id          bigserial PRIMARY KEY,
    user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    type        text NOT NULL,                 -- 'payment_declined' | 'payment_approved' | 'info' | 'warning'
    title       text NOT NULL,
    body        text,
    metadata    jsonb DEFAULT '{}'::jsonb,     -- { order_id, course_id, course_title, amount, reason, ... }
    is_read     boolean DEFAULT false,
    created_at  timestamptz DEFAULT NOW(),
    read_at     timestamptz
);

-- v1.6.26 — PATCH existing tables.
-- CREATE TABLE IF NOT EXISTS is a no-op when the table is already
-- there, so a partial earlier run that created the table WITHOUT
-- (e.g.) the `body` column won't ever pick up the column from the
-- block above. We re-declare every column as ADD COLUMN IF NOT EXISTS
-- so re-running this migration brings any older shape up to date.
-- All columns are nullable (or have defaults) so adding them to a
-- table that already has rows is safe.
ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS type       text,
    ADD COLUMN IF NOT EXISTS title      text,
    ADD COLUMN IF NOT EXISTS body       text,
    ADD COLUMN IF NOT EXISTS metadata   jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS is_read    boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS read_at    timestamptz;

-- Backfill any NULL metadata so future GIN-style queries don't choke.
UPDATE public.notifications SET metadata = '{}'::jsonb WHERE metadata IS NULL;
UPDATE public.notifications SET is_read  = false        WHERE is_read  IS NULL;

-- Re-assert NOT NULL on the two required columns. Wrapped in a DO
-- block because ALTER COLUMN ... SET NOT NULL will fail loudly if
-- any existing row violates the constraint — we want a clean error
-- in that case so the admin can investigate.
DO $$
BEGIN
    -- Only enforce NOT NULL if every existing row already satisfies it.
    IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE type  IS NULL) THEN
        ALTER TABLE public.notifications ALTER COLUMN type  SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE title IS NULL) THEN
        ALTER TABLE public.notifications ALTER COLUMN title SET NOT NULL;
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'Could not enforce NOT NULL on type/title — pre-existing rows have NULLs. App still works.';
END
$$;

-- ------------------------------------------------------------
-- 2b. v1.6.27 — Relax legacy NOT NULL columns.
--     Some older HealthIQ deployments (or unrelated apps sharing
--     this project) created the notifications table with extra
--     mandatory columns like `message TEXT NOT NULL`, `link TEXT
--     NOT NULL`, `created_by UUID NOT NULL`, etc. Our app's
--     INSERT only sets the columns from section 2 above, so any
--     unknown NOT NULL column causes:
--       "null value in column '<X>' of relation 'notifications'
--        violates not-null constraint"
--     This block enumerates EVERY NOT NULL column on
--     public.notifications that ISN'T in our required whitelist
--     (id, type, title) and drops the NOT NULL constraint. The
--     columns themselves are NOT removed — any legacy reader
--     still gets the data. They just become optional going
--     forward, which is what we want.
--
--     Safe to re-run: if a column is already nullable, DROP NOT
--     NULL is a no-op.
-- ------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
    expected_not_null text[] := ARRAY['id', 'type', 'title'];
    dropped_count int := 0;
BEGIN
    FOR r IN
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'notifications'
          AND is_nullable  = 'NO'
          AND column_name <> ALL (expected_not_null)
    LOOP
        EXECUTE format(
            'ALTER TABLE public.notifications ALTER COLUMN %I DROP NOT NULL',
            r.column_name
        );
        RAISE NOTICE 'Dropped legacy NOT NULL on public.notifications.%', r.column_name;
        dropped_count := dropped_count + 1;
    END LOOP;
    IF dropped_count = 0 THEN
        RAISE NOTICE 'No legacy NOT NULL columns to relax — schema already clean.';
    ELSE
        RAISE NOTICE 'Relaxed % legacy NOT NULL column(s). INSERTs from the app will now succeed.', dropped_count;
    END IF;
END
$$;

-- ------------------------------------------------------------
-- 2c. v1.6.28 — Drop legacy CHECK constraints on notifications.
--     Same problem class as section 2b. Some pre-existing
--     `notifications` tables ship with a CHECK constraint on
--     `type` that only allows a narrow legacy enum, e.g.:
--       CONSTRAINT notifications_type_check
--         CHECK (type IN ('info','warning','success','error'))
--     Our app writes values like 'payment_approved' and
--     'payment_declined' which aren't in that legacy list, so
--     every INSERT trips:
--       "new row for relation 'notifications' violates check
--        constraint 'notifications_type_check'"
--     This block enumerates every CHECK constraint on
--     public.notifications (pg_constraint.contype = 'c') and
--     drops them. We don't re-add our own CHECK because the
--     app already validates `type` client-side, and locking the
--     allowed list in the DB has bitten us twice now whenever
--     we add a new notification type.
--
--     NOTE: We deliberately do NOT touch FOREIGN KEY, UNIQUE,
--     or PRIMARY KEY constraints — only contype='c' (CHECK).
--     Safe to re-run: if no CHECK constraints exist the loop
--     is a no-op.
-- ------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
    dropped_count int := 0;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class      rel ON rel.oid = con.conrelid
        JOIN pg_namespace  nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'notifications'
          AND con.contype = 'c'   -- 'c' = CHECK constraint
    LOOP
        EXECUTE format(
            'ALTER TABLE public.notifications DROP CONSTRAINT %I',
            r.conname
        );
        RAISE NOTICE 'Dropped legacy CHECK constraint % on public.notifications', r.conname;
        dropped_count := dropped_count + 1;
    END LOOP;
    IF dropped_count = 0 THEN
        RAISE NOTICE 'No legacy CHECK constraints on notifications — schema already clean.';
    ELSE
        RAISE NOTICE 'Dropped % legacy CHECK constraint(s). INSERTs with custom `type` values will now succeed.', dropped_count;
    END IF;
END
$$;

-- Hot-path index: the dropdown query is "my unread notifications, newest first".
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON public.notifications (user_id, is_read, created_at DESC);

-- ------------------------------------------------------------
-- 3. Row-Level Security on notifications
--    • Users can read + update (mark as read) their own rows
--    • Admins can insert rows for any user
--    • Anyone authenticated CAN insert for themselves (e.g.
--      future client-side "you completed a course" notifs)
-- ------------------------------------------------------------
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own notifications"   ON public.notifications;
DROP POLICY IF EXISTS "users update own notifications" ON public.notifications;
DROP POLICY IF EXISTS "users insert own notifications" ON public.notifications;
DROP POLICY IF EXISTS "admins insert any notification" ON public.notifications;
DROP POLICY IF EXISTS "admins read all notifications"  ON public.notifications;

CREATE POLICY "users read own notifications" ON public.notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "users update own notifications" ON public.notifications
    FOR UPDATE USING (auth.uid() = user_id)
              WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users insert own notifications" ON public.notifications
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- v1.6.25 — Admin INSERT/SELECT policies now use the SAME dual check
-- the client + Edge Function already use:
--   (a) profiles.role = 'admin', OR
--   (b) JWT email matches the bootstrap admin (thehealthiqinfo@gmail.com).
-- Without the bootstrap fallback, a fresh admin whose profiles row never
-- got role='admin' set would silently fail every notifications INSERT —
-- the user-side decline/approve email would still go out, but the
-- in-app notification would never appear because the row never existed.
CREATE POLICY "admins insert any notification" ON public.notifications
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles
                WHERE id = auth.uid() AND role = 'admin')
        OR LOWER(COALESCE(auth.jwt() ->> 'email', '')) = 'thehealthiqinfo@gmail.com'
    );

CREATE POLICY "admins read all notifications" ON public.notifications
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.profiles
                WHERE id = auth.uid() AND role = 'admin')
        OR LOWER(COALESCE(auth.jwt() ->> 'email', '')) = 'thehealthiqinfo@gmail.com'
    );

-- ------------------------------------------------------------
-- 3b. v1.6.25 — Enable Supabase Realtime on `notifications`.
--     Without this, the client's db.channel(...).on('postgres_changes')
--     subscription will succeed but NEVER receive any INSERT events,
--     because Postgres logical replication doesn't publish the table.
--     The client has a 45-second polling fallback so notifications
--     still appear eventually, but Realtime makes it sub-second.
--
--     Safe to re-run — DO block silently skips if the table is
--     already in the publication.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'notifications'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
        RAISE NOTICE 'Added public.notifications to supabase_realtime publication.';
    ELSE
        RAISE NOTICE 'public.notifications already in supabase_realtime publication — nothing to do.';
    END IF;
END
$$;

-- ------------------------------------------------------------
-- 3c. v1.6.26 — Force PostgREST to reload its schema cache.
--     PostgREST caches the table/column shape and only refreshes
--     every ~10 minutes on its own. After we ADD COLUMN above,
--     INSERTs through the REST API will report "Could not find
--     the 'body' column in the schema cache" until that refresh.
--     This NOTIFY makes PostgREST refresh immediately.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------
-- 4. Verify everything landed
-- ------------------------------------------------------------
SELECT 'notifications table'              AS check_name,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_name='notifications') AS exists_count
UNION ALL
SELECT 'notifications.body column',
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='notifications'
          AND column_name='body')
UNION ALL
SELECT 'notifications.metadata column',
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='notifications'
          AND column_name='metadata')
UNION ALL
SELECT 'orders.decline_reason column',
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='orders'
          AND column_name='decline_reason')
UNION ALL
SELECT 'audit_log_trigger function gone',
       (SELECT 1 - COUNT(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='audit_log_trigger')
UNION ALL
SELECT 'notifications in realtime publication',
       (SELECT COUNT(*) FROM pg_publication_tables
        WHERE pubname='supabase_realtime'
          AND schemaname='public'
          AND tablename='notifications');
-- All SIX rows should show exists_count = 1.

-- ------------------------------------------------------------
-- 5. v1.6.27 — Diagnostic: list the full shape of notifications.
--    Useful when "it still doesn't work" — paste this output back
--    to triage. Highlights legacy columns and any column still
--    marked NOT NULL outside our required set.
-- ------------------------------------------------------------
SELECT column_name,
       data_type,
       is_nullable,
       COALESCE(column_default, '(none)') AS column_default,
       CASE
           WHEN is_nullable = 'NO' AND column_name NOT IN ('id','type','title')
                THEN '⚠ legacy NOT NULL — may block INSERTs'
           ELSE 'ok'
       END AS health
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'notifications'
ORDER BY ordinal_position;

-- ------------------------------------------------------------
-- 5b. v1.6.28 — Diagnostic: list any remaining CHECK constraints
--     on notifications. After running this migration the result
--     should be ZERO rows. If any row appears, the constraint
--     name + definition tells you exactly which legacy rule is
--     still blocking INSERTs.
-- ------------------------------------------------------------
SELECT con.conname        AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition,
       '⚠ legacy CHECK — drop it or update app `type` values' AS health
FROM pg_constraint con
JOIN pg_class      rel ON rel.oid = con.conrelid
JOIN pg_namespace  nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname = 'notifications'
  AND con.contype = 'c';
