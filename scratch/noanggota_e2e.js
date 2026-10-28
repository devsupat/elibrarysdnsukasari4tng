/* Generate nomor anggota.
   NYATA (backend Supabase, anon): RPC ditolak. MOCK (LibraryAPI/SB_USER tiruan, tidak ada akun petugas): alur UI.
   Uji DB sebenarnya (peran authenticated, transaksi di-rollback) dijalankan lewat SQL dan dicatat di laporan. */
const { chromium } = require('playwright');
let gagal = 0;
const cek = (n, c, d) => { if (!c) gagal++; console.log((c ? 'PASS — ' : 'FAIL — ') + n + ' :: ' + d); };

(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const p = await c.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8000/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled && typeof window.goPage === 'function');
  await p.waitForTimeout(4000);

  // --- NYATA: anon tidak boleh menjalankan ---
  const anon = await p.evaluate(async () => {
    const r1 = await LibraryAPI.client.rpc('generate_no_anggota', { p_member_ids: null, p_eksekusi: true });
    const r2 = await LibraryAPI.client.from('members').update({ no_anggota: 'SL-99999' }).eq('nama', 'TIDAK ADA');
    return { rpc: r1.error ? r1.error.message : 'LOLOS', upd: r2.error ? 'ditolak' : 'tanpa error (0 baris)' };
  });
  cek('NYATA anon RPC generate ditolak', /permission denied/.test(anon.rpc), anon.rpc);

  // --- MOCK: alur UI petugas ---
  await p.evaluate(() => {
    SB_USER = { email: 'uji@mock' };
    window.__calls = []; window.__putus = false;
    DB.members = [
      { id: 'a', nama: 'SISWA A', kelas: '4A', tipe: 'Siswa', lifecycle: 'AKTIF', noAnggota: '', status: 'Non-Anggota', barcodeId: 'STU-A' },
      { id: 'b', nama: 'SISWA B', kelas: '4A', tipe: 'Siswa', lifecycle: 'AKTIF', noAnggota: '25010200001', status: 'Anggota', barcodeId: 'STU-B' },
      { id: 'c', nama: 'ALUMNI C', kelas: 'ALUMNI', tipe: 'Siswa', lifecycle: 'LULUS', noAnggota: '-', status: 'Non-Anggota', barcodeId: 'STU-C' },
      { id: 'd', nama: 'TAMU D', kelas: '', tipe: 'Tamu', lifecycle: 'AKTIF', noAnggota: '', status: 'Non-Anggota', barcodeId: '' }
    ];
    let serverNo = { a: null };
    LibraryAPI.pullMembers = async () => DB.members.map(m => ({ ...m, noAnggota: serverNo[m.id] || m.noAnggota, status: serverNo[m.id] ? 'Anggota' : m.status }));
    LibraryAPI.generateNoAnggota = async (ids, eks) => {
      __calls.push([ids ? ids.join() : 'semua', eks]);
      if (__putus && eks) throw new Error('Failed to fetch');
      if (!eks) return { eksekusi: false, target: 1, berhasil: 0, dilewati: 3, gagal: 0, rows: [{ id: 'a', nama: 'SISWA A', kelas: '4A', hasil: 'AKAN_DIPROSES', ada_kartu: true }] };
      serverNo.a = 'SL-00001';
      return { eksekusi: true, target: 1, berhasil: 1, dilewati: 3, gagal: 0, rows: [{ id: 'a', nama: 'SISWA A', hasil: 'BERHASIL', no_anggota: 'SL-00001' }] };
    };
    window.confirm = () => true;
    goPage('anggota'); document.getElementById('mFilterLife').value = ''; renderMembers();
  });
  const tombol = await p.locator('#memberTable button[title^="Generate nomor"]').count();
  cek('MOCK tombol 🔢 hanya untuk siswa AKTIF tanpa nomor', tombol === 1, 'tombol=' + tombol + ' (A saja; B bernomor, C lulus, D tamu)');

  await p.click('#noGenBtn');
  await p.waitForSelector('#noGoBtn');
  const pratinjau = await p.innerText('#noBody');
  cek('MOCK pratinjau menjelaskan aturan', /SISWA A/.test(pratinjau) && /SL-00001/.test(pratinjau) && /menjadi Anggota/.test(pratinjau) && /tidak.*diproses/i.test(pratinjau), 'target, format, status, yang dilewati tampil');
  cek('MOCK pratinjau tidak menulis', (await p.evaluate(() => __calls.map(x => x[1]).join())) === 'false', 'panggilan eksekusi=false');

  // jaringan putus saat eksekusi: tidak ada sukses palsu
  await p.evaluate(() => (__putus = true));
  await p.click('#noGoBtn'); await p.waitForTimeout(500);
  const putus = await p.innerText('#noBody');
  cek('MOCK jaringan putus: tanpa sukses palsu', /Tidak ada koneksi/.test(putus) && !/Selesai/.test(putus), putus.slice(0, 60));
  await p.evaluate(() => (__putus = false));

  // klik ganda
  await p.click('#noBody button:has-text("Periksa ulang")'); await p.waitForSelector('#noGoBtn');
  await p.evaluate(() => { __calls.length = 0; });
  await p.evaluate(() => { const b = document.getElementById('noGoBtn'); b.click(); b.click(); noAnggotaJalankan(); });
  await p.waitForSelector('#noBody:has-text("Selesai")');
  const eksekusi = await p.evaluate(() => __calls.filter(x => x[1] === true).length);
  cek('MOCK klik ganda = satu eksekusi', eksekusi === 1, 'eksekusi=' + eksekusi);
  const hasil = await p.innerText('#noBody');
  cek('MOCK ringkasan berhasil/dilewati/gagal', /Berhasil:\s*1/.test(hasil) && /Dilewati:\s*3/.test(hasil) && /Gagal:\s*0/.test(hasil), hasil.replace(/\s+/g, ' ').slice(0, 70));
  await p.click('#noBody >> text=Tutup');
  const sel = await p.evaluate(() => [...document.querySelectorAll('#memberTable tr')].map(r => r.innerText.replace(/\s+/g, ' ')).find(t => t.includes('SISWA A')));
  cek('MOCK tabel dimuat ulang dari server', /SL-00001/.test(sel) && /Anggota/.test(sel), sel.slice(0, 80));
  cek('MOCK nomor lama & lulus tak berubah', await p.evaluate(() => DB.members.find(m => m.id === 'b').noAnggota === '25010200001' && DB.members.find(m => m.id === 'c').noAnggota === '-'), 'B dan C utuh');
  cek('tanpa pageerror', errs.length === 0, errs.join('|') || 'bersih');
  await b.close();
  console.log(gagal ? 'GAGAL: ' + gagal : 'SEMUA LULUS');
  process.exit(gagal ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
