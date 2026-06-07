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
