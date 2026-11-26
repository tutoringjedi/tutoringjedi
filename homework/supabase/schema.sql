-- =====================================================================
-- Tutoring Jedi Homework Portal: database schema for Supabase
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor ->
-- New query -> paste this whole file -> Run. It is safe to re-run.
--
-- Security model
--   * Every table has Row Level Security (RLS) on.
--   * The tutor is whoever signs in with an email listed in `tutors`.
--   * A student is whoever signs in with an email listed in `students`.
--     Anyone else who signs in sees nothing.
--   * Answer keys are readable only by the tutor. Students write answers
--     and get graded only through the functions below, which run on the
--     server, check ownership and enforce test timers.
--   * PDFs and photo uploads live in private storage buckets. Students
--     can only open PDFs for work assigned to them.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.tutors (
  email text primary key check (email = lower(email))
);

create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null check (length(full_name) between 1 and 120),
  email       text not null unique check (email = lower(email) and position('@' in email) > 1),
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.materials (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null check (length(title) between 1 and 200),
  kind               text not null default 'homework' check (kind in ('homework', 'test')),
  subject            text not null default 'SAT',
  description        text,
  pdf_path           text unique,
  show_answers_after boolean not null default true,
  created_at         timestamptz not null default now()
);

create table if not exists public.material_sections (
  id                  uuid primary key default gen_random_uuid(),
  material_id         uuid not null references public.materials(id) on delete cascade,
  position            int  not null default 1,
  name                text not null default 'Section 1',
  question_count      int  not null check (question_count between 1 and 200),
  time_limit_minutes  int  check (time_limit_minutes is null or time_limit_minutes between 1 and 600),
  unique (material_id, position)
);

-- Tutor-only. qtype: 'mc' (A-D) or 'grid' (student-produced response).
-- correct: accepted answers, e.g. {B} or {3/4,.75,0.75}.
create table if not exists public.answer_keys (
  section_id   uuid not null references public.material_sections(id) on delete cascade,
  question_no  int  not null check (question_no between 1 and 200),
  qtype        text not null default 'mc' check (qtype in ('mc', 'grid')),
  correct      text[] not null default '{}',
  primary key (section_id, question_no)
);

create table if not exists public.assignments (
  id           uuid primary key default gen_random_uuid(),
  material_id  uuid not null references public.materials(id) on delete cascade,
  student_id   uuid not null references public.students(id) on delete cascade,
  due_at       timestamptz,
  timed        boolean not null default false,
  note         text,
  assigned_at  timestamptz not null default now()
);
create index if not exists assignments_student_idx on public.assignments(student_id);
create index if not exists assignments_material_idx on public.assignments(material_id);

create table if not exists public.attempts (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null unique references public.assignments(id) on delete cascade,
  started_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  score           int,
  total           int,
  tutor_feedback  text
);

create table if not exists public.attempt_sections (
  attempt_id   uuid not null references public.attempts(id) on delete cascade,
  section_id   uuid not null references public.material_sections(id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  primary key (attempt_id, section_id)
);

create table if not exists public.responses (
  attempt_id   uuid not null references public.attempts(id) on delete cascade,
  section_id   uuid not null references public.material_sections(id) on delete cascade,
  question_no  int  not null,
  answer       text check (answer is null or length(answer) <= 12),
  is_correct   boolean,
  updated_at   timestamptz not null default now(),
  primary key (attempt_id, section_id, question_no)
);

create table if not exists public.uploads (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  path        text not null unique,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

create or replace function public.current_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.is_tutor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tutors t where t.email = public.current_email())
$$;

create or replace function public.my_student_id() returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from public.students s
  where s.email = public.current_email() and s.active
$$;

-- True when the signed-in student owns the attempt.
create or replace function public.owns_attempt(p_attempt uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.attempts at
    join public.assignments a on a.id = at.assignment_id
    where at.id = p_attempt and a.student_id = public.my_student_id()
  )
$$;

-- True when the material is assigned to the signed-in student.
create or replace function public.material_assigned_to_me(p_material uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.assignments a
    where a.material_id = p_material and a.student_id = public.my_student_id()
  )
$$;

-- Parse an SAT grid-in value ("3/4", ".75", "-2", "1.5") to a number, or null.
create or replace function public.sat_parse_number(p text) returns numeric
language plpgsql immutable as $$
declare
  s text := replace(coalesce(p, ''), ' ', '');
  num numeric; den numeric;
begin
  if s ~ '^-?[0-9]*\.?[0-9]+$' then
    return s::numeric;
  elsif s ~ '^-?[0-9]+/[0-9]+$' then
    num := split_part(s, '/', 1)::numeric;
    den := split_part(s, '/', 2)::numeric;
    if den = 0 then return null; end if;
    return num / den;
  end if;
  return null;
end $$;

-- Does a student answer match any accepted answer?
-- Letters compare case-insensitively; numbers compare by value, so
-- 3/4, .75 and 0.75 are equal. List rounded forms (e.g. .6666|.6667)
-- in the key when you want to accept them.
create or replace function public.sat_answer_matches(p_answer text, p_correct text[]) returns boolean
language plpgsql immutable as $$
declare
  s text := upper(replace(coalesce(p_answer, ''), ' ', ''));
  c text;
  sn numeric := public.sat_parse_number(s);
  cn numeric;
begin
  if s = '' then return false; end if;
  foreach c in array coalesce(p_correct, '{}') loop
    c := upper(replace(c, ' ', ''));
    if s = c then return true; end if;
    cn := public.sat_parse_number(c);
    if sn is not null and cn is not null and abs(sn - cn) < 0.000001 then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.tutors            enable row level security;
alter table public.students          enable row level security;
alter table public.materials         enable row level security;
alter table public.material_sections enable row level security;
alter table public.answer_keys       enable row level security;
alter table public.assignments       enable row level security;
alter table public.attempts          enable row level security;
alter table public.attempt_sections  enable row level security;
alter table public.responses         enable row level security;
alter table public.uploads           enable row level security;

do $$
declare r record;
begin
  -- Drop our policies so the file can be re-run cleanly.
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and policyname like 'hw_%' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy hw_tutors_read on public.tutors for select to authenticated
  using (email = public.current_email());

create policy hw_students_tutor on public.students for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_students_self on public.students for select to authenticated
  using (id = public.my_student_id());

create policy hw_materials_tutor on public.materials for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_materials_student on public.materials for select to authenticated
  using (public.material_assigned_to_me(id));

create policy hw_sections_tutor on public.material_sections for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_sections_student on public.material_sections for select to authenticated
  using (public.material_assigned_to_me(material_id));

create policy hw_keys_tutor on public.answer_keys for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());

create policy hw_assignments_tutor on public.assignments for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_assignments_student on public.assignments for select to authenticated
  using (student_id = public.my_student_id());

create policy hw_attempts_tutor on public.attempts for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_attempts_student on public.attempts for select to authenticated
  using (public.owns_attempt(id));

create policy hw_asec_tutor on public.attempt_sections for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_asec_student on public.attempt_sections for select to authenticated
  using (public.owns_attempt(attempt_id));

-- Students read their responses but write only through save_response().
-- is_correct stays hidden until submission via get_results().
create policy hw_responses_tutor on public.responses for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());

create policy hw_uploads_tutor on public.uploads for all to authenticated
  using (public.is_tutor()) with check (public.is_tutor());
create policy hw_uploads_student_read on public.uploads for select to authenticated
  using (public.owns_attempt(attempt_id));
create policy hw_uploads_student_add on public.uploads for insert to authenticated
  with check (
    public.owns_attempt(attempt_id)
    and path like attempt_id::text || '/%'
  );

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------
-- Student actions (run on the server; enforce ownership and timers)
-- ---------------------------------------------------------------------

-- Raises a generic error the app can show.
create or replace function public.hw_fail(p_code text) returns void
language plpgsql as $$
begin
  raise exception 'HW:%', p_code using errcode = 'P0001';
end $$;

create or replace function public.start_attempt(p_assignment uuid) returns public.attempts
language plpgsql security definer set search_path = public as $$
declare r public.attempts;
begin
  if not exists (select 1 from assignments a where a.id = p_assignment and a.student_id = my_student_id()) then
    perform hw_fail('not_found');
  end if;
  insert into attempts (assignment_id) values (p_assignment)
    on conflict (assignment_id) do nothing;
  select * into r from attempts where assignment_id = p_assignment;
  return r;
end $$;

create or replace function public.start_section(p_attempt uuid, p_section uuid) returns public.attempt_sections
language plpgsql security definer set search_path = public as $$
declare r public.attempt_sections;
begin
  if not owns_attempt(p_attempt) then perform hw_fail('not_found'); end if;
  if exists (select 1 from attempts where id = p_attempt and submitted_at is not null) then
    perform hw_fail('submitted');
  end if;
  if not exists (
    select 1 from material_sections ms
    join assignments a on a.material_id = ms.material_id
    join attempts at on at.assignment_id = a.id
    where at.id = p_attempt and ms.id = p_section
  ) then perform hw_fail('not_found'); end if;
  insert into attempt_sections (attempt_id, section_id) values (p_attempt, p_section)
    on conflict do nothing;
  select * into r from attempt_sections where attempt_id = p_attempt and section_id = p_section;
  return r;
end $$;

-- Seconds left on a timed section, or null when untimed.
create or replace function public.section_seconds_left(p_attempt uuid, p_section uuid) returns int
language sql stable security definer set search_path = public as $$
  select case
    when a.timed and ms.time_limit_minutes is not null then
      greatest(0, ceil(extract(epoch from (asec.started_at + make_interval(mins => ms.time_limit_minutes) - now())))::int)
    else null end
  from attempt_sections asec
  join attempts at on at.id = asec.attempt_id
  join assignments a on a.id = at.assignment_id
  join material_sections ms on ms.id = asec.section_id
  where asec.attempt_id = p_attempt and asec.section_id = p_section
$$;

create or replace function public.save_response(p_attempt uuid, p_section uuid, p_question int, p_answer text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_finished timestamptz;
  v_started boolean;
  v_answer text := nullif(upper(replace(coalesce(p_answer, ''), ' ', '')), '');
begin
  if not owns_attempt(p_attempt) then perform hw_fail('not_found'); end if;
  if exists (select 1 from attempts where id = p_attempt and submitted_at is not null) then
    perform hw_fail('submitted');
  end if;
  select ms.question_count into v_count from material_sections ms where ms.id = p_section;
  if v_count is null or p_question < 1 or p_question > v_count then perform hw_fail('bad_question'); end if;
  if v_answer is not null and (length(v_answer) > 12 or v_answer !~ '^[A-D]$|^-?[0-9./]+$') then
    perform hw_fail('bad_answer');
  end if;
  select true, finished_at into v_started, v_finished
    from attempt_sections where attempt_id = p_attempt and section_id = p_section;
  if v_started is null then perform hw_fail('section_not_started'); end if;
  if v_finished is not null then perform hw_fail('section_closed'); end if;
  -- Timed sections: 20-second grace for network delay at the buzzer.
  if exists (
    select 1 from attempt_sections asec
    join attempts at on at.id = asec.attempt_id
    join assignments a on a.id = at.assignment_id
    join material_sections ms on ms.id = asec.section_id
    where asec.attempt_id = p_attempt and asec.section_id = p_section
      and a.timed and ms.time_limit_minutes is not null
      and now() > asec.started_at + make_interval(mins => ms.time_limit_minutes) + interval '20 seconds'
  ) then
    perform hw_fail('time_up');
  end if;
  insert into responses (attempt_id, section_id, question_no, answer, updated_at)
    values (p_attempt, p_section, p_question, v_answer, now())
  on conflict (attempt_id, section_id, question_no)
    do update set answer = excluded.answer, updated_at = now();
end $$;

create or replace function public.finish_section(p_attempt uuid, p_section uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not owns_attempt(p_attempt) then perform hw_fail('not_found'); end if;
  update attempt_sections set finished_at = coalesce(finished_at, now())
    where attempt_id = p_attempt and section_id = p_section;
end $$;

-- Grade every keyed question and lock the attempt.
create or replace function public.grade_attempt(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_material uuid;
begin
  select a.material_id into v_material
    from attempts at join assignments a on a.id = at.assignment_id where at.id = p_attempt;

  -- Make sure every keyed question has a response row (blank = wrong).
  insert into responses (attempt_id, section_id, question_no, answer)
    select p_attempt, k.section_id, k.question_no, null
    from answer_keys k join material_sections ms on ms.id = k.section_id
    where ms.material_id = v_material and k.question_no <= ms.question_count
      and cardinality(k.correct) > 0
  on conflict do nothing;

  update responses r set is_correct = (
      select case when cardinality(k.correct) = 0 then null
                  else sat_answer_matches(r.answer, k.correct) end
      from answer_keys k
      where k.section_id = r.section_id and k.question_no = r.question_no)
    where r.attempt_id = p_attempt;

  update attempts set
    score = (select count(*) from responses where attempt_id = p_attempt and is_correct),
    total = (select count(*) from answer_keys k join material_sections ms on ms.id = k.section_id
             where ms.material_id = v_material and cardinality(k.correct) > 0
               and k.question_no <= ms.question_count)
  where id = p_attempt;
end $$;

create or replace function public.submit_attempt(p_attempt uuid) returns public.attempts
language plpgsql security definer set search_path = public as $$
declare r public.attempts;
begin
  if not owns_attempt(p_attempt) then perform hw_fail('not_found'); end if;
  if exists (select 1 from attempts where id = p_attempt and submitted_at is not null) then
    perform hw_fail('submitted');
  end if;
  update attempt_sections set finished_at = coalesce(finished_at, now()) where attempt_id = p_attempt;
  update attempts set submitted_at = now() where id = p_attempt;
  perform grade_attempt(p_attempt);
  select * into r from attempts where id = p_attempt;
  return r;
end $$;

-- Tutor: re-grade after fixing an answer key.
create or replace function public.regrade_attempt(p_attempt uuid) returns public.attempts
language plpgsql security definer set search_path = public as $$
declare r public.attempts;
begin
  if not is_tutor() then perform hw_fail('forbidden'); end if;
  perform grade_attempt(p_attempt);
  select * into r from attempts where id = p_attempt;
  return r;
end $$;

-- Question layout (number + type) for the bubble sheet, without answers.
create or replace function public.section_layout(p_section uuid)
returns table (question_no int, qtype text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_tutor() or exists (
      select 1 from material_sections ms where ms.id = p_section and material_assigned_to_me(ms.material_id))) then
    perform hw_fail('not_found');
  end if;
  return query
    select g.n, coalesce(k.qtype, 'mc')
    from material_sections ms
    cross join lateral generate_series(1, ms.question_count) as g(n)
    left join answer_keys k on k.section_id = ms.id and k.question_no = g.n
    where ms.id = p_section
    order by g.n;
end $$;

-- The student's saved answers (no grading info until submitted).
create or replace function public.my_responses(p_attempt uuid)
returns table (section_id uuid, question_no int, answer text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_tutor() or owns_attempt(p_attempt)) then perform hw_fail('not_found'); end if;
  return query select r.section_id, r.question_no, r.answer from responses r where r.attempt_id = p_attempt;
end $$;

-- Results after submission. Correct answers are included only when the
-- material allows it (or for the tutor).
create or replace function public.attempt_results(p_attempt uuid)
returns table (section_id uuid, question_no int, answer text, is_correct boolean, correct text[])
language plpgsql stable security definer set search_path = public as $$
declare v_show boolean; v_tutor boolean := is_tutor();
begin
  if not (v_tutor or owns_attempt(p_attempt)) then perform hw_fail('not_found'); end if;
  if not v_tutor and exists (select 1 from attempts where id = p_attempt and submitted_at is null) then
    perform hw_fail('not_submitted');
  end if;
  select m.show_answers_after into v_show
    from attempts at join assignments a on a.id = at.assignment_id
    join materials m on m.id = a.material_id where at.id = p_attempt;
  return query
    select r.section_id, r.question_no, r.answer, r.is_correct,
           case when v_tutor or v_show then k.correct else null end
    from responses r
    left join answer_keys k on k.section_id = r.section_id and k.question_no = r.question_no
    where r.attempt_id = p_attempt
    order by r.section_id, r.question_no;
end $$;

-- Lock down function access: signed-in users only.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'current_email','is_tutor','my_student_id','owns_attempt','material_assigned_to_me',
             'sat_parse_number','sat_answer_matches','hw_fail','start_attempt','start_section',
             'section_seconds_left','save_response','finish_section','grade_attempt','submit_attempt',
             'regrade_attempt','section_layout','my_responses','attempt_results') loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
-- grade_attempt is internal: only callable through submit/regrade.
revoke execute on function public.grade_attempt(uuid) from authenticated;

-- ---------------------------------------------------------------------
-- Private storage buckets
--   materials : PDFs, path = <anything>.pdf (stored in materials.pdf_path)
--   work      : student photo uploads, path = <attempt_id>/<file>
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('materials', 'materials', false, 52428800, array['application/pdf']),
  ('work', 'work', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists hw_materials_files_tutor   on storage.objects;
drop policy if exists hw_materials_files_student on storage.objects;
drop policy if exists hw_work_files_tutor        on storage.objects;
drop policy if exists hw_work_files_student_read on storage.objects;
drop policy if exists hw_work_files_student_add  on storage.objects;

create policy hw_materials_files_tutor on storage.objects for all to authenticated
  using (bucket_id = 'materials' and public.is_tutor())
  with check (bucket_id = 'materials' and public.is_tutor());

create policy hw_materials_files_student on storage.objects for select to authenticated
  using (bucket_id = 'materials' and exists (
    select 1 from public.materials m where m.pdf_path = name and public.material_assigned_to_me(m.id)));

create policy hw_work_files_tutor on storage.objects for all to authenticated
  using (bucket_id = 'work' and public.is_tutor())
  with check (bucket_id = 'work' and public.is_tutor());

create policy hw_work_files_student_read on storage.objects for select to authenticated
  using (bucket_id = 'work' and exists (
    select 1 from public.attempts at where at.id::text = (storage.foldername(name))[1]
      and public.owns_attempt(at.id)));

create policy hw_work_files_student_add on storage.objects for insert to authenticated
  with check (bucket_id = 'work' and exists (
    select 1 from public.attempts at where at.id::text = (storage.foldername(name))[1]
      and at.submitted_at is null and public.owns_attempt(at.id)));

-- ---------------------------------------------------------------------
-- LAST STEP: make yourself the tutor. Replace the email below with the
-- email you will sign in with, then run just this line.
-- ---------------------------------------------------------------------
-- insert into public.tutors (email) values ('you@example.com') on conflict do nothing;
