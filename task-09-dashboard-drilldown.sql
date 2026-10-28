-- TASK 09 — Dashboard drill-down & ranking aktivitas.
-- STATUS: diterapkan ke runtime Supabase (migration: task_09_dashboard_drilldown).
-- Disimpan sebagai catatan/reproducible setup.
--
-- Prinsip:
--  * Hanya BACA. Tidak ada tabel/kolom/trigger baru, tidak ada histori yang diubah.
--  * SECURITY INVOKER (bukan DEFINER): RLS tabel tetap berlaku, jadi hanya petugas login yang bisa
--    membaca. EXECUTE dicabut dari PUBLIC/anon (pola yang sama dengan dashboard_stats).
--  * Hari bisnis = tanggal_lokal() (WIB), bukan jam browser.
--  * Agregasi & pembatasan baris di PostgreSQL; browser hanya menerima satu halaman (maks 50 baris).
--
-- Definisi angka mengikuti dashboard_stats() persis, agar jumlah di kartu = total di daftar detail.

-- ---------------------------------------------------------------------------
-- 1. dashboard_detail — daftar baris di balik satu kartu
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_detail(
  p_jenis text, p_cari text default null, p_limit int default 25, p_offset int default 0)
returns json
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_hari date := public.tanggal_lokal();
  v_lim  int  := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_off  int  := greatest(coalesce(p_offset, 0), 0);
  v_q    text := nullif(btrim(coalesce(p_cari, '')), '');
  -- karakter khusus LIKE di-escape: petugas mengetik "50%" untuk dicari, bukan sebagai pola
  v_pat  text := case when v_q is null then null
                 else '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_stat text;
  v_out  json;
begin
  if p_jenis = 'kunjungan' then
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select v.member_id, v.nama, v.kelas, v.pertama_at, v.terakhir_at, v.jumlah_scan,
             count(*) over () as total, row_number() over (order by v.terakhir_at desc, v.id) as rn
      from public.visits v
      where v.tanggal = v_hari
        and (v_pat is null or concat_ws(' ', v.nama, v.kelas) ilike v_pat)
      order by v.terakhir_at desc, v.id
      limit v_lim offset v_off
    ) x;

  elsif p_jenis = 'baca' then
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select ra.member_id, ra.nama, ra.kelas, b.judul, b.kode, ra.terjadi_at,
             count(*) over () as total, row_number() over (order by ra.terjadi_at desc, ra.id) as rn
      from public.reading_activities ra
      left join public.books b on b.id = ra.book_id
      where ra.tanggal = v_hari and ra.mode = 'READ_IN_LIBRARY' and ra.dibatalkan_at is null
        and (v_pat is null or concat_ws(' ', ra.nama, ra.kelas, b.judul, b.kode) ilike v_pat)
      order by ra.terjadi_at desc, ra.id
      limit v_lim offset v_off
    ) x;

  elsif p_jenis in ('pinjam_pulang', 'pinjam_kelas') then
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select l.member_id, l.nama, l.kelas, ls.kelas as kelas_sesi, l.judul, l.kode,
             l.pinjam, l.batas, l.kembali, l.status,
             count(*) over () as total, row_number() over (order by l.created_at desc, l.id) as rn
      from public.loans l
      left join public.loan_sessions ls on ls.id = l.session_id
      where l.pinjam = v_hari and l.status <> 'CANCELLED'
        and ((p_jenis = 'pinjam_pulang' and l.session_id is null)
          or (p_jenis = 'pinjam_kelas'  and l.session_id is not null))
        and (v_pat is null or concat_ws(' ', l.nama, l.kelas, ls.kelas, l.judul, l.kode) ilike v_pat)
      order by l.created_at desc, l.id
      limit v_lim offset v_off
    ) x;

  elsif p_jenis = 'pengembalian' then
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select l.member_id, l.nama, l.kelas, ls.kelas as kelas_sesi, l.judul, l.kode,
             l.pinjam, l.batas, l.kembali, l.status,
             count(*) over () as total, row_number() over (order by l.created_at desc, l.id) as rn
      from public.loans l
      left join public.loan_sessions ls on ls.id = l.session_id
      where l.kembali = v_hari
        and (v_pat is null or concat_ws(' ', l.nama, l.kelas, ls.kelas, l.judul, l.kode) ilike v_pat)
      order by l.created_at desc, l.id
      limit v_lim offset v_off
    ) x;

  elsif p_jenis in ('dipinjam', 'terlambat', 'jatuh_tempo') then
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select l.member_id, l.nama, l.kelas, ls.kelas as kelas_sesi, l.judul, l.kode,
             l.pinjam, l.batas, l.kembali, l.status, greatest(v_hari - l.batas, 0) as hari_telat,
             count(*) over () as total, row_number() over (order by l.batas asc, l.pinjam asc, l.id) as rn
      from public.loans l
      left join public.loan_sessions ls on ls.id = l.session_id
      where l.status = 'BORROWED' and l.kembali is null
        and (p_jenis = 'dipinjam'
          or (p_jenis = 'terlambat'   and l.batas <  v_hari)
          or (p_jenis = 'jatuh_tempo' and l.batas =  v_hari))
        and (v_pat is null or concat_ws(' ', l.nama, l.kelas, ls.kelas, l.judul, l.kode) ilike v_pat)
      order by l.batas asc, l.pinjam asc, l.id
      limit v_lim offset v_off
    ) x;

  elsif p_jenis = 'judul' then
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select t.id, t.judul, t.pengarang, t.kategori, coalesce(c.n, 0) as eksemplar,
             count(*) over () as total, row_number() over (order by t.judul, t.id) as rn
      from public.titles t
      left join (select title_id, count(*) n from public.books where title_id is not null group by title_id) c
             on c.title_id = t.id
      where v_pat is null or concat_ws(' ', t.judul, t.pengarang, t.kategori) ilike v_pat
      order by t.judul, t.id
      limit v_lim offset v_off
    ) x;

  elsif p_jenis in ('eksemplar', 'koleksi_tersedia', 'koleksi_dipinjam', 'koleksi_rusak',
                    'koleksi_hilang', 'koleksi_pensiun') then
    v_stat := case p_jenis when 'koleksi_tersedia' then 'AVAILABLE' when 'koleksi_dipinjam' then 'BORROWED'
                           when 'koleksi_rusak' then 'DAMAGED' when 'koleksi_hilang' then 'LOST'
                           when 'koleksi_pensiun' then 'RETIRED' else null end;
    select json_build_object('hari', v_hari, 'total', coalesce(max(x.total), 0),
             'rows', coalesce(json_agg(to_jsonb(x) - 'total' order by x.rn), '[]'::json))
      into v_out
    from (
      select b.id, b.kode, b.judul, b.pengarang, b.lokasi, b.kondisi,
             coalesce(b.status_copy, 'AVAILABLE') as status_copy,
             count(*) over () as total, row_number() over (order by b.judul, b.kode) as rn
      from public.books b
      where (v_stat is null or coalesce(b.status_copy, 'AVAILABLE') = v_stat)
        and (v_pat is null or concat_ws(' ', b.kode, b.judul, b.pengarang, b.lokasi) ilike v_pat)
      order by b.judul, b.kode
      limit v_lim offset v_off
    ) x;

  else
    raise exception 'JENIS_TIDAK_DIKENAL' using errcode = 'P0001';
  end if;

  return v_out;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. aktivitas_ranking — tiga ranking terpisah (tidak dicampur)
-- ---------------------------------------------------------------------------
create or replace function public.aktivitas_ranking(
  p_jenis text, p_days int default 30, p_limit int default 10)
returns json
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_hari  date := public.tanggal_lokal();
  v_sejak date := case when coalesce(p_days, 0) <= 0 then date '1900-01-01'
                       else v_hari - (greatest(p_days, 1) - 1) end;
  v_lim   int  := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_rows  json;
begin
  if p_jenis = 'baca_ditempat' then
    -- jumlah CATATAN baca di tempat (bukan bukti selesai dibaca); yang dibatalkan tidak dihitung
    select coalesce(json_agg(x order by x.jumlah desc, x.nama, x.member_id), '[]'::json) into v_rows from (
      select ra.member_id, coalesce(m.nama, max(ra.nama)) as nama,
             coalesce(m.kelas, max(ra.kelas)) as kelas,
             count(*) as jumlah, max(ra.tanggal) as terakhir
      from public.reading_activities ra
      left join public.members m on m.id = ra.member_id
      where ra.mode = 'READ_IN_LIBRARY' and ra.dibatalkan_at is null and ra.tanggal >= v_sejak
      group by ra.member_id, m.nama, m.kelas
      order by count(*) desc, coalesce(m.nama, max(ra.nama)), ra.member_id
      limit v_lim
    ) x;

  elsif p_jenis = 'pinjam_pulang' then
    -- satu baris loans = satu eksemplar dibawa pulang. CANCELLED dan pinjam-ke-kelas tidak dihitung.
    select coalesce(json_agg(x order by x.jumlah desc, x.nama, x.member_id), '[]'::json) into v_rows from (
      select l.member_id, coalesce(m.nama, max(l.nama)) as nama,
             coalesce(m.kelas, max(l.kelas)) as kelas,
             count(*) as jumlah, max(l.pinjam) as terakhir
      from public.loans l
      left join public.members m on m.id = l.member_id
      where l.member_id is not null and l.session_id is null
        and l.status <> 'CANCELLED' and l.pinjam >= v_sejak
      group by l.member_id, m.nama, m.kelas
      order by count(*) desc, coalesce(m.nama, max(l.nama)), l.member_id
      limit v_lim
    ) x;

  elsif p_jenis = 'kelas' then
    -- dihitung pada KELAS PEMAKAI (loan_sessions.kelas), bukan siswa perwakilan.
    -- buku = baris loans sah; sesi = berapa kali kelas itu meminjam (dua angka terpisah).
    select coalesce(json_agg(x order by x.buku desc, x.sesi desc, x.kelas), '[]'::json) into v_rows from (
      select upper(btrim(ls.kelas)) as kelas, count(distinct ls.id) as sesi,
             count(l.id) as buku, max(l.pinjam) as terakhir
      from public.loans l
      join public.loan_sessions ls on ls.id = l.session_id
      where l.status <> 'CANCELLED' and l.pinjam >= v_sejak and nullif(btrim(ls.kelas), '') is not null
      group by upper(btrim(ls.kelas))
      order by count(l.id) desc, count(distinct ls.id) desc, upper(btrim(ls.kelas))
      limit v_lim
    ) x;

  else
    raise exception 'JENIS_TIDAK_DIKENAL' using errcode = 'P0001';
  end if;

  return json_build_object('jenis', p_jenis, 'periode_hari', coalesce(p_days, 0),
                           'sejak', v_sejak, 'rows', v_rows);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. riwayat_siswa — aktivitas satu pengguna, kategori TERPISAH
-- ---------------------------------------------------------------------------
create or replace function public.riwayat_siswa(p_member_id uuid, p_limit int default 20)
returns json
language plpgsql
stable
set search_path to 'public'
as $function$
declare v_lim int := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'ANGGOTA_TIDAK_DITEMUKAN' using errcode = 'P0002';
  end if;

  return json_build_object(
    'member', (select json_build_object('id', m.id, 'nama', m.nama, 'kelas', m.kelas, 'tipe', m.tipe)
                 from public.members m where m.id = p_member_id),

    -- 1) kunjungan (absensi/scan) — bukan transaksi buku
    'kunjungan', json_build_object(
      'total', (select count(*) from public.visits where member_id = p_member_id),
      'rows', coalesce((select json_agg(x) from (
          select v.tanggal, v.pertama_at, v.jumlah_scan
          from public.visits v where v.member_id = p_member_id
          order by v.tanggal desc limit v_lim) x), '[]'::json)),

    -- 2) baca di tempat — catatan aktivitas, bukan bukti selesai
    'baca_ditempat', json_build_object(
      'total', (select count(*) from public.reading_activities
                 where member_id = p_member_id and mode = 'READ_IN_LIBRARY' and dibatalkan_at is null),
      'rows', coalesce((select json_agg(x) from (
          select ra.tanggal, ra.terjadi_at, b.judul, b.kode
          from public.reading_activities ra left join public.books b on b.id = ra.book_id
          where ra.member_id = p_member_id and ra.mode = 'READ_IN_LIBRARY' and ra.dibatalkan_at is null
          order by ra.terjadi_at desc limit v_lim) x), '[]'::json)),

    -- 3) pinjam pulang pribadi — total = yang sah; yang dibatalkan dihitung terpisah
    'pinjam_pulang', json_build_object(
      'total', (select count(*) from public.loans
                 where member_id = p_member_id and session_id is null and status <> 'CANCELLED'),
      'dibatalkan', (select count(*) from public.loans
                      where member_id = p_member_id and session_id is null and status = 'CANCELLED'),
      'rows', coalesce((select json_agg(x) from (
          select l.pinjam, l.batas, l.kembali, l.status, l.judul, l.kode
          from public.loans l where l.member_id = p_member_id and l.session_id is null
          order by l.pinjam desc, l.created_at desc limit v_lim) x), '[]'::json)),

    -- 4) menjadi perwakilan saat kelas meminjam — BUKAN aktivitas pribadi, dipisah tegas
    'perwakilan_kelas', json_build_object(
      'total', (select count(*) from public.loans
                 where member_id = p_member_id and session_id is not null and status <> 'CANCELLED'),
      'rows', coalesce((select json_agg(x) from (
          select l.pinjam, l.status, l.judul, l.kode, ls.kelas as kelas_sesi
          from public.loans l join public.loan_sessions ls on ls.id = l.session_id
          where l.member_id = p_member_id and l.status <> 'CANCELLED'
          order by l.pinjam desc, l.created_at desc limit v_lim) x), '[]'::json))
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Hak akses: hanya petugas yang login.
-- ---------------------------------------------------------------------------
revoke execute on function public.dashboard_detail(text, text, int, int) from public, anon;
revoke execute on function public.aktivitas_ranking(text, int, int)      from public, anon;
revoke execute on function public.riwayat_siswa(uuid, int)               from public, anon;
grant  execute on function public.dashboard_detail(text, text, int, int) to authenticated;
grant  execute on function public.aktivitas_ranking(text, int, int)      to authenticated;
grant  execute on function public.riwayat_siswa(uuid, int)               to authenticated;
