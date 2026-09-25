-- TASK 03A: one optimized cover reference per bibliographic title.
-- STATUS: sudah diterapkan ke runtime Supabase (migration: task_03a_book_cover_storage).
-- File ini disimpan sebagai catatan/reproducible setup untuk project baru.
--
-- Catatan: policy SELECT public.titles TIDAK disentuh — project sudah punya
-- titles_read_all (anon, authenticated). Menambah policy read kedua hanya bikin bingung.

alter table public.titles
  add column if not exists cover_path text;

-- Bucket publik: cover katalog harus tampil untuk pengunjung anonim.
-- Batas 1 MB + mime image saja = pagar terakhir bila optimizer di browser dilewati.
-- (optimizeCover() menghasilkan WebP ±80 KB pada 900px, quality 0.82.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('book-covers', 'book-covers', true, 1048576, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Baca: siapa pun (katalog publik). Tulis/ganti/hapus: hanya petugas yang login.
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

-- Verifikasi runtime:
--   select count(*) from information_schema.columns
--     where table_name='titles' and column_name='cover_path';        -- 1
--   select id, public, file_size_limit from storage.buckets
--     where id='book-covers';                                        -- 1 baris, public=true
--   select count(*) from pg_policies
--     where tablename='objects' and policyname like 'book covers%';   -- 4
