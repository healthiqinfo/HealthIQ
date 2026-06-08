-- ============================================================
--  HealthIQ — Tables for Secure Viewer + Student Dashboard
--  Run this once in Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. course_views: every open/close/blur of the secure PDF viewer
create table if not exists public.course_views (
    id            bigserial primary key,
    user_id       uuid references auth.users(id) on delete cascade,
    course_id     uuid references public.courses(id) on delete cascade,
    action        text check (action in ('open','close','blur')) default 'open',
    duration_seconds int default 0,
    user_agent    text,
    ip            text,
    created_at    timestamptz default now()
);
create index if not exists idx_course_views_user on public.course_views(user_id);
create index if not exists idx_course_views_course on public.course_views(course_id);
create index if not exists idx_course_views_created on public.course_views(created_at desc);

-- 2. study_sessions: accumulates a learner's time per course
create table if not exists public.study_sessions (
    id               bigserial primary key,
    user_id          uuid references auth.users(id) on delete cascade,
    course_id        uuid references public.courses(id) on delete cascade,
    duration_seconds int default 0,
    session_date     date default current_date,
    created_at       timestamptz default now()
);
create index if not exists idx_study_sessions_user on public.study_sessions(user_id);
create index if not exists idx_study_sessions_date on public.study_sessions(session_date desc);

-- 3. (Optional) bookmarks for future feature
create table if not exists public.bookmarks (
    id          bigserial primary key,
    user_id     uuid references auth.users(id) on delete cascade,
    course_id   uuid references public.courses(id) on delete cascade,
    page        int,
    note        text,
    created_at  timestamptz default now()
);

-- 4. site_settings: key/value store powering the Admin → Settings tab
--    (WhatsApp number, contact email, hero copy, pricing plans, etc.)
--    This MUST exist for admin saves to persist; otherwise the front-end
--    silently falls back to DEFAULT_SETTINGS in code and "I changed the
--    WhatsApp number but it still opens the old one" bugs appear.
create table if not exists public.site_settings (
    key         text primary key,
    value       text,
    updated_at  timestamptz default now()
);

-- Optional seed so the WhatsApp + email fields exist as soon as the table
-- is created (overwrite via Admin → Settings → Contact & Social anytime):
insert into public.site_settings (key, value) values
    ('whatsapp_number', '919999321875'),
    ('contact_email',   'support@healthiq.in')
on conflict (key) do nothing;

-- ============================================================
--  ⚠ NOTE on RLS: with RLS DISABLED (current setup) inserts
--  will succeed via the anon key. When you turn RLS on, add:
--
--  alter table course_views enable row level security;
--  create policy "own views"  on course_views
--     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
--  alter table study_sessions enable row level security;
--  create policy "own sessions" on study_sessions
--     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
--  alter table bookmarks enable row level security;
--  create policy "own bookmarks" on bookmarks
--     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
--
--  For site_settings (admin-only writes, public reads):
--  alter table site_settings enable row level security;
--  create policy "public read site_settings" on site_settings
--     for select using (true);
--  create policy "admin write site_settings" on site_settings
--     for all using (
--         exists(select 1 from public.profiles
--                where id = auth.uid() and role = 'admin')
--     );
-- ============================================================


-- ============================================================
--  v1.6.20 — Decline-with-reason + Notifications
--  See SUPABASE_NOTIFICATIONS_MIGRATION.sql for the canonical
--  copy with full comments. This is a condensed inline copy
--  so the main setup file is self-contained.
-- ============================================================

-- 5. orders: decline metadata
alter table public.orders
    add column if not exists decline_reason text,
    add column if not exists declined_at    timestamptz,
    add column if not exists declined_by    uuid references auth.users(id) on delete set null;

-- 6. notifications table
create table if not exists public.notifications (
    id          bigserial primary key,
    user_id     uuid references auth.users(id) on delete cascade,
    type        text not null,
    title       text not null,
    body        text,
    metadata    jsonb default '{}'::jsonb,
    is_read     boolean default false,
    created_at  timestamptz default now(),
    read_at     timestamptz
);
create index if not exists idx_notifications_user_unread
    on public.notifications (user_id, is_read, created_at desc);

-- 7. RLS on notifications (users own theirs; admins can write any)
alter table public.notifications enable row level security;
drop policy if exists "users read own notifications"   on public.notifications;
drop policy if exists "users update own notifications" on public.notifications;
drop policy if exists "users insert own notifications" on public.notifications;
drop policy if exists "admins insert any notification" on public.notifications;
drop policy if exists "admins read all notifications"  on public.notifications;
create policy "users read own notifications"   on public.notifications for select using (auth.uid() = user_id);
create policy "users update own notifications" on public.notifications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users insert own notifications" on public.notifications for insert with check (auth.uid() = user_id);
create policy "admins insert any notification" on public.notifications for insert with check (exists(select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "admins read all notifications"  on public.notifications for select using (exists(select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- 8. Cleanup of broken audit_log_trigger left over from copy-pasted migrations
do $$
declare r record;
begin
    for r in
        select event_object_schema as schema_name, event_object_table as table_name, trigger_name
        from information_schema.triggers
        where action_statement ilike '%audit_log_trigger%'
    loop
        execute format('drop trigger if exists %I on %I.%I', r.trigger_name, r.schema_name, r.table_name);
    end loop;
    drop function if exists public.audit_log_trigger() cascade;
end$$;
-- ============================================================
