begin;
create table public.env_studio_preview_projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  data jsonb not null,
  revision integer not null check (revision > 0),
  updated_at timestamptz not null default now()
);
create index on public.env_studio_preview_projects (user_id, updated_at desc);
alter table public.env_studio_preview_projects enable row level security;
revoke all on public.env_studio_preview_projects from anon, authenticated;
grant select, insert, update on public.env_studio_preview_projects to authenticated;
create policy "Read own ENV Studio preview projects"
  on public.env_studio_preview_projects for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Insert own ENV Studio preview projects"
  on public.env_studio_preview_projects for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Update own ENV Studio preview projects"
  on public.env_studio_preview_projects for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
commit;
