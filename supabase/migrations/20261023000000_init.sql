-- Greasy Hands Copilot: persist jobs so a session survives beyond sessionStorage.
-- Only the Vercel functions touch these tables (service role key, server side).
-- RLS is on with no policies, so the anon key gets no access.

create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  part_name       text,
  part_variant    text,
  part_confidence numeric(3, 2) check (part_confidence between 0 and 1),
  unidentified    boolean not null default false,
  job             text,
  plan            jsonb not null,              -- full JobPlan as returned by /api/identify
  current_step    integer not null default 0 check (current_step >= 0),
  status          text not null default 'active'
                  check (status in ('active', 'completed', 'abandoned'))
);

create index jobs_created_at_idx on public.jobs (created_at desc);

-- One row per "check" photo verdict from /api/check (stretch feature).
create table public.step_checks (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs (id) on delete cascade,
  step_n     integer not null,
  passed     boolean,                          -- null = model could not tell
  reason     text,
  created_at timestamptz not null default now()
);

create index step_checks_job_id_idx on public.step_checks (job_id, step_n);

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

alter table public.jobs enable row level security;
alter table public.step_checks enable row level security;
