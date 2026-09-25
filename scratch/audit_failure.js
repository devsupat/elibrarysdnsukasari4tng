/* TASK 06 — failure testing: apa yang dilihat petugas saat hal buruk terjadi. */
const { chromium } = require('playwright');
const F = [];
const found = (sev, judul, bukti) => { F.push({ sev, judul, bukti }); console.log(`${sev} — ${judul}\n      bukti: ${bukti}`); };
const okk = (judul, bukti) => { console.log(`OK  — ${judul} :: ${bukti}`); };

(async () => {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));

  const login = async () => {
    await p.evaluate(async (a) => { await LibraryAPI.signIn(a.e, a.pw); }, { e: process.env.E2E_EMAIL, pw: process.env.E2E_PASS });
    await p.waitForFunction(() => !!window._sbSub, null, { timeout: 90000 });
  };

  try {
    await p.goto('http://127.0.0.1:8000/index.html', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled && typeof window.goPage === 'function');
    await login();

    // ---------- 1. Buku AVAILABLE tapi tersedia=0 (desinkron warisan impor) ----------
    const desync = await p.evaluate(async () => {
      const r = await LibraryAPI.client.from('books').select('id,kode,judul,status_copy,tersedia')
        .eq('status_copy', 'AVAILABLE').eq('tersedia', 0).limit(5);
      return r.data || [];
    });
    if (desync.length) {
      // apa yang dilihat petugas saat memindai buku ini?
      const sim = await p.evaluate(async (bk) => {
        const buku = DB.books.find(x => x.id === bk.id);
        const uiStatus = buku ? (buku.statusCopy || 'AVAILABLE') : '(tidak ada di cache)';
        const siswa = DB.members.find(x => x.id && !/^M\d/.test(x.id) && (x.lifecycle || 'AKTIF') === 'AKTIF');
        let pesan = null;
        try { await LibraryAPI.borrow(bk.id, siswa.id, new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }), 3, null); pesan = '(BERHASIL — tidak seharusnya)'; }
        catch (e) { pesan = LibraryAPI.msg(e); }
        return { uiStatus, pesan, judul: buku && buku.judul };
      }, desync[0]);
      found('P1', 'Eksemplar ada di rak tapi tidak bisa dipinjam',
        `${desync.length}+ eksemplar status_copy=AVAILABLE tapi tersedia=0. UI menampilkan "${sim.uiStatus}" (tombol pinjam muncul), lalu borrow_book menolak: "${sim.pesan}" — contoh "${sim.judul}"`);
    } else okk('Konsistensi tersedia/status_copy', 'tidak ada eksemplar desinkron');

    // ---------- 2. Jaringan mati saat transaksi ----------
    await c.setOffline(true);
    const offline = await p.evaluate(async () => {
      const buku = DB.books.find(x => (x.statusCopy || 'AVAILABLE') === 'AVAILABLE' && x.tersedia > 0);
      const siswa = DB.members.find(x => x.id && !/^M\d/.test(x.id));
      try { await LibraryAPI.borrow(buku.id, siswa.id, '2026-09-25', 3, null); return { pesan: '(berhasil?)' }; }
      catch (e) { return { mentah: (e && e.message) || String(e), pesan: LibraryAPI.msg(e) }; }
    });
    await c.setOffline(false);
    if (/fetch|network|TypeError|ECONN|Load failed/i.test(offline.pesan)) {
      found('P1', 'Pesan jaringan mati tidak dapat dipahami petugas',
        `saat offline, petugas melihat: "${offline.pesan}" (mentah: "${offline.mentah}")`);
    } else okk('Pesan jaringan mati', offline.pesan);

    // ---------- 3. Sesi kedaluwarsa / token tidak valid ----------
    const expired = await p.evaluate(async () => {
      const raw = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
      const asli = localStorage.getItem(raw);
      try {
        const j = JSON.parse(asli);
        j.access_token = j.access_token.slice(0, -6) + 'xxxxxx';   // token dirusak
        localStorage.setItem(raw, JSON.stringify(j));
        await LibraryAPI.client.auth.signOut({ scope: 'local' });
        localStorage.setItem(raw, JSON.stringify(j));
        const r = await LibraryAPI.client.from('loans').select('id').limit(1);
        return { err: r.error ? r.error.message : null, pesan: r.error ? LibraryAPI.msg(r.error) : '(berhasil)' };
      } finally { localStorage.setItem(raw, asli); }
    });
    if (expired.err && /JWT|token|expired|401|signature/i.test(expired.pesan)) {
      found('P1', 'Sesi kedaluwarsa menampilkan istilah teknis',
        `petugas melihat: "${expired.pesan}"`);
    } else okk('Sesi kedaluwarsa', expired.pesan);
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled);
    await login();

    // ---------- 4. Klik ganda pada tombol transaksi ----------
    const ganda = await p.evaluate(async () => {
      const buku = DB.books.find(x => (x.statusCopy || 'AVAILABLE') === 'AVAILABLE' && x.tersedia > 0);
      const siswa = DB.members.find(x => x.id && !/^M\d/.test(x.id) && (x.lifecycle || 'AKTIF') === 'AKTIF');
      const hari = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
      const hasil = await Promise.allSettled([
        LibraryAPI.borrow(buku.id, siswa.id, hari, 3, null),
        LibraryAPI.borrow(buku.id, siswa.id, hari, 3, null)
      ]);
      const sukses = hasil.filter(r => r.status === 'fulfilled');
      // bersihkan: kembalikan pinjaman uji
      for (const r of sukses) { try { await LibraryAPI.returnLoan(r.value.id); } catch (_) {} }
      for (const r of sukses) { try { await LibraryAPI.deleteLoan(r.value.id); } catch (_) {} }
      return {
        sukses: sukses.length,
        pesanGagal: hasil.filter(r => r.status === 'rejected').map(r => LibraryAPI.msg(r.reason))
      };
    });
    (ganda.sukses === 1)
      ? okk('Klik ganda / scan ganda', `hanya 1 pinjaman terbentuk; yang kedua ditolak: "${ganda.pesanGagal[0]}"`)
      : found('P0', 'Transaksi ganda lolos', JSON.stringify(ganda));

    // ---------- 5. Refresh saat alur sirkulasi berjalan ----------
    const sebelum = await p.evaluate(() => {
      const siswa = DB.members.find(x => x.id && !/^M\d/.test(x.id) && (x.lifecycle || 'AKTIF') === 'AKTIF');
      goPage('sirkulasi'); scTerimaSiswa(siswa.barcodeId);
      return { nama: siswa.nama, aktif: !!SC.siswa };
    });
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled);
    await login();
    const sesudah = await p.evaluate(() => {
      goPage('sirkulasi');
      return {
        siswa: typeof SC !== 'undefined' ? !!SC.siswa : null,
        langkahTampil: getComputedStyle(document.getElementById('scLangkahSiswa')).display,
        sesiTampil: getComputedStyle(document.getElementById('scSesiSiswa')).display
      };
    });
    (!sesudah.siswa && sesudah.langkahTampil !== 'none')
      ? okk('Refresh saat alur berjalan', `kembali ke langkah scan siswa dengan bersih (sebelumnya "${sebelum.nama}")`)
      : found('P2', 'State sirkulasi setelah refresh membingungkan', JSON.stringify(sesudah));

    // ---------- 6. Barcode ganda antar anggota ----------
    const dup = await p.evaluate(async () => {
      const a = DB.members.find(x => x.barcodeId && x.id && !/^M\d/.test(x.id));
      const b2 = DB.members.find(x => x.id !== a.id && x.id && !/^M\d/.test(x.id));
      const asli = b2.barcodeId;
      try {
        const r = await LibraryAPI.client.from('members').update({ barcode_id: a.barcodeId }).eq('id', b2.id);
        if (!r.error) { await LibraryAPI.client.from('members').update({ barcode_id: asli }).eq('id', b2.id); return { ditolak: false }; }
        return { ditolak: true, err: r.error.message, pesan: LibraryAPI.msg(r.error) };
      } catch (e) { return { ditolak: true, pesan: LibraryAPI.msg(e) }; }
    });
    dup.ditolak
      ? okk('Barcode ganda ditolak database', `"${dup.pesan}"`)
      : found('P1', 'Barcode ganda diterima database', 'dua anggota bisa punya barcode_id sama');

    // ---------- 7. Pengembalian ganda ----------
    const retur = await p.evaluate(async () => {
      const l = DB.loans.find(x => !x.kembali);
      if (!l) return { lewat: 'tidak ada pinjaman aktif' };
      try { await LibraryAPI.returnLoan(l.id); } catch (e) { return { gagalPertama: LibraryAPI.msg(e) }; }
      let kedua;
      try { await LibraryAPI.returnLoan(l.id); kedua = '(berhasil — tidak seharusnya)'; }
      catch (e) { kedua = LibraryAPI.msg(e); }
      // pulihkan: batalkan pengembalian uji agar data kembali seperti semula
      await LibraryAPI.client.from('loans').update({ kembali: null, status: 'BORROWED', petugas_return_id: null }).eq('id', l.id);
      await LibraryAPI.client.from('books').update({ tersedia: 0, status_copy: 'BORROWED' }).eq('id', l.bookId);
      return { kedua, judul: l.judul };
    });
    if (retur.kedua && !/PGRST|SQLSTATE|P000|exception/i.test(retur.kedua)) {
      okk('Pengembalian ganda', `ditolak dengan: "${retur.kedua}"`);
    } else found('P2', 'Pesan pengembalian ganda tidak ramah', JSON.stringify(retur));

    console.log('\npageerror: ' + (errs.length ? errs.join(' | ') : 'tidak ada'));
  } catch (e) { console.log('GAGAL EKSEKUSI: ' + e.message + '\n' + e.stack); }
  finally { await b.close(); }

  console.log('\n===== RINGKASAN TEMUAN =====');
  F.length ? F.forEach(f => console.log(`${f.sev} — ${f.judul}`)) : console.log('(tidak ada temuan)');
})();
