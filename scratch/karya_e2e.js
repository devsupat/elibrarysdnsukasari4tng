/* Galeri karya siswa — browser sungguhan + backend Supabase NYATA, anon (perangkat/sesi baru tiap fase).
   Fase: with | edited | hidden | empty | mock. Baris uji dibuat/diubah/dihapus lewat SQL oleh penguji (legacy_id 'uji-e2e:%'). */
const { chromium } = require('playwright');
const fase = process.argv[2] || 'with';
let gagal = 0;
const cek = (n, c, d) => { if (!c) gagal++; console.log((c ? 'PASS — ' : 'FAIL — ') + n + ' :: ' + d); };
const URL = 'http://127.0.0.1:8000/index.html';

async function buka(b, vp, opsi = {}) {
  const c = await b.newContext({ viewport: vp });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  if (opsi.putus) await p.route('**/rest/v1/rpc/karya_publik', r => r.abort());
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled && typeof window.goPage === 'function');
  return { c, p, errs };
}
const txt = (p, id) => p.evaluate(i => document.getElementById(i).innerText.replace(/\s+/g, ' ').trim(), id);

(async () => {
  const b = await chromium.launch({ headless: true });

  if (fase === 'with' || fase === 'edited' || fase === 'hidden' || fase === 'empty') {
    for (const [label, vp] of [['hp', { width: 390, height: 844 }], ['desktop', { width: 1366, height: 800 }]]) {
      const { c, p, errs } = await buka(b, vp);
      await p.waitForFunction(() => KP.okPrev && KP.okFull, null, { timeout: 20000 });
      const beranda = await txt(p, 'pubKaryaPreviewGrid');
      await p.evaluate(() => goPage('pub-karya'));
      const semua = await txt(p, 'pubKaryaFullGrid');
      const html = await p.content();
      if (fase === 'empty') {
        cek(label + ' kosong: beranda', beranda === '✍️ Galeri karya siswa belum tersedia.', beranda);
        cek(label + ' kosong: galeri', semua === '✍️ Galeri karya siswa belum tersedia.', semua);
        cek(label + ' tanpa kartu', (await p.locator('#pubKaryaFullGrid .karya-skeleton-card').count()) === 0, '0 kartu');
      } else {
        const judulPub = fase === 'edited' ? 'UJI PUBLISHED CERITA DIUBAH' : 'UJI PUBLISHED CERITA';
        const adaCerita = semua.includes(judulPub) && (fase === 'edited' ? true : !semua.includes('DIUBAH'));
        cek(label + ' karya terbit tampil di galeri', adaCerita && (fase === 'hidden' ? false : true) || fase === 'hidden' && !semua.includes('UJI PUBLISHED CERITA'), fase);
        if (fase !== 'hidden') cek(label + ' karya terbit tampil di beranda', beranda.includes(judulPub), 'beranda memuat ' + judulPub);
        cek(label + ' draft/hidden tidak ada di halaman', !/RAHASIA|SISWA DRAFT|SISWA HIDDEN/.test(html), 'tak ada teks draft/hidden di DOM');
        cek(label + ' tidak ada kartu contoh palsu', !/PETUALANGAN|INDONESIAKU|SEKOLAH BERSALJU|Siswa A|Budi Santoso/.test(beranda + ' ' + semua), 'grid beranda+galeri bersih');
        if (fase === 'with') {
          const n = await p.locator('#pubKaryaFullGrid .karya-skeleton-card').count();
          cek(label + ' jumlah kartu = terbit (2)', n === 2, 'kartu=' + n);
          // foto rusak (path tak ada) tidak meninggalkan gambar pecah
          await p.waitForTimeout(1500);
          const pecah = await p.evaluate(() => [...document.querySelectorAll('#pubKaryaFullGrid img')].filter(i => i.complete && i.naturalWidth === 0).length);
          cek(label + ' tanpa gambar pecah', pecah === 0, 'img pecah=' + pecah);
          // filter kategori
          await p.click('#pubKaryaTabs button[data-grup=puisi]');
          await p.waitForFunction(() => KP.grup === 'puisi' && !KP.sibuk);
          const puisi = await txt(p, 'pubKaryaFullGrid');
          cek(label + ' filter Puisi & Pantun', puisi.includes('UJI PUBLISHED PUISI') && !puisi.includes('UJI PUBLISHED CERITA'), puisi.slice(0, 60));
          await p.click('#pubKaryaTabs button[data-grup=gambar]');
          await p.waitForFunction(() => KP.grup === 'gambar' && !KP.sibuk);
          cek(label + ' filter kosong jelas', (await txt(p, 'pubKaryaFullGrid')) === 'Belum ada karya pada kategori ini.', 'pesan kategori kosong');
          await p.click('#pubKaryaTabs button[data-grup=semua]');
          await p.waitForFunction(() => KP.grup === 'semua' && !KP.sibuk && KP.rows.length === 2);
          // baca karya
          await p.click('#pubKaryaFullGrid .karya-skeleton-card >> nth=0');
          cek(label + ' modal baca', /Pada suatu hari|Bait satu/.test(await txt(p, 'karyaReader')), (await txt(p, 'karyaReader')).slice(0, 50));
          await p.keyboard.press('Escape');
          await p.evaluate(() => document.getElementById('karyaModal').classList.remove('show'));
        }
        cek(label + ' tanpa scroll horizontal', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'ok');
        if (fase === 'with') await p.screenshot({ path: 'scratch/karya_' + label + '.png', fullPage: false });
      }
      cek(label + ' tanpa pageerror', errs.length === 0, errs.join('|') || 'bersih');
      await c.close();
    }
  }

  if (fase === 'with') {
    // anon: tabel tertutup, draft tak bisa diambil dengan id; RPC tidak membocorkan kolom internal
    const { c, p } = await buka(b, { width: 800, height: 600 });
    const r = await p.evaluate(async () => {
      const sb = LibraryAPI.client, o = {};
      const t = await sb.from('karya').select('*').limit(5); o.tabel = t.error ? 'ditolak' : 'baris=' + t.data.length;
      const d = await sb.from('karya').select('*').eq('id', '14b9ddf0-ba30-4762-82bc-2875faeaba26'); o.draft_by_id = d.error ? 'ditolak' : 'baris=' + d.data.length;
      const i = await sb.from('karya').insert({ judul: 'x', jenis: 'Puisi', isi: 'y', nama: 'z' }); o.insert = i.error ? 'ditolak' : 'LOLOS';
      const u = await sb.from('karya').update({ status: 'PUBLISHED' }).eq('id', '14b9ddf0-ba30-4762-82bc-2875faeaba26'); o.update = u.error ? 'ditolak' : 'tanpa error';
      const l = await sb.from('karya').delete().eq('id', '14b9ddf0-ba30-4762-82bc-2875faeaba26'); o.delete = l.error ? 'ditolak' : 'tanpa error';
      const rp = await sb.rpc('karya_publik', { p_jenis: null, p_limit: 999, p_offset: 0 });
      o.kolom = Object.keys(rp.data.rows[0]).join(','); o.n = rp.data.rows.length;
      const up = await sb.storage.from('karya-siswa').upload('uji-e2e/anon.webp', new Blob(['x'], { type: 'image/webp' }));
      o.upload = up.error ? 'ditolak' : 'LOLOS';
      const ls = await sb.storage.from('karya-siswa').list('');
      o.list = ls.error ? 'ditolak' : 'objek=' + (ls.data || []).length;
      return o;
    });
    console.log(JSON.stringify(r));
    cek('anon tabel karya', r.tabel === 'ditolak' && r.draft_by_id === 'ditolak', 'select ditolak');
    cek('anon tulis karya', r.insert === 'ditolak' && r.update === 'ditolak' && r.delete === 'ditolak', 'insert/update/delete ditolak');
    cek('RPC publik tanpa kolom internal', r.kolom === 'id,judul,jenis,isi,nama,kelas,foto_path,created_at' && r.n === 2, r.kolom + ' n=' + r.n);
    cek('anon storage', r.upload === 'ditolak' && (r.list === 'ditolak' || r.list === 'objek=0'), 'upload ' + r.upload + ', list ' + r.list);
    await c.close();

    // jaringan gagal -> pesan error jujur, tanpa kartu
    const w = await buka(b, { width: 390, height: 844 }, { putus: true });
    await w.p.waitForFunction(() => KP.error && KP.errPrev, null, { timeout: 20000 }).catch(() => {});
    await w.p.evaluate(() => goPage('pub-karya'));
    const e = await txt(w.p, 'pubKaryaFullGrid');
    cek('jaringan gagal', /belum bisa dimuat/.test(e) && !/Galeri karya siswa belum tersedia/.test(e), e);
    await w.c.close();
  }

  if (fase === 'mock') {
    // UI petugas dengan LibraryAPI/SB_USER TIRUAN (tidak ada akun petugas untuk uji). Bukan uji backend.
    const { c, p } = await buka(b, { width: 1300, height: 900 });
    await p.waitForTimeout(4000);   // tunggu init/sbBoot selesai agar tidak menimpa SB_USER tiruan
    await p.evaluate(() => {
      window.__calls = []; SB_USER = { email: 'uji@mock' }; KARYA_SRV = []; KARYA_ERR = '';
      window.__gagal = false;
      LibraryAPI.createKarya = async (k, blob) => { __calls.push(['create', k.status, !!blob]); if (__gagal) throw new Error('Tidak ada koneksi internet. Data belum tersimpan.'); return { id: 'm' + __calls.length, ...k, status: k.status, fotoPath: '', fotoUrl: '', legacyId: '', tgl: '2026-10-29' }; };
      LibraryAPI.updateKarya = async (id, k) => { __calls.push(['update', id, k.status]); return { id, ...k, status: k.status || 'DRAFT', fotoPath: '', fotoUrl: '', legacyId: '', tgl: '2026-10-29' }; };
      LibraryAPI.setKaryaStatus = async (id, s) => { __calls.push(['status', id, s]); const k = KARYA_SRV.find(x => x.id === id); return { ...k, status: s }; };
      LibraryAPI.deleteKarya = async (id) => { __calls.push(['delete', id]); };
      window.confirm = () => true;
      goPage('karya');
    });
    const isi = async (judul, nama = 'ANI') => { await p.fill('#kNama', nama); await p.fill('#kJudul', judul); await p.fill('#kIsi', 'isi tulisan'); };
    await isi('KARYA MOCK A');
    await p.evaluate(() => (window.__gagal = true));
    await p.click('#kBtnDraft'); await p.waitForTimeout(300);
    cek('mock: gagal simpan tidak tampil sukses', !(await p.evaluate(() => KARYA_SRV.length)) && /belum tersimpan/i.test(await p.evaluate(() => document.getElementById('toast') ? document.getElementById('toast').innerText : document.body.innerText)), 'daftar tetap kosong, form tidak direset: ' + (await p.inputValue('#kJudul')));
    await p.evaluate(() => (window.__gagal = false));
    await p.click('#kBtnDraft'); await p.waitForTimeout(300);
    cek('mock: draft tersimpan', (await p.evaluate(() => KARYA_SRV.map(k => k.status).join())) === 'DRAFT', 'status DRAFT');
    await isi('KARYA MOCK B'); await p.click('#kBtnTerbit'); await p.waitForTimeout(300);
    cek('mock: terbitkan langsung', (await p.evaluate(() => KARYA_SRV[0].status)) === 'PUBLISHED', 'PUBLISHED');
    await p.click('text=Sembunyikan'); await p.waitForTimeout(300);
    cek('mock: sembunyikan', (await p.evaluate(() => KARYA_SRV[0].status)) === 'HIDDEN', 'HIDDEN');
    await p.click('#karyaList button:has-text("Ubah") >> nth=0');
    cek('mock: mode ubah', (await p.inputValue('#kJudul')) === 'KARYA MOCK B' && (await txt(p, 'kFormJudul')).includes('Ubah'), 'form terisi');
    await p.click('#kBtnDraft'); await p.waitForTimeout(300);
    cek('mock: simpan perubahan tidak mengubah status', (await p.evaluate(() => __calls.filter(c => c[0] === 'update').map(c => String(c[2])).join())) === 'undefined', 'status tidak dikirim saat ubah');
    await p.click('#karyaList button:has-text("🗑️") >> nth=0'); await p.waitForTimeout(300);
    cek('mock: hapus', (await p.evaluate(() => KARYA_SRV.length)) === 1, 'tersisa 1');
    await c.close();
  }

  await b.close();
  console.log(gagal ? 'GAGAL: ' + gagal : 'SEMUA LULUS (' + fase + ')');
  process.exit(gagal ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
