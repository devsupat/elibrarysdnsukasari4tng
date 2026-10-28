-- TASK 13 — Galeri Karya Siswa di Supabase (sebelumnya hanya localStorage per perangkat).
-- STATUS: diterapkan ke runtime Supabase (migration: task_13_karya_siswa).
--
-- Prinsip:
--  * Tabel karya TERTUTUP untuk anon (RLS: hanya authenticated). Publik membaca lewat satu RPC
--    SECURITY DEFINER yang hanya mengembalikan karya PUBLISHED dan kolom yang dibutuhkan galeri.
--    Draft/HIDDEN tidak punya jalur baca publik, jadi tidak bisa diakses dengan menebak id.
--  * Tidak ada kolom "suka": suka anonim tanpa akun mudah digelembungkan, jadi fitur dimatikan
--    daripada menampilkan angka yang menyesatkan.
--  * Foto di Storage bucket publik 'karya-siswa' (path = <karya_id>/<waktu>.webp, tidak bisa ditebak).
--    Anon TIDAK punya policy SELECT di storage.objects => tidak bisa mendaftar isi bucket;
--    URL publik tetap bekerja untuk yang sudah tahu path-nya (ia hanya dibagikan lewat RPC untuk PUBLISHED).
--  * legacy_id unik => pemindahan karya lama dari browser aman diulang (tanpa duplikat).

create table if not exists public.karya (
  id          uuid primary key default gen_random_uuid(),
  judul       text not null check (length(btrim(judul)) between 1 and 150),
  jenis       text not null check (jenis in ('Cerita / Cerpen','Puisi','Pantun','Dongeng',
                                             'Gambar / Komik','Laporan Membaca','Lainnya')),
  isi         text check (isi is null or length(isi) <= 20000),
  nama        text not null check (length(btrim(nama)) between 1 and 100),
  kelas       text check (kelas is null or length(kelas) <= 30),
  foto_path   text,
  status      text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','HIDDEN')),
  legacy_id   text unique,
  petugas_id  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint karya_ada_isi check (nullif(btrim(coalesce(isi, '')), '') is not null or foto_path is not null)
);
comment on table public.karya is 'Karya siswa. Publik hanya lewat karya_publik() dan hanya status PUBLISHED. Tanpa kolom suka (disengaja).';

create index if not exists idx_karya_status_tgl on public.karya (status, created_at desc);

create or replace function public.karya_touch() returns trigger
language plpgsql set search_path to 'public' as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_karya_touch on public.karya;
create trigger trg_karya_touch before update on public.karya for each row execute function public.karya_touch();

alter table public.karya enable row level security;
drop policy if exists karya_read_auth   on public.karya;
drop policy if exists karya_insert_auth on public.karya;
drop policy if exists karya_update_auth on public.karya;
drop policy if exists karya_delete_auth on public.karya;
create policy karya_read_auth   on public.karya for select to authenticated using (true);
create policy karya_insert_auth on public.karya for insert to authenticated with check (true);
create policy karya_update_auth on public.karya for update to authenticated using (true) with check (true);
create policy karya_delete_auth on public.karya for delete to authenticated using (true);
revoke all on public.karya from anon;

-- Pintu publik: hanya PUBLISHED, hanya kolom galeri. p_jenis null = semua jenis.
create or replace function public.karya_publik(p_jenis text[] default null, p_limit int default 24, p_offset int default 0)
returns json
language sql
stable
security definer
set search_path to 'public'
as $$
  with f as (
    select k.* from public.karya k
    where k.status = 'PUBLISHED' and (p_jenis is null or k.jenis = any(p_jenis))
  )
  select json_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select json_agg(x) from (
        select id, judul, jenis, isi, nama, kelas, foto_path, created_at
        from f order by created_at desc, id
        limit least(greatest(coalesce(p_limit, 24), 1), 60) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::json));
$$;
revoke all on function public.karya_publik(text[], int, int) from public;
grant execute on function public.karya_publik(text[], int, int) to anon, authenticated;

-- Storage: bucket publik kecil (1 MB, gambar saja). Tulis/ubah/hapus hanya petugas.
-- Policy SELECT hanya untuk authenticated: DELETE/UPDATE di Postgres butuh SELECT agar baris terlihat,
-- dan anon sengaja tidak boleh mendaftar isi bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('karya-siswa', 'karya-siswa', true, 1048576, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "karya staff read"   on storage.objects;
drop policy if exists "karya staff upload" on storage.objects;
drop policy if exists "karya staff update" on storage.objects;
drop policy if exists "karya staff delete" on storage.objects;
create policy "karya staff read"   on storage.objects for select to authenticated using (bucket_id = 'karya-siswa');
create policy "karya staff upload" on storage.objects for insert to authenticated with check (bucket_id = 'karya-siswa');
create policy "karya staff update" on storage.objects for update to authenticated
  using (bucket_id = 'karya-siswa') with check (bucket_id = 'karya-siswa');
create policy "karya staff delete" on storage.objects for delete to authenticated using (bucket_id = 'karya-siswa');
