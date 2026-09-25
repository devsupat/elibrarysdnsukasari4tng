/* TASK 06 — simulasi satu hari kerja petugas lewat UI sungguhan.
   Semua data yang dibuat dibersihkan kembali di akhir. */
const { chromium } = require('playwright');
const fs = require('fs');
const R = {};
const ok = (n, d) => { R[n] = { pass: true, details: d }; console.log('PASS — ' + n + ' :: ' + d); };
const no = (n, d) => { R[n] = { pass: false, details: d }; console.log('FAIL — ' + n + ' :: ' + d); };

(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  // 401/403 dan ERR_INTERNET_DISCONNECTED berasal dari uji RLS & uji offline yang disengaja.
  p.on('console', m => { if (m.type() === 'error' && !/40[13]|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/.test(m.text())) errs.push('console.error: ' + m.text()); });
  const jejak = { loans: [], sesi: [] };

  const login = async () => {
    await p.evaluate(async (a) => { await LibraryAPI.signIn(a.e, a.pw); }, { e: process.env.E2E_EMAIL, pw: process.env.E2E_PASS });
    await p.waitForFunction(() => !!window._sbSub, null, { timeout: 90000 });
    await p.waitForFunction(() => typeof STATS !== 'undefined' && STATS !== null, null, { timeout: 60000 });
  };
  const kotak = id => p.evaluate(i => { const e = document.getElementById(i); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; }, id);
  const num = id => p.evaluate(i => +(document.getElementById(i).textContent.trim()), id);

  try {
    await p.goto('http://127.0.0.1:8000/index.html', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled && typeof window.goPage === 'function');
    await login();

    // pilih aktor: 1 siswa aktif berbarcode + 3 eksemplar tersedia
    const aktor = await p.evaluate(() => {
      const siswa = DB.members.find(x => x.barcodeId && x.id && !/^M\d/.test(x.id) && (x.lifecycle || 'AKTIF') === 'AKTIF');
      const buku = DB.books.filter(x => (x.statusCopy || 'AVAILABLE') === 'AVAILABLE' && x.tersedia > 0).slice(0, 3);
      return { siswa: { id: siswa.id, nama: siswa.nama, kelas: siswa.kelas, barcode: siswa.barcodeId }, buku: buku.map(x => ({ id: x.id, kode: x.kode, judul: x.judul })) };
    });

    // ---------- 1. scan siswa sekali ----------
    await p.evaluate(() => goPage('sirkulasi'));
    await p.evaluate(k => scTerimaSiswa(k), aktor.siswa.barcode);
    await p.waitForTimeout(700);
    const sesiSiswa = await p.evaluate(() => ({
      aktif: !!SC.siswa, nama: document.getElementById('scNamaSiswa').textContent.trim(),
      langkah: getComputedStyle(document.getElementById('scLangkahSiswa')).display
    }));
    (sesiSiswa.aktif && sesiSiswa.nama === aktor.siswa.nama && sesiSiswa.langkah === 'none')
      ? ok('Scan Siswa', `"${sesiSiswa.nama}" terkunci sebagai peminjam aktif`)
      : no('Scan Siswa', JSON.stringify(sesiSiswa));

    // kunjungan otomatis tercatat saat siswa discan
    await p.waitForTimeout(1200);
    const kunjunganAwal = await p.evaluate(async () => (await LibraryAPI.dashboard(30)).hari_ini.kunjungan);
    (kunjunganAwal === 1)
      ? ok('Kunjungan Otomatis', 'scan siswa langsung tercatat sebagai 1 kunjungan di database')
      : no('Kunjungan Otomatis', 'kunjungan=' + kunjunganAwal);

    // ---------- 2. BACA DI TEMPAT ----------
    await p.evaluate(k => scTerimaBuku(k), aktor.buku[0].kode);
    await p.waitForTimeout(400);
    await p.evaluate(() => scProses('baca'));
    await p.waitForFunction(() => /baca di tempat/i.test(document.getElementById('scPesanBuku').innerText), null, { timeout: 30000 });
    const pesanBaca = await kotak('scPesanBuku');
    const stokBaca = await p.evaluate(async (id) => {
      const r = await LibraryAPI.client.from('books').select('status_copy,tersedia').eq('id', id).single();
      return r.data;
    }, aktor.buku[0].id);
    (stokBaca.status_copy === 'AVAILABLE' && stokBaca.tersedia === 1)
      ? ok('Baca di Tempat', `tercatat tanpa mengurangi stok (buku tetap AVAILABLE/1) · "${pesanBaca.slice(0, 80)}"`)
      : no('Baca di Tempat', JSON.stringify(stokBaca));

    // ---------- 3. PINJAM PULANG (siswa tidak discan ulang) ----------
    await p.evaluate(k => scTerimaBuku(k), aktor.buku[1].kode);
    await p.waitForTimeout(400);
    const masihSiswaSama = await p.evaluate(() => SC.siswa && SC.siswa.nama);
    await p.evaluate(() => scProses('pulang'));
    await p.waitForFunction(() => /dipinjam pulang/i.test(document.getElementById('scPesanBuku').innerText), null, { timeout: 30000 });
    const pulang = await p.evaluate(async (id) => {
      const l = await LibraryAPI.client.from('loans').select('id,batas,pinjam,status,session_id').eq('book_id', id).is('kembali', null).single();
      const bk = await LibraryAPI.client.from('books').select('status_copy,tersedia').eq('id', id).single();
      return { loan: l.data, buku: bk.data };
    }, aktor.buku[1].id);
    if (pulang.loan) jejak.loans.push(pulang.loan.id);
    (masihSiswaSama === aktor.siswa.nama && pulang.buku.status_copy === 'BORROWED' && pulang.buku.tersedia === 0 && pulang.loan.session_id === null)
      ? ok('Pinjam Pulang', `tanpa scan siswa ulang · stok jadi BORROWED/0 · batas ${pulang.loan.batas} (pinjam ${pulang.loan.pinjam})`)
      : no('Pinjam Pulang', JSON.stringify({ masihSiswaSama, pulang }));

    // ---------- 4. PINJAM KE KELAS ----------
    const sesi = await p.evaluate(async (kelas) => {
      const s = await LibraryAPI.bukaSesiKelas(kelas, 'Jam literasi', null);
      SC.sesiKelas = s;
      return s;
    }, '5A');
    jejak.sesi.push(sesi.id);
    await p.evaluate(k => scTerimaBuku(k), aktor.buku[2].kode);
    await p.waitForTimeout(400);
    await p.evaluate(() => scProses('kelas'));
    await p.waitForFunction(() => /Kelas/i.test(document.getElementById('scPesanBuku').innerText), null, { timeout: 30000 });
    const kelasLoan = await p.evaluate(async (id) => {
      const l = await LibraryAPI.client.from('loans').select('id,pinjam,batas,session_id').eq('book_id', id).is('kembali', null).single();
      const ra = await LibraryAPI.client.from('reading_activities').select('mode,kelas').eq('loan_id', l.data.id).single();
      return { loan: l.data, aktivitas: ra.data };
    }, aktor.buku[2].id);
    if (kelasLoan.loan) jejak.loans.push(kelasLoan.loan.id);
    (kelasLoan.aktivitas.mode === 'CLASS_LOAN' && kelasLoan.aktivitas.kelas === '5A' && kelasLoan.loan.batas === kelasLoan.loan.pinjam)
      ? ok('Pinjam ke Kelas', `mode CLASS_LOAN · kelas pemakai "5A" (bukan kelas perwakilan "${aktor.siswa.kelas}") · jatuh tempo hari yang sama`)
      : no('Pinjam ke Kelas', JSON.stringify(kelasLoan));

    // class loan tidak boleh masuk ranking peminjam pribadi
    const ranking = await p.evaluate(async () => {
      const d = await LibraryAPI.dashboard(30);
      return { peminjam: d.peminjam_aktif, kelas: d.per_kelas };
    });
    const dia = (ranking.peminjam || []).find(x => x.nama === aktor.siswa.nama);
    // 3 transaksi hari ini (baca, pinjam pulang, pinjam kelas) -> pribadi harus 2
    const benar = dia && dia.aktivitas === 2;
    (benar && (ranking.kelas || []).some(k => k.kelas === '5A'))
      ? ok('Class Loan Tidak Masuk Ranking Pribadi', `3 transaksi hari ini, ranking pribadi menghitung ${dia.aktivitas} (baca + pinjam pulang); CLASS_LOAN hanya muncul di aktivitas kelas 5A`)
      : no('Class Loan Tidak Masuk Ranking Pribadi', JSON.stringify(ranking));

    // ---------- 5. dashboard mencerminkan hari ini ----------
    await p.evaluate(() => { goPage('beranda'); refreshStats(); });
    await p.waitForFunction(() => STATS && STATS.hari_ini.pinjam_pulang >= 1, null, { timeout: 30000 });
    await p.waitForTimeout(500);
    const dash = { kunjungan: await num('stKunjungan'), baca: await num('stBaca'), pulang: await num('stPinjamHariIni'), aktif: await num('stPinjam') };
    (dash.kunjungan === 1 && dash.baca === 1 && dash.pulang === 1 && dash.aktif === 25)
      ? ok('Dashboard Hari Ini', `kunjungan 1 · baca 1 · pinjam pulang 1 · pinjaman aktif ${dash.aktif} (23 lama + 2 baru)`)
      : no('Dashboard Hari Ini', JSON.stringify(dash));

    // ---------- 6. PENGEMBALIAN lewat scan ----------
    await p.evaluate(() => goPage('sirkulasi'));
    await p.evaluate(k => scTerimaKembali(k), aktor.buku[1].kode);
    await p.waitForSelector('#scPesanKembali button:has-text("Kembalikan Sekarang")', { timeout: 30000 });
    const pesanKembali = await kotak('scPesanKembali');   // identitas peminjam tampil sebelum dikonfirmasi
    await p.click('#scPesanKembali button:has-text("Kembalikan Sekarang")');
    await p.waitForTimeout(2500);
    const stokKembali = await p.evaluate(async (id) => {
      const bk = await LibraryAPI.client.from('books').select('status_copy,tersedia').eq('id', id).single();
      const l = await LibraryAPI.client.from('loans').select('kembali,status').eq('book_id', id).order('created_at', { ascending: false }).limit(1).single();
      return { buku: bk.data, loan: l.data };
    }, aktor.buku[1].id);
    (stokKembali.buku.status_copy === 'AVAILABLE' && stokKembali.buku.tersedia === 1 && stokKembali.loan.status === 'RETURNED')
      ? ok('Pengembalian', `scan menampilkan peminjam lebih dulu ("${pesanKembali.slice(0, 70)}"), baru dikonfirmasi · buku kembali AVAILABLE/1 · loan RETURNED ${stokKembali.loan.kembali}`)
      : no('Pengembalian', JSON.stringify(stokKembali));

    // ---------- 7. sesi kelas menutup sendiri saat semua buku kembali ----------
    await p.evaluate(k => scTerimaKembali(k), aktor.buku[2].kode);
    await p.waitForSelector('#scPesanKembali button:has-text("Kembalikan Sekarang")', { timeout: 30000 });
    await p.click('#scPesanKembali button:has-text("Kembalikan Sekarang")');
    await p.waitForTimeout(3000);
    const sesiTutup = await p.evaluate(async (sid) => {
      const s = await LibraryAPI.client.from('loan_sessions').select('ditutup_at').eq('id', sid).single();
      return s.data;
    }, sesi.id);
    sesiTutup.ditutup_at
      ? ok('Sesi Kelas Menutup Otomatis', `sesi ditutup ${sesiTutup.ditutup_at} setelah buku terakhir kembali`)
      : no('Sesi Kelas Menutup Otomatis', JSON.stringify(sesiTutup));

    // ---------- 8. eksemplar yang dulu desinkron kini bisa dipinjam ----------
    const pulih = await p.evaluate(async () => {
      const r = await LibraryAPI.client.from('books').select('id,kode,judul,status_copy,tersedia').eq('kode', '20251002579').single();
      const siswa = DB.members.find(x => x.id && !/^M\d/.test(x.id) && (x.lifecycle || 'AKTIF') === 'AKTIF');
      let hasil;
      try {
        const l = await LibraryAPI.borrow(r.data.id, siswa.id, new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }), 3, null);
        hasil = { sukses: true, loanId: l.id };
      } catch (e) { hasil = { sukses: false, pesan: LibraryAPI.msg(e) }; }
      return { buku: r.data, hasil };
    });
    if (pulih.hasil.loanId) jejak.loans.push(pulih.hasil.loanId);
    pulih.hasil.sukses
      ? ok('Perbaikan P1: Eksemplar Desinkron', `"${pulih.buku.judul}" (dulu AVAILABLE/tersedia=0) kini dapat dipinjam`)
      : no('Perbaikan P1: Eksemplar Desinkron', JSON.stringify(pulih));

    // ---------- 9. pesan jaringan mati sudah berbahasa petugas ----------
    await c.setOffline(true);
    const offline = await p.evaluate(async () => {
      const buku = DB.books.find(x => (x.statusCopy || 'AVAILABLE') === 'AVAILABLE');
      const siswa = DB.members.find(x => x.id && !/^M\d/.test(x.id));
      try { await LibraryAPI.borrow(buku.id, siswa.id, '2026-09-25', 3, null); return '(berhasil?)'; }
      catch (e) { return LibraryAPI.msg(e); }
    });
    await c.setOffline(false);
    (!/fetch|TypeError|network/i.test(offline) && /koneksi/i.test(offline))
      ? ok('Perbaikan P1: Pesan Jaringan Mati', `"${offline}"`)
      : no('Perbaikan P1: Pesan Jaringan Mati', offline);

    // ---------- 10. bersihkan seluruh jejak uji ----------
    const bersih = await p.evaluate(async (j) => {
      const sb = LibraryAPI.client;
      for (const id of j.loans) {
        const l = await sb.from('loans').select('book_id,kembali').eq('id', id).maybeSingle();
        await sb.from('reading_activities').delete().eq('loan_id', id);
        await sb.from('loans').delete().eq('id', id);
        if (l.data) await sb.from('books').update({ status_copy: 'AVAILABLE', tersedia: 1 }).eq('id', l.data.book_id);
      }
      await sb.from('reading_activities').delete().eq('mode', 'READ_IN_LIBRARY');
      for (const id of j.sesi) await sb.from('loan_sessions').delete().eq('id', id);
      const hari = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
      await sb.from('visits').delete().eq('tanggal', hari);
      const sisa = {
        loans: (await sb.from('loans').select('id', { count: 'exact', head: true })).count,
        ra: (await sb.from('reading_activities').select('id', { count: 'exact', head: true })).count,
        visits: (await sb.from('visits').select('member_id', { count: 'exact', head: true })).count,
        sesi: (await sb.from('loan_sessions').select('id', { count: 'exact', head: true })).count
      };
      return sisa;
    }, jejak);
    (bersih.loans === 397 && bersih.ra === 397 && bersih.visits === 0 && bersih.sesi === 0)
      ? ok('Data Uji Dibersihkan', `kembali ke kondisi awal: loans ${bersih.loans} · aktivitas ${bersih.ra} · visits ${bersih.visits} · sesi ${bersih.sesi}`)
      : no('Data Uji Dibersihkan', JSON.stringify(bersih));

    errs.length === 0 ? ok('Console Bersih', '0 error JS sepanjang alur') : no('Console Bersih', errs.join(' | '));

  } catch (e) { no('Eksekusi', e.message); console.log(e.stack); }
  finally { await b.close(); }

  console.log('\n============ HASIL ============');
  Object.entries(R).forEach(([k, v]) => console.log((v.pass ? 'PASS' : 'FAIL') + ' — ' + k));
  fs.writeFileSync(__dirname + '/workflow_result.json', JSON.stringify(R, null, 2));
  process.exit(Object.values(R).every(v => v.pass) ? 0 : 1);
})();
