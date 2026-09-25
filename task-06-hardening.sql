-- TASK 06 — OPERATIONAL READINESS HARDENING
-- STATUS: sudah diterapkan ke runtime Supabase.
-- Migration: task_06_sinkronkan_tersedia_dengan_status_copy
--            task_06_cabut_dashboard_stats_dari_public
--
-- Disimpan sebagai catatan agar perubahan trigger/hak akses tidak hanya hidup
-- di database remote.

-- ---------------------------------------------------------------------------
-- P1 — Eksemplar ada di rak tapi ditolak saat dipinjam
-- ---------------------------------------------------------------------------
-- Akar masalah: 'tersedia' dan 'status_copy' adalah dua sumber kebenaran untuk
-- satu fakta yang sama. Trigger books_sync_status_copy hanya merapikan
-- status_copy setelah transaksi pinjam/kembali, tidak pernah 'tersedia'.
-- Sisa impor lama meninggalkan 7 eksemplar status_copy='AVAILABLE' dengan
-- tersedia=0. UI membaca status_copy (menampilkan "Tersedia", tombol pinjam
-- muncul), sedangkan borrow_book menghitung tersedia>0 lalu menolak dengan
-- "Stok buku habis" padahal bukunya ada di tangan petugas.
--
-- Perbaikan: trigger yang sama kini menetapkan 'tersedia' sekaligus.
-- Peran 'tersedia' sebagai kunci dekremen atomik di borrow_book TIDAK diubah;
-- trigger hanya berjalan sesudah baris loans berubah, jadi tidak bertabrakan
-- dengan pengunci itu.

create or replace function public.books_sync_status_copy()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_book uuid := coalesce(new.book_id, old.book_id);
  v_dipinjam boolean;
begin
  if v_book is null then return coalesce(new, old); end if;

  select exists (
    select 1 from public.loans l
     where l.book_id = v_book and l.kembali is null and l.status = 'BORROWED'
  ) into v_dipinjam;

  -- Hanya menyentuh eksemplar yang beredar. LOST/DAMAGED/RETIRED diurus
  -- set_copy_status dan tidak boleh dikembalikan ke rak oleh trigger ini.
  update public.books b
     set status_copy = case when v_dipinjam then 'BORROWED' else 'AVAILABLE' end,
         tersedia    = case when v_dipinjam then 0 else 1 end
   where b.id = v_book
     and coalesce(b.status_copy,'AVAILABLE') in ('AVAILABLE','BORROWED');

  return coalesce(new, old);
end $function$;

-- Perbaikan satu kali untuk sisa impor lama (7 baris). Tidak ada baris dihapus.
update public.books b
   set tersedia = 1
 where coalesce(b.status_copy,'AVAILABLE') = 'AVAILABLE'
   and b.tersedia <> 1
   and not exists (
     select 1 from public.loans l
      where l.book_id = b.id and l.kembali is null and l.status = 'BORROWED'
   );

update public.books
   set tersedia = 0
 where coalesce(status_copy,'AVAILABLE') in ('LOST','DAMAGED','RETIRED')
   and tersedia <> 0;

-- ---------------------------------------------------------------------------
-- Lapis kedua — hak akses dashboard_stats
-- ---------------------------------------------------------------------------
-- Task 05 mencabut EXECUTE dari 'anon' saja, padahal Postgres memberi EXECUTE
-- ke PUBLIC secara bawaan, jadi anon tetap memilikinya lewat PUBLIC.
-- RLS sudah menahan isinya (anon menerima "permission denied for table loans"),
-- jadi ini pengencangan, bukan penambalan kebocoran.
revoke all on function public.dashboard_stats(integer) from public;
revoke all on function public.dashboard_stats(integer) from anon;
grant execute on function public.dashboard_stats(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Verifikasi invariant (harus 0 semua kecuali yang disebut)
-- ---------------------------------------------------------------------------
--   select count(*) from books
--    where (coalesce(status_copy,'AVAILABLE')='AVAILABLE' and tersedia<>1)
--       or (coalesce(status_copy,'AVAILABLE')<>'AVAILABLE' and tersedia<>0);   -- 0
--   select count(*) from (select book_id from loans
--     where status='BORROWED' and kembali is null group by 1 having count(*)>1) x;  -- 0
--   select count(*) from (select member_id,tanggal from visits
--     group by 1,2 having count(*)>1) y;                                       -- 0
--   select has_function_privilege('anon','public.dashboard_stats(integer)','execute');  -- false
