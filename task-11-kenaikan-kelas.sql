-- TASK 11 — Kenaikan kelas, arsip lulusan, hapus anggota lulus yang aman.
-- STATUS: diterapkan ke runtime Supabase (migration: task_11_kenaikan_kelas_arsip_lulusan).
-- Disimpan sebagai catatan/reproducible setup.
--
-- Akar masalah: promoteYear() hanya mengubah DB.members di browser. Perubahan hilang saat data
-- server dimuat ulang, padahal UI menampilkan sukses. Sekarang aturan ada di database.
--
-- Prinsip:
--  * Tidak ada tabel/kolom baru. Kolom members.tahun_ajaran dipakai sebagai PENANDA idempoten:
--    anggota yang sudah bertahun_ajaran = tahun baru dilewati, jadi klik ganda / retry tidak
--    menaikkan siswa dua kali. Tahun ajaran aktif = nilai terbesar di data anggota (bukan localStorage).
--  * SECURITY INVOKER: RLS tetap berlaku. EXECUTE hanya authenticated.
--  * Kelulusan TIDAK menghapus apa pun: lifecycle='LULUS', kelas terakhir tetap, tahun_ajaran =
--    tahun ajaran terakhir yang dijalani ("tahun lulus").
--  * Hapus permanen hanya untuk LULUS tanpa riwayat apa pun; dijaga trigger sehingga jalur
--    DELETE langsung (REST) pun tidak bisa merusak histori. Tidak ada cascade.

-- ---------------------------------------------------------------------------
-- 1. Klasifikasi tunggal (dipakai pratinjau, eksekusi, dan verifikasi)
-- ---------------------------------------------------------------------------
create or replace function public.kk_klasifikasi(p_ta text)
returns table (id uuid, kelas text, aksi text, tujuan text)
language sql
stable
set search_path to 'public'
as $function$
  select m.id, btrim(m.kelas),
    case
      when coalesce(m.tipe, 'Siswa') <> 'Siswa'                    then 'bukan_siswa'
      when coalesce(m.lifecycle, 'AKTIF') <> 'AKTIF'               then 'bukan_aktif'
      when nullif(btrim(coalesce(m.kelas, '')), '') is null        then 'kelas_kosong'
      when btrim(m.kelas) !~ '^[1-6] ?[A-Za-z]{0,2}$'              then 'format_tidak_valid'
      when m.tahun_ajaran = p_ta                                   then 'sudah_diproses'
      when left(btrim(m.kelas), 1) = '6'                           then 'lulus'
      else 'naik'
    end,
    case
      when coalesce(m.tipe, 'Siswa') <> 'Siswa'
        or coalesce(m.lifecycle, 'AKTIF') <> 'AKTIF'
        or nullif(btrim(coalesce(m.kelas, '')), '') is null
        or btrim(m.kelas) !~ '^[1-6] ?[A-Za-z]{0,2}$'
        or m.tahun_ajaran = p_ta                                   then null
      when left(btrim(m.kelas), 1) = '6'                           then 'LULUS'
      else (left(btrim(m.kelas), 1)::int + 1)::text || substr(btrim(m.kelas), 2)
    end
  from public.members m
$function$;

-- ---------------------------------------------------------------------------
-- 2. Kenaikan kelas: pratinjau (p_eksekusi=false) atau eksekusi atomik (true)
-- ---------------------------------------------------------------------------
create or replace function public.kenaikan_kelas(p_tahun_ajaran text, p_eksekusi boolean default false)
returns json
language plpgsql
set search_path to 'public'
as $function$
declare
  v_ta     text := btrim(coalesce(p_tahun_ajaran, ''));
  v_a      int;
  v_prev   text;
  v_maks   text;
  v_maks_a int;
  v_naik   int; v_lulus int; v_naik_x int := 0; v_lulus_x int := 0; v_sisa int := 0;
  v_perkelas json; v_invalid json; v_pinj int; v_c record;
begin
  if v_ta !~ '^\d{4}/\d{4}$' then
    raise exception 'TAHUN_AJARAN_TIDAK_VALID' using errcode = 'P0001';
  end if;
  v_a := split_part(v_ta, '/', 1)::int;
  if split_part(v_ta, '/', 2)::int <> v_a + 1 then
    raise exception 'TAHUN_AJARAN_TIDAK_VALID' using errcode = 'P0001';
  end if;
  v_prev := (v_a - 1)::text || '/' || v_a::text;      -- tahun ajaran terakhir lulusan = "tahun lulus"

  select max(tahun_ajaran) into v_maks from public.members where tahun_ajaran ~ '^\d{4}/\d{4}$';
  if v_maks is not null then
    v_maks_a := split_part(v_maks, '/', 1)::int;
    if v_a < v_maks_a     then raise exception 'TAHUN_AJARAN_LEBIH_LAMA' using errcode = 'P0001'; end if;
    if v_a > v_maks_a + 1 then raise exception 'TAHUN_AJARAN_LONCAT'     using errcode = 'P0001'; end if;
  end if;

  -- satu proses pada satu waktu; klasifikasi dibaca SESUDAH kunci supaya tidak basi
  if p_eksekusi then perform pg_advisory_xact_lock(hashtext('kenaikan_kelas')); end if;

  select count(*) filter (where aksi = 'naik'), count(*) filter (where aksi = 'lulus')
    into v_naik, v_lulus from public.kk_klasifikasi(v_ta);

  if p_eksekusi then
    with k as (select * from public.kk_klasifikasi(v_ta)),
    n as (update public.members m set kelas = k.tujuan, tahun_ajaran = v_ta
            from k where k.id = m.id and k.aksi = 'naik' returning 1),
    l as (update public.members m set lifecycle = 'LULUS', tahun_ajaran = v_prev
            from k where k.id = m.id and k.aksi = 'lulus' returning 1)
    select (select count(*) from n), (select count(*) from l) into v_naik_x, v_lulus_x;

    -- verifikasi dari data sesudah ubah: tidak boleh ada yang tersisa
    select count(*) into v_sisa from public.kk_klasifikasi(v_ta) where aksi in ('naik', 'lulus');
  end if;

  -- ringkasan dibaca dari keadaan SAAT INI. Pada mode pratinjau itu = rencana; pada mode eksekusi
  -- = keadaan sesudah ubah (per_kelas kosong, sudah_diproses terisi) dan angka nyata ada di 'hasil'.
  select coalesce(json_agg(x order by x.kelas), '[]'::json) into v_perkelas from (
    select k.kelas, k.aksi, k.tujuan, count(*) as jumlah
      from public.kk_klasifikasi(v_ta) k where k.aksi in ('naik', 'lulus') group by 1, 2, 3) x;

  select coalesce(json_agg(x order by x.jumlah desc, x.kelas), '[]'::json) into v_invalid from (
    select k.kelas, count(*) as jumlah from public.kk_klasifikasi(v_ta) k
     where k.aksi = 'format_tidak_valid' group by 1 order by count(*) desc, 1 limit 10) x;

  select count(*) into v_pinj from public.loans l
    join public.kk_klasifikasi(v_ta) k on k.id = l.member_id
   where k.aksi = 'lulus' and l.status = 'BORROWED' and l.kembali is null;

  select count(*) filter (where aksi = 'bukan_siswa')        as bukan_siswa,
         count(*) filter (where aksi = 'bukan_aktif')        as bukan_aktif,
         count(*) filter (where aksi = 'kelas_kosong')       as kelas_kosong,
         count(*) filter (where aksi = 'format_tidak_valid')  as format_tidak_valid,
         count(*) filter (where aksi = 'sudah_diproses')     as sudah_diproses
    into v_c from public.kk_klasifikasi(v_ta);

  return json_build_object(
    'tahun_baru', v_ta, 'tahun_lulus', v_prev, 'tahun_terbesar', v_maks, 'eksekusi', p_eksekusi,
    'siap_naik', v_naik, 'siap_lulus', v_lulus,
    'per_kelas', v_perkelas,
    'dilewati', json_build_object(
      'bukan_siswa', v_c.bukan_siswa, 'bukan_aktif', v_c.bukan_aktif, 'kelas_kosong', v_c.kelas_kosong,
      'format_tidak_valid', v_c.format_tidak_valid, 'sudah_diproses', v_c.sudah_diproses),
    'format_tidak_valid_daftar', v_invalid,
    'pinjaman_aktif_lulusan', v_pinj,
    'hasil', case when p_eksekusi
                  then json_build_object('naik', v_naik_x, 'lulus', v_lulus_x, 'sisa', v_sisa) end);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Hapus anggota LULUS: periksa (p_hapus=false) atau hapus (true), hanya bila aman
-- ---------------------------------------------------------------------------
create or replace function public.hapus_anggota_lulus(p_member_id uuid, p_hapus boolean default false)
returns json
language plpgsql
set search_path to 'public'
as $function$
declare
  m public.members%rowtype;
  v_loans int; v_aktif int; v_ra int; v_vis int; v_ses int;
  v_alasan text[] := '{}'; v_dihapus boolean := false;
begin
  -- baris dikunci: peminjaman baru atas anggota ini menunggu sampai selesai
  select * into m from public.members where id = p_member_id for update;
  if not found then raise exception 'ANGGOTA_TIDAK_DITEMUKAN' using errcode = 'P0002'; end if;

  select count(*), count(*) filter (where status = 'BORROWED' and kembali is null)
    into v_loans, v_aktif from public.loans where member_id = p_member_id;
  select count(*) into v_ra  from public.reading_activities where member_id = p_member_id;
  select count(*) into v_vis from public.visits            where member_id = p_member_id;
  select count(*) into v_ses from public.loan_sessions     where member_id = p_member_id;

  if coalesce(m.lifecycle, 'AKTIF') <> 'LULUS' then v_alasan := array_append(v_alasan, 'BUKAN_LULUS'::text); end if;
  if v_aktif > 0 then v_alasan := array_append(v_alasan, 'PINJAMAN_AKTIF'::text); end if;
  if v_loans > 0 then v_alasan := array_append(v_alasan, 'ADA_RIWAYAT_PINJAMAN'::text); end if;
  if v_ra    > 0 then v_alasan := array_append(v_alasan, 'ADA_AKTIVITAS_BACA'::text); end if;
  if v_vis   > 0 then v_alasan := array_append(v_alasan, 'ADA_RIWAYAT_KUNJUNGAN'::text); end if;
  if v_ses   > 0 then v_alasan := array_append(v_alasan, 'ADA_SESI_KELAS'::text); end if;

  if p_hapus and cardinality(v_alasan) = 0 then
    delete from public.members where id = p_member_id;
    v_dihapus := true;
  end if;

  return json_build_object(
    'boleh', cardinality(v_alasan) = 0, 'dihapus', v_dihapus, 'alasan', to_json(v_alasan),
    'anggota', json_build_object('id', m.id, 'nama', m.nama, 'kelas', m.kelas, 'tahun_ajaran', m.tahun_ajaran,
                                 'nisn', m.nisn, 'barcode_id', m.barcode_id, 'lifecycle', m.lifecycle),
    'jumlah', json_build_object('pinjaman', v_loans, 'pinjaman_aktif', v_aktif, 'aktivitas_baca', v_ra,
                                'kunjungan', v_vis, 'sesi_kelas', v_ses));
end;
$function$;

-- Penjaga terakhir untuk jalur DELETE langsung: policy members_del_auth sebelumnya mengizinkan
-- authenticated menghapus anggota mana pun, lalu loans.member_id menjadi NULL (histori yatim).
create or replace function public.members_guard_delete()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if coalesce(old.lifecycle, 'AKTIF') <> 'LULUS' then
    raise exception 'ANGGOTA_BUKAN_LULUS' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.loans where member_id = old.id)
     or exists (select 1 from public.reading_activities where member_id = old.id)
     or exists (select 1 from public.visits where member_id = old.id)
     or exists (select 1 from public.loan_sessions where member_id = old.id) then
    raise exception 'ANGGOTA_PUNYA_RIWAYAT' using errcode = 'P0001';
  end if;
  return old;
end;
$function$;

drop trigger if exists trg_members_guard_delete on public.members;
create trigger trg_members_guard_delete before delete on public.members
  for each row execute function public.members_guard_delete();

-- ---------------------------------------------------------------------------
-- Hak akses: hanya petugas yang login.
-- ---------------------------------------------------------------------------
revoke execute on function public.kk_klasifikasi(text)                  from public, anon;
revoke execute on function public.kenaikan_kelas(text, boolean)         from public, anon;
revoke execute on function public.hapus_anggota_lulus(uuid, boolean)    from public, anon;
grant  execute on function public.kk_klasifikasi(text)                  to authenticated;
grant  execute on function public.kenaikan_kelas(text, boolean)         to authenticated;
grant  execute on function public.hapus_anggota_lulus(uuid, boolean)    to authenticated;
