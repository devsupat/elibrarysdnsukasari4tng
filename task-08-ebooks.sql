-- TASK 08: E-Book hanya menyimpan metadata + tautan eksternal (Google Drive / website).
-- Sebelumnya e-book hanya ada di penyimpanan browser (tanpa tabel) dan PDF disimpan
-- sebagai base64 di perangkat. Tabel ini menyimpan METADATA SAJA — tidak ada file PDF,
-- tidak ada bucket Storage. Menghapus baris tidak menyentuh file sumber.
--
-- STATUS: diterapkan ke runtime Supabase (migration: task_08_ebooks_external_link).
-- Disimpan sebagai catatan/reproducible setup.

create table if not exists public.ebooks (
  id          uuid primary key default gen_random_uuid(),
  judul       text not null check (length(btrim(judul)) > 0),
  pengarang   text,
  -- NULL hanya untuk data lama yang dipindahkan; form aplikasi mewajibkannya.
  kategori    text,
  -- NULL = e-book lama (PDF lokal) yang tautannya belum diisi petugas.
  -- Pagar terakhir: hanya http/https, tanpa spasi. (javascript:/data: ditolak di sini juga.)
  url         text check (url is null or url ~* '^https?://[^\s]+$'),
  dibaca      integer not null default 0,
  -- id lokal lama (mis. 'E0001'); membuat pemindahan data lama idempoten.
  legacy_id   text unique,
  created_at  timestamptz not null default now()
);

alter table public.ebooks enable row level security;

-- Hanya petugas yang login. Tidak ada akses anon (halaman publik e-book belum memakai tabel ini).
drop policy if exists ebooks_read_auth   on public.ebooks;
drop policy if exists ebooks_insert_auth on public.ebooks;
drop policy if exists ebooks_update_auth on public.ebooks;
drop policy if exists ebooks_delete_auth on public.ebooks;
create policy ebooks_read_auth   on public.ebooks for select to authenticated using (true);
create policy ebooks_insert_auth on public.ebooks for insert to authenticated with check (true);
create policy ebooks_update_auth on public.ebooks for update to authenticated using (true) with check (true);
create policy ebooks_delete_auth on public.ebooks for delete to authenticated using (true);

revoke all on public.ebooks from anon;
