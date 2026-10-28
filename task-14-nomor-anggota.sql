-- TASK 14 — Generate nomor anggota otomatis (members.no_anggota).
-- STATUS: diterapkan ke runtime Supabase (migration: task_14_nomor_anggota).
--
-- Temuan audit:
--  * Nomor anggota = kolom members.no_anggota (text). BUKAN nis/nisn (kosong di semua anggota bernomor)
--    dan BUKAN barcode_id (kode kartu STU-xxxx / RFID). Ketiganya identitas terpisah.
--  * Data lama bernomor 472 baris dengan 6 pola berbeda (11 digit, 12 digit, 8 digit tanggal, dst) dan
--    SUDAH ada 4 nomor kembar (468 unik dari 472). Tidak ada constraint unik -> tidak boleh dipasang unik
--    pada data lama; nomor lama TIDAK disentuh.
--  * Aturan aplikasi (saveMember/impor): status = ada nomor ? 'Anggota' : 'Non-Anggota'. Jadi nomor
--    anggota adalah yang MENJADIKAN seseorang Anggota; memberi nomor berarti status ikut 'Anggota'.
--
-- Format baru: SL-00001, SL-00002, ... (awalan SL = SUPAT Library). Sengaja berbeda dari semua pola lama
-- sehingga tidak mungkin bentrok dengan nomor yang sudah ada, dan mudah dikenali sebagai nomor generate.
-- Nomor dari sequence: tidak pernah turun/diulang walau anggota dihapus; tidak berubah saat naik kelas.
--
-- Keunikan dijamin DATABASE: sequence (atomik antar sesi) + unique index parsial khusus format SL-.
-- Baris dikunci FOR UPDATE lalu dicek ulang -> klik ganda / dua petugas bersamaan tidak menghasilkan
-- nomor ganda; yang kedua melihat nomor sudah ada dan dilewati.
--
-- Yang diproses: tipe 'Siswa', lifecycle 'AKTIF', belum bernomor (kosong atau '-').
-- Dilewati: sudah punya nomor, bukan Siswa (Tamu), bukan AKTIF (LULUS/PINDAH/NONAKTIF).
-- Hanya no_anggota dan status yang berubah. nama/kelas/nis/nisn/barcode_id/lifecycle tidak disentuh.
-- p_eksekusi=false: hanya pratinjau (tidak menulis apa pun).

create sequence if not exists public.no_anggota_seq as bigint start 1 minvalue 1 no cycle;

create unique index if not exists members_no_anggota_sl_key
  on public.members (no_anggota) where no_anggota ~ '^SL-[0-9]+$';

create or replace function public.generate_no_anggota(p_member_ids uuid[] default null, p_eksekusi boolean default false)
returns json
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id   uuid;
  v_m    public.members%rowtype;
  v_no   text;
  v_try  int;
  v_rows jsonb := '[]'::jsonb;
  v_ok int := 0; v_skip int := 0; v_fail int := 0;
  v_hasil text;
begin
  for v_id in
    select x from (
      select m.id as x, m.kelas, m.nama from public.members m where p_member_ids is null
      union all
      select u as x, null, null from unnest(coalesce(p_member_ids, '{}'::uuid[])) u where p_member_ids is not null
    ) t
    order by t.kelas nulls last, t.nama nulls last, x
  loop
    v_hasil := null; v_no := null;
    if p_eksekusi then
      select * into v_m from public.members where id = v_id for update;
    else
      select * into v_m from public.members where id = v_id;
    end if;

    if not found then v_hasil := 'TIDAK_DITEMUKAN';
    elsif nullif(btrim(coalesce(v_m.no_anggota, '')), '') is not null and btrim(v_m.no_anggota) <> '-' then
      v_hasil := 'SUDAH_PUNYA'; v_no := v_m.no_anggota;
    elsif coalesce(v_m.tipe, 'Siswa') <> 'Siswa' then v_hasil := 'BUKAN_SISWA';
    elsif coalesce(v_m.lifecycle, 'AKTIF') <> 'AKTIF' then v_hasil := 'BUKAN_AKTIF';
    elsif not p_eksekusi then v_hasil := 'AKAN_DIPROSES';
    else
      v_try := 0;
      loop
        v_try := v_try + 1;
        v_no := 'SL-' || lpad(nextval('public.no_anggota_seq')::text, 5, '0');
        continue when exists (select 1 from public.members where no_anggota = v_no);   -- bentrok manual: ambil nomor berikutnya
        begin
          update public.members set no_anggota = v_no, status = 'Anggota' where id = v_m.id;
          v_hasil := 'BERHASIL'; exit;
        exception when unique_violation then
          if v_try >= 5 then v_hasil := 'GAGAL_KONFLIK'; v_no := null; exit; end if;
        end;
      end loop;
    end if;

    if v_hasil in ('BERHASIL') then v_ok := v_ok + 1;
    elsif v_hasil in ('TIDAK_DITEMUKAN','GAGAL_KONFLIK') then v_fail := v_fail + 1;
    elsif v_hasil <> 'AKAN_DIPROSES' then v_skip := v_skip + 1; end if;

    -- bulk (p_member_ids null) tidak memuat baris yang dilewati: bukan target, hanya dihitung
    if v_hasil in ('BERHASIL','AKAN_DIPROSES','GAGAL_KONFLIK','TIDAK_DITEMUKAN') or p_member_ids is not null then
      v_rows := v_rows || jsonb_build_object('id', v_id, 'nama', v_m.nama, 'kelas', v_m.kelas,
                  'no_anggota', v_no, 'hasil', v_hasil, 'ada_kartu', (v_m.barcode_id is not null));
    end if;
  end loop;

  return json_build_object('eksekusi', p_eksekusi,
    'target', (select count(*) from jsonb_array_elements(v_rows) r where r->>'hasil' in ('BERHASIL','AKAN_DIPROSES','GAGAL_KONFLIK')),
    'berhasil', v_ok, 'dilewati', v_skip, 'gagal', v_fail, 'rows', v_rows);
end;
$function$;

revoke all on function public.generate_no_anggota(uuid[], boolean) from public, anon;
grant execute on function public.generate_no_anggota(uuid[], boolean) to authenticated;
grant usage on sequence public.no_anggota_seq to authenticated;
