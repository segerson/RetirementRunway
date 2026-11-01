-- Run once in Supabase: SQL Editor > New query > paste > Run
create table if not exists public.plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.plans enable row level security;

create policy "read own plan"   on public.plans for select using (auth.uid() = user_id);
create policy "insert own plan" on public.plans for insert with check (auth.uid() = user_id);
create policy "update own plan" on public.plans for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own plan" on public.plans for delete using (auth.uid() = user_id);
