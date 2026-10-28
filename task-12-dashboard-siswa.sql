-- TASK 12 — Dashboard statistik siswa mandiri (halaman publik "Akses Saya").
-- Menggantikan isi student_lookup(text) saja. Tidak ada tabel/kolom/trigger baru, tidak ada data diubah.
--
-- MODEL AKSES (sengaja, tanpa login):
--   Kode kartu = KUNCI PENCARIAN, bukan verifikasi identitas. Siapa pun yang memegang atau
--   mengetahui kode kartu dapat melihat isi RPC ini untuk SATU siswa itu.
--   Pembatasan ada pada isi, bukan pada pemanggil:
--     * hanya satu siswa per panggilan (kunci = barcode_id, bukan id/NISN yang bisa ditebak berurutan)
--     * tidak mengembalikan NISN, NIS, no. anggota, id anggota, barcode, tanggal lahir, alamat, telepon
--     * tidak ada ranking/daftar siswa lain; riwayat dibatasi 10 baris, tanpa nama siswa lain
--     * anon TIDAK mendapat akses ke tabel members/loans/visits/reading_activities (RLS tetap tertutup);
--       fungsi ini SECURITY DEFINER hanya sebagai pintu sempit.
--   Kode kartu 'STU-' + 8 hex tidak dapat ditebak; kartu numerik lama bisa lebih mudah ditebak —
--   risiko itu diterima oleh model akses ini dan dicatat di laporan.
--
-- Definisi angka mengikuti riwayat_siswa()/dashboard_stats() agar konsisten:
--   kunjungan      = jumlah HARI datang (satu baris visits per siswa per hari)
--   baca_ditempat  = jumlah catatan READ_IN_LIBRARY yang tidak dibatalkan (bukan peminjaman)
--   sesi_kelas     = jumlah SESI pinjam ke kelas yang diwakili siswa; buku_kelas = jumlah eksemplarnya
--   pinjam_pulang  = jumlah eksemplar dibawa pulang (loans tanpa sesi, bukan CANCELLED)

create or replace function public.student_lookup(p_key text)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_m     public.members%rowtype;
  v_stat  json; v_aktif json; v_riw json; v_sejak date;
begin
  if p_key is null or length(btrim(p_key)) < 4 or length(btrim(p_key)) > 64 then
    return json_build_object('found', false);
  end if;

  select * into v_m from public.members where upper(barcode_id) = upper(btrim(p_key)) limit 1;
  if not found then return json_build_object('found', false); end if;

  v_stat := json_build_object(
    'kunjungan',     (select count(*) from public.visits where member_id = v_m.id),
    'baca_ditempat', (select count(*) from public.reading_activities
                       where member_id = v_m.id and mode = 'READ_IN_LIBRARY' and dibatalkan_at is null),
    'sesi_kelas',    (select count(distinct session_id) from public.loans
                       where member_id = v_m.id and session_id is not null and status <> 'CANCELLED'),
    'buku_kelas',    (select count(*) from public.loans
                       where member_id = v_m.id and session_id is not null and status <> 'CANCELLED'),
    'pinjam_pulang', (select count(*) from public.loans
                       where member_id = v_m.id and session_id is null and status <> 'CANCELLED'));

  select least(
           (select min(tanggal) from public.visits where member_id = v_m.id),
           (select min(tanggal) from public.reading_activities where member_id = v_m.id and dibatalkan_at is null),
           (select min(pinjam)  from public.loans where member_id = v_m.id and status <> 'CANCELLED'))
    into v_sejak;

  select coalesce(json_agg(x order by x.batas, x.pinjam), '[]'::json) into v_aktif from (
    select l.judul, l.pinjam, l.batas,
           case when l.session_id is null then 'pulang' else 'kelas' end as jenis,
           (l.batas < public.tanggal_lokal()) as terlambat
    from public.loans l
    where l.member_id = v_m.id and l.status = 'BORROWED' and l.kembali is null) x;

  select coalesce(json_agg(x order by x.tanggal desc, x.waktu desc), '[]'::json) into v_riw from (
    select * from (
      select 'kunjungan'::text as jenis, v.tanggal, v.pertama_at as waktu, null::text as judul, null::date as kembali
        from public.visits v where v.member_id = v_m.id
      union all
      select 'baca', ra.tanggal, ra.terjadi_at, b.judul, null
        from public.reading_activities ra left join public.books b on b.id = ra.book_id
       where ra.member_id = v_m.id and ra.mode = 'READ_IN_LIBRARY' and ra.dibatalkan_at is null
      union all
      select 'pulang', l.pinjam, l.created_at, l.judul, l.kembali
        from public.loans l
       where l.member_id = v_m.id and l.session_id is null and l.status <> 'CANCELLED'
      union all
      select 'kelas', l.pinjam, l.created_at, l.judul, l.kembali
        from public.loans l
       where l.member_id = v_m.id and l.session_id is not null and l.status <> 'CANCELLED'
    ) u order by u.tanggal desc, u.waktu desc limit 10) x;

  return json_build_object(
    'found', true,
    'nama', v_m.nama, 'kelas', v_m.kelas, 'rombel', v_m.rombel,
    'tipe', v_m.tipe, 'lifecycle', v_m.lifecycle,
    'tanggal', public.tanggal_lokal(), 'diperbarui', now(), 'sejak', v_sejak,
    'statistik', v_stat, 'dipinjam', v_aktif, 'riwayat', v_riw);
end;
$function$;

revoke all on function public.student_lookup(text) from public;
grant execute on function public.student_lookup(text) to anon, authenticated;
