-- TASK 03A: one optimized cover reference per bibliographic title.
-- Apply in Supabase SQL editor before enabling cover upload.

alter table public.titles
  add column if not exists cover_path text;

drop policy if exists "titles public read" on public.titles;
create policy "titles public read"
  on public.titles for select to anon, authenticated
  using (true);

insert into storage.buckets (id, name, public)
values ('book-covers', 'book-covers', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "book covers public read" on storage.objects;
create policy "book covers public read"
  on storage.objects for select
  using (bucket_id = 'book-covers');

drop policy if exists "book covers staff upload" on storage.objects;
create policy "book covers staff upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'book-covers');

drop policy if exists "book covers staff update" on storage.objects;
create policy "book covers staff update"
  on storage.objects for update to authenticated
  using (bucket_id = 'book-covers')
  with check (bucket_id = 'book-covers');

drop policy if exists "book covers staff delete" on storage.objects;
create policy "book covers staff delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'book-covers');
