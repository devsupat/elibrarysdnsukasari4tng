-- ============================================================================
-- db-tests.sql — regresi integritas database SUPAT LIBRARY
--
-- CARA PAKAI
--   Salin SELURUH isi file ini ke SQL Editor Supabase, lalu Run.
--   Hasil muncul sebagai satu pesan error berisi daftar LULUS/GAGAL.
--   Pesan error di akhir memang DISENGAJA: itulah yang me-rollback semuanya.
--
-- AMAN UNTUK PRODUKSI
--   Seluruh pengujian berjalan dalam satu transaksi yang selalu dibatalkan.
--   Tidak ada baris books/loans/members/titles yang berubah permanen.
--
-- Jalankan ulang setiap kali ada migrasi yang menyentuh books atau loans.
-- Tanpa framework, tanpa runner, tanpa dependency.
-- ============================================================================
do $$
declare
  r      text := chr(10) || '===== REGRESI INTEGRITAS SUPAT LIBRARY =====' || chr(10);
  ok     int  := 0;
  gagal  int  := 0;
  n      int;
  n0     int;
  n1     int;
  v_book uuid;
  v_mem  uuid;
  l1     loans;
begin
  ---------------------------------------------------------------- BAGIAN 1
  -- Invarian yang harus benar setiap saat. Tidak menulis apa pun.
  ----------------------------------------------------------------
  r := r || chr(10) || '-- 1. INVARIAN DATA --' || chr(10);

  select count(*) into n from (select book_id from loans
    where kembali is null and status='BORROWED' group by book_id having count(*)>1) x;
  if n=0 then ok:=ok+1; r:=r||'I1  nol copy dengan 2 loan aktif............. LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I1  '||n||' copy punya loan aktif ganda...... GAGAL'||chr(10); end if;

  select count(*) into n from loans where status is null;
  if n=0 then ok:=ok+1; r:=r||'I2  nol loans.status NULL.................... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I2  '||n||' loans.status NULL................. GAGAL'||chr(10); end if;

  select count(*) into n from books where status_copy is null;
  if n=0 then ok:=ok+1; r:=r||'I3  nol books.status_copy NULL............... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I3  '||n||' books.status_copy NULL............ GAGAL'||chr(10); end if;

  select count(*) into n from books b
   where b.status_copy in ('AVAILABLE','BORROWED')
     and (b.status_copy='BORROWED') <> exists (
           select 1 from loans l where l.book_id=b.id and l.kembali is null and l.status='BORROWED');
  if n=0 then ok:=ok+1; r:=r||'I4  status_copy sinkron dengan loan aktif.... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I4  '||n||' copy melenceng.................... GAGAL'||chr(10); end if;

  select count(*) into n from books where tersedia > jumlah or tersedia < 0;
  if n=0 then ok:=ok+1; r:=r||'I5  stok dalam rentang wajar................. LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I5  '||n||' baris stok mustahil............... GAGAL'||chr(10); end if;

  select count(*) into n from books b
   where b.title_id is not null and not exists (select 1 from titles t where t.id=b.title_id);
  if n=0 then ok:=ok+1; r:=r||'I6  FK books.title_id utuh................... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I6  '||n||' title_id menggantung.............. GAGAL'||chr(10); end if;

  select count(*) into n from loans l
   where not exists (select 1 from books b where b.id=l.book_id)
      or not exists (select 1 from members m where m.id=l.member_id);
  if n=0 then ok:=ok+1; r:=r||'I7  FK loans -> books/members utuh........... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'I7  '||n||' loan tanpa relasi valid........... GAGAL'||chr(10); end if;

  ---------------------------------------------------------------- BAGIAN 2
  -- Negative test: semuanya HARUS ditolak database.
  ----------------------------------------------------------------
  r := r || chr(10) || '-- 2. HARUS DITOLAK DATABASE --' || chr(10);

  select book_id into v_book from loans where kembali is null and status='BORROWED' limit 1;
  select id into v_mem from members limit 1;

  if v_book is not null then
    begin
      insert into loans (member_id, book_id, nama, kode, judul, pinjam, batas)
      values (v_mem, v_book, 'TES','TES','TES', current_date, current_date+3);
      gagal:=gagal+1; r:=r||'N1  loan aktif kedua ditolak................. GAGAL (lolos!)'||chr(10);
    exception when others then ok:=ok+1; r:=r||'N1  loan aktif kedua ditolak................. LULUS'||chr(10); end;
  else
    r:=r||'N1  dilewati (tidak ada loan aktif)'||chr(10);
    select id into v_book from books limit 1;
  end if;

  begin update books set status_copy='RUSAK_PARAH' where id=v_book;
    gagal:=gagal+1; r:=r||'N2  status_copy ngawur ditolak............... GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'N2  status_copy ngawur ditolak............... LULUS'||chr(10); end;

  begin update books set kondisi='JELEK' where id=v_book;
    gagal:=gagal+1; r:=r||'N3  kondisi ngawur ditolak................... GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'N3  kondisi ngawur ditolak................... LULUS'||chr(10); end;

  begin update books set sumber='Hibah Alien' where id=v_book;
    gagal:=gagal+1; r:=r||'N4  sumber ngawur ditolak.................... GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'N4  sumber ngawur ditolak.................... LULUS'||chr(10); end;

  begin update loans set status='ENTAHLAH' where book_id=v_book;
    gagal:=gagal+1; r:=r||'N5  loans.status ngawur ditolak.............. GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'N5  loans.status ngawur ditolak.............. LULUS'||chr(10); end;

  ---------------------------------------------------------------- BAGIAN 3
  -- Alur kritis: pinjam -> kembali -> pinjam lagi -> batal -> pinjam lagi.
  ----------------------------------------------------------------
  r := r || chr(10) || '-- 3. ALUR KRITIS (E2E) --' || chr(10);

  select count(*) into n0 from loans;
  select id into v_book from books
   where status_copy='AVAILABLE' and tersedia=1
     and not exists (select 1 from loans l where l.book_id=books.id and l.kembali is null) limit 1;
  select id into v_mem from members where tipe='Siswa' limit 1;

  l1 := borrow_book(v_book, v_mem, current_date, 3);
  if l1.status='BORROWED'
     and (select status_copy from books where id=v_book)='BORROWED'
     and (select tersedia from books where id=v_book)=0
  then ok:=ok+1; r:=r||'E1  pinjam menutup stok & menandai copy...... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E1  pinjam................................... GAGAL'||chr(10); end if;

  begin perform borrow_book(v_book, v_mem, current_date, 3);
    gagal:=gagal+1; r:=r||'E2  pinjam ganda ditolak..................... GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'E2  pinjam ganda ditolak..................... LULUS'||chr(10); end;

  l1 := return_book(l1.id);
  if l1.status='RETURNED' and l1.selesai_dibaca = false
     and (select status_copy from books where id=v_book)='AVAILABLE'
     and (select tersedia from books where id=v_book)=1
  then ok:=ok+1; r:=r||'E3  kembali memulihkan stok.................. LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E3  kembali.................................. GAGAL'||chr(10); end if;

  begin perform return_book(l1.id);
    gagal:=gagal+1; r:=r||'E4  kembali ganda ditolak.................... GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'E4  kembali ganda ditolak.................... LULUS'||chr(10); end;

  l1 := borrow_book(v_book, v_mem, current_date, 3);
  if l1.status='BORROWED' then ok:=ok+1; r:=r||'E5  copy bisa dipinjam lagi.................. LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E5  pinjam ulang............................. GAGAL'||chr(10); end if;

  perform delete_loan(l1.id);
  if exists (select 1 from loans where id=l1.id and status='CANCELLED')
     and (select tersedia from books where id=v_book)=1
  then ok:=ok+1; r:=r||'E6  delete = soft cancel, baris tetap ada.... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E6  soft cancel.............................. GAGAL'||chr(10); end if;

  perform delete_loan(l1.id);
  perform delete_loan(l1.id);
  if (select tersedia from books where id=v_book)=1
  then ok:=ok+1; r:=r||'E7  cancel idempotent, stok tidak meledak.... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E7  cancel idempotent........................ GAGAL'||chr(10); end if;

  l1 := borrow_book(v_book, v_mem, current_date, 3);
  if l1.status='BORROWED' then ok:=ok+1; r:=r||'E8  pinjam setelah pembatalan................ LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E8  pinjam pasca-batal....................... GAGAL'||chr(10); end if;

  perform return_book(l1.id);
  update books set status_copy='LOST' where id=v_book;
  begin perform borrow_book(v_book, v_mem, current_date, 3);
    gagal:=gagal+1; r:=r||'E9  copy LOST tidak bisa dipinjam............ GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'E9  copy LOST tidak bisa dipinjam............ LULUS'||chr(10); end;

  update books set status_copy='AVAILABLE' where id=v_book;
  l1 := borrow_book(v_book, v_mem, current_date - 10, 3);
  if (select status from loans where id=l1.id)='BORROWED'
     and (select status_efektif from loans_v where id=l1.id)='OVERDUE'
     and (select hari_terlambat from loans_v where id=l1.id)=7
  then ok:=ok+1; r:=r||'E10 OVERDUE dihitung saat baca (7 hari)...... LULUS'||chr(10);
  else gagal:=gagal+1; r:=r||'E10 OVERDUE.................................. GAGAL'||chr(10); end if;

  select count(*) into n1 from loans;
  if n1 > n0 then ok:=ok+1; r:=r||'E11 histori bertambah, nol terhapus.......... LULUS ('||n0||' -> '||n1||')'||chr(10);
  else gagal:=gagal+1; r:=r||'E11 histori hilang!.......................... GAGAL'||chr(10); end if;

  ---------------------------------------------------------------- BAGIAN 4
  -- RLS: anon tidak boleh menyentuh data siswa maupun transaksi.
  ----------------------------------------------------------------
  r := r || chr(10) || '-- 4. RLS / AKSES ANON --' || chr(10);
  set local role anon;

  begin select count(*) into n from books;
    if n>0 then ok:=ok+1; r:=r||'R1  anon boleh baca katalog (disengaja)...... LULUS'||chr(10);
    else gagal:=gagal+1; r:=r||'R1  katalog publik kosong, portal rusak...... GAGAL'||chr(10); end if;
  exception when others then gagal:=gagal+1; r:=r||'R1  katalog publik ditolak, portal rusak..... GAGAL'||chr(10); end;

  begin select count(*) into n from members;
    if n=0 then ok:=ok+1; r:=r||'R2  anon tidak melihat members............... LULUS'||chr(10);
    else gagal:=gagal+1; r:=r||'R2  BOCOR: anon melihat '||n||' members....... GAGAL'||chr(10); end if;
  exception when others then ok:=ok+1; r:=r||'R2  anon ditolak di members.................. LULUS'||chr(10); end;

  begin select count(*) into n from loans;
    if n=0 then ok:=ok+1; r:=r||'R3  anon tidak melihat loans................. LULUS'||chr(10);
    else gagal:=gagal+1; r:=r||'R3  BOCOR: anon melihat '||n||' loans......... GAGAL'||chr(10); end if;
  exception when others then ok:=ok+1; r:=r||'R3  anon ditolak di loans.................... LULUS'||chr(10); end;

  begin select count(*) into n from loans_v;
    if n=0 then ok:=ok+1; r:=r||'R4  view loans_v tidak bocor................. LULUS'||chr(10);
    else gagal:=gagal+1; r:=r||'R4  BOCOR lewat VIEW: '||n||' baris........... GAGAL'||chr(10); end if;
  exception when others then ok:=ok+1; r:=r||'R4  view loans_v ditolak untuk anon.......... LULUS'||chr(10); end;

  begin insert into titles(judul) values('SERANGAN ANON');
    gagal:=gagal+1; r:=r||'R5  anon tidak boleh menulis titles.......... GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'R5  anon tidak boleh menulis titles.......... LULUS'||chr(10); end;

  begin perform borrow_book(gen_random_uuid(), gen_random_uuid(), current_date, 3);
    gagal:=gagal+1; r:=r||'R6  anon tidak boleh meminjam................ GAGAL'||chr(10);
  exception when others then ok:=ok+1; r:=r||'R6  anon tidak boleh meminjam................ LULUS'||chr(10); end;

  begin n := (public_stats()->>'total_anggota')::int;
    ok:=ok+1; r:=r||'R7  statistik publik tetap jalan............. LULUS'||chr(10);
  exception when others then gagal:=gagal+1; r:=r||'R7  statistik publik rusak................... GAGAL'||chr(10); end;

  reset role;

  ---------------------------------------------------------------- HASIL
  r := r || chr(10) || '===========================================' || chr(10)
         || 'HASIL: ' || ok || ' LULUS, ' || gagal || ' GAGAL' || chr(10)
         || case when gagal=0 then 'Semua pemeriksaan lolos.'
                 else '>>> ADA YANG GAGAL — periksa daftar di atas. <<<' end || chr(10)
         || 'Seluruh perubahan uji dibatalkan oleh exception ini.' || chr(10)
         || '===========================================' || chr(10);

  raise exception '%', r;
end $$;
