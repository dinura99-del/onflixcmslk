export const MIGRATION_SQL = `-- OnFlix Subtitle Automation — run in your OnFlix Supabase SQL editor
create table if not exists public.subtitle_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  tmdb_id integer not null,
  media_type text not null check (media_type in ('movie','tv')),
  title text not null,
  season_number integer not null default 0,
  episode_number integer not null default 0,
  release_date date,
  popularity numeric,
  runtime integer,
  poster_path text,
  status text not null default 'upcoming'
    check (status in ('upcoming','waiting_embed','waiting_subtitle','processing','completed','failed')),
  attempts integer not null default 0,
  next_retry_at timestamptz,
  error_log text,
  srt_path text,
  srt_url text,
  srt_preview text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tmdb_id, media_type, season_number, episode_number)
);
create index if not exists saj_status_idx on public.subtitle_automation_jobs (status, release_date);

create table if not exists public.subtitle_automation_settings (
  id integer primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.subtitle_automation_settings (id) values (1) on conflict do nothing;

grant all on public.subtitle_automation_jobs to service_role;
grant all on public.subtitle_automation_settings to service_role;
alter table public.subtitle_automation_jobs enable row level security;
alter table public.subtitle_automation_settings enable row level security;
-- No public policies: only the server (service role) reads/writes these tables.

-- Optional safety net: prevent duplicate OnFlix episodes at the database level.
-- Run only after confirming no duplicates exist:
-- create unique index if not exists episodes_content_season_episode_uidx
--   on public.episodes (content_id, season, episode);

-- Storage bucket for Sinhala subtitles (public read)
insert into storage.buckets (id, name, public) values ('subtitles','subtitles', true)
on conflict (id) do nothing;
`;
