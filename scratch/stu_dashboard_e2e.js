/* Dashboard siswa mandiri — browser sungguhan + backend Supabase NYATA, anon (tanpa login petugas).
   Kartu uji dari env: CARD_A, CARD_B (dua siswa berbeda). Tidak ada tulis ke database. */
const { chromium } = require('playwright');
const ok = (n, d) => console.log('PASS — ' + n + ' :: ' + d);
let gagal = 0;
const no = (n, d) => { gagal++; console.log('FAIL — ' + n + ' :: ' + d); };
const cek = (n, c, d) => (c ? ok : no)(n, d);

(async () => {
  const b = await chromium.launch({ headless: true });
  const jalan = async (vp, label) => {
    const c = await b.newContext({ viewport: vp, permissions: [] });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' ')));
    await p.goto('http://127.0.0.1:8000/index.html', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled && typeof window.goPage === 'function');
    await p.evaluate(() => goPage('pub-akses'));
    const teks = () => p.evaluate(() => document.getElementById('page-pub-akses').innerText.replace(/\s+/g, ' '));
    const cari = async kode => {
      await p.fill('#stuInputManual', kode);
      await p.click('text=Cek Akses');
    };

    // kartu valid A (huruf kecil: server harus tetap mengenali)
    await cari(process.env.CARD_A.toLowerCase());
    await p.waitForSelector('#stuStateSuccess .stu-grid', { timeout: 20000 });
    const a = await teks();
    cek(label + ' kartu A tampil', a.includes('ASMA INAYA RAFA') && a.includes('Kelas 6B'), 'nama+kelas tampil');
    const nums = await p.$$eval('.stu-num', e => e.map(x => x.textContent));
    cek(label + ' angka A = DB', JSON.stringify(nums) === JSON.stringify(['5', '0', '19', '0']), 'kunjungan,baca,pulang,kelas = ' + nums.join(','));
    cek(label + ' tidak ada data sensitif', !/NISN|nisn|barcode|STU-2C3C|noAnggota/i.test(a), 'tidak ada NISN/barcode di halaman');
    // tanpa horizontal scroll
    const lebar = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    cek(label + ' tanpa scroll horizontal', lebar, 'scrollWidth <= viewport');
    await p.screenshot({ path: 'scratch/stu_' + label + '.png', fullPage: true });

    // scan kartu lain setelah dashboard tampil: harus ganti penuh, tidak bocor A
    await p.click('text=Scan Kartu Lain');
    await cari(process.env.CARD_B);
    await p.waitForFunction(() => /HAFIZA KHAIRA/.test(document.getElementById('stuStateSuccess').innerText), null, { timeout: 20000 });
    const bt = await teks();
    cek(label + ' kartu B menggantikan A', !bt.includes('ASMA INAYA') && bt.includes('Sedang dipinjam'), 'B: tidak ada sisa A, ada buku dipinjam');

    // kartu tak terdaftar
    await p.click('text=Scan Kartu Lain');
    await cari('STU-ZZZZZZZZ');
    await p.waitForSelector('#stuStateNotfound', { state: 'visible', timeout: 20000 });
    cek(label + ' kartu tak terdaftar', true, 'tampil pesan Kartu Tidak Ditemukan');
    await p.click('#stuStateNotfound button');

    // jaringan putus
    await c.setOffline(true);
    await cari(process.env.CARD_A);
    await p.waitForSelector('#stuStateError', { state: 'visible', timeout: 20000 });
    cek(label + ' jaringan gagal', /koneksi|Coba/i.test(await p.textContent('#stuErrMsg')), await p.textContent('#stuErrMsg'));
    await c.setOffline(false);
    await p.waitForTimeout(500);

    // respons kosong/aneh dari server
    await p.click('#stuStateError button');
    await p.route('**/rpc/student_lookup', r => r.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
    await cari(process.env.CARD_A);
    await p.waitForFunction(() => /tidak lengkap/.test(document.getElementById('stuErrMsg').textContent), null, { timeout: 20000 });
    cek(label + ' respons kosong', await p.isVisible('#stuStateError'), 'tampil state error, bukan dashboard kosong');
    await p.unroute('**/rpc/student_lookup');

    // kamera tidak tersedia / ditolak -> input manual tetap ada
    await p.click('#stuStateError button');
    await p.click('text=Scan Kartu dengan Kamera', { timeout: 5000 });
    await p.waitForTimeout(1500);
    const manual = await p.isVisible('#stuInputManual');
    cek(label + ' kamera ditolak -> input manual', manual, 'input manual terlihat setelah kamera gagal');

    cek(label + ' tanpa pageerror', errs.length === 0, errs.join(' | ') || 'bersih');
    await c.close();
  };
  await jalan({ width: 390, height: 844 }, 'hp');
  await jalan({ width: 1366, height: 800 }, 'desktop');

  // anon tidak boleh membaca tabel privat
  const c = await b.newContext(); const p = await c.newPage();
  await p.goto('http://127.0.0.1:8000/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled);
  const akses = await p.evaluate(async () => {
    const sb = LibraryAPI.client, out = {};
    for (const t of ['members', 'loans', 'reading_activities', 'visits', 'loan_sessions']) {
      const r = await sb.from(t).select('*').limit(1); out[t] = r.error ? 'ditolak' : (r.data.length ? 'BOCOR' : 'kosong');
    }
    for (const f of ['riwayat_siswa', 'dashboard_stats', 'aktivitas_ranking']) {
      const r = await sb.rpc(f, f === 'riwayat_siswa' ? { p_member_id: '00000000-0000-0000-0000-000000000000' } : f === 'aktivitas_ranking' ? { p_jenis: 'baca_ditempat', p_days: 30, p_limit: 5 } : {});
      out[f] = r.error ? 'ditolak' : 'BOCOR';
    }
    const l = await sb.rpc('student_lookup', { p_key: 'AB' });
    out.kunci_pendek = JSON.stringify(l.data);
    return out;
  });
  console.log(JSON.stringify(akses));
  cek('anon tabel privat', ['members', 'loans', 'reading_activities', 'visits', 'loan_sessions'].every(t => akses[t] !== 'BOCOR'), 'tidak ada baris bocor');
  cek('anon RPC petugas', ['riwayat_siswa', 'dashboard_stats', 'aktivitas_ranking'].every(f => akses[f] === 'ditolak'), 'ditolak');
  await b.close();
  console.log(gagal ? 'GAGAL: ' + gagal : 'SEMUA LULUS');
  process.exit(gagal ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
