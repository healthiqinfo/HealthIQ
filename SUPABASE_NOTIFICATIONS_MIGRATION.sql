-- ============================================================
--  HealthIQ — v1.6.20 Migration: Decline-with-reason + Notifications
--
--  Run this ONCE in Supabase Dashboard → SQL Editor.
--  Idempotent — safe to re-run if anything was partially applied.
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

CREATE POLICY "admins insert any notification" ON public.notifications
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles
                WHERE id = auth.uid() AND role = 'admin')
    );

CREATE POLICY "admins read all notifications" ON public.notifications
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.profiles
                WHERE id = auth.uid() AND role = 'admin')
    );

-- ------------------------------------------------------------
-- 4. Verify everything landed
-- ------------------------------------------------------------
SELECT 'notifications table'              AS check_name,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_name='notifications') AS exists_count
UNION ALL
SELECT 'orders.decline_reason column',
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='orders'
          AND column_name='decline_reason')
UNION ALL
SELECT 'audit_log_trigger function gone',
       (SELECT 1 - COUNT(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='audit_log_trigger');
-- All three rows should show exists_count = 1.
