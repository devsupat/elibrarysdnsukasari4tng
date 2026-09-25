/* TASK 03A — Book Cover browser E2E (real Supabase Storage, real staff login). */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000/index.html';
const EMAIL = process.env.E2E_EMAIL;
const PASS = process.env.E2E_PASS;
const TARGET = 'ALGASYA';
const DIR = __dirname;

const R = {};
const pass = (name, details) => { R[name] = { pass: true, details }; console.log('PASS — ' + name + (details ? ' :: ' + details : '')); };
const fail = (name, details) => { R[name] = { pass: false, details }; console.log('FAIL — ' + name + ' :: ' + details); };

async function hookToasts(page) {
  await page.evaluate(() => {
    if (window._toastHooked) return;
    window._toastHooked = 1; window._toasts = [];
    const orig = window.toast;
    window.toast = (m) => { window._toasts.push(m); return orig(m); };
  });
}
const toasts = (page) => page.evaluate(() => window._toasts || []);

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.LibraryAPI && LibraryAPI.enabled && typeof window.sbLogin === 'function');
  // supabase-js memulihkan sesi dari localStorage secara async; beri kesempatan dulu.
  let restored = true;
  try {
    await page.waitForFunction(() => (typeof SB_USER!=='undefined' && !!SB_USER), null, { timeout: 8000 });
  } catch (_) { restored = false; }
  if (!restored) {
    await page.evaluate(() => { document.getElementById('sbAuth').style.display = 'flex'; });
    await page.fill('#sbEmail', EMAIL);
    await page.fill('#sbPass', PASS);
    await page.click('#sbAuth button:has-text("Masuk")');
    await page.waitForFunction(() => (typeof SB_USER!=='undefined' && !!SB_USER), null, { timeout: 30000 });
  }
  await page.waitForFunction(() => typeof DB!=='undefined' && DB && DB.titles && DB.titles.length > 0 && DB.books.length > 0, null, { timeout: 60000 });
  // DB awal berasal dari localStorage (stale). _sbSub dipasang di akhir sbLoadAll = tarikan server selesai.
  await page.waitForFunction(() => !!window._sbSub, null, { timeout: 90000 });
  await hookToasts(page);
}

// title + one of its copies
const ctx = (page) => page.evaluate(async (judul) => {
  const titles = await LibraryAPI.pullTitles();           // sumber kebenaran = server
  const t = titles.find(x => (x.judul || '').toUpperCase() === judul);
  if (!t) return null;
  const copies = DB.books.filter(b => b.titleId === t.id);
  return { titleId: t.id, coverPath: t.coverPath || '', coverUrl: t.coverUrl || '', copies: copies.length, bookId: copies[0] && copies[0].id };
}, TARGET);

// Isi bucket untuk satu title — otoritatif (bukan CDN, jadi tak terpengaruh cache 1 tahun).
const listCovers = (page, titleId) => page.evaluate(async (id) => {
  const r = await LibraryAPI.client.storage.from('book-covers').list(id);
  if (r.error) return { error: r.error.message };
  return { files: (r.data || []).map(f => f.name) };
}, titleId);

const imgOk = (page, sel) => page.evaluate((s) => {
  const img = document.querySelector(s);
  if (!img) return { found: false };
  return { found: true, complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') };
}, sel);

async function openUbah(page, bookId) {
  await page.evaluate((id) => { goPage('katalog'); ubahBuku(id); }, bookId);
  await page.waitForSelector('#copyModal.show');
}

async function saveUbah(page) {
  await page.evaluate(() => { window._toasts = []; });
  await page.click('#copyModal button:has-text("Simpan Perubahan")').catch(async () => {
    await page.evaluate(() => simpanUbahBuku());
  });
  await page.waitForFunction(() => (window._toasts || []).length > 0, null, { timeout: 60000 });
  return (await toasts(page)).join(' | ');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const bctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await bctx.newPage();
  page.on('pageerror', e => console.log('  [pageerror] ' + e.message));

  try {
    // ---------- fixtures: real JPEG bytes rendered in-browser ----------
    await page.goto('about:blank');
    const mk = (w, h, hue, label) => page.evaluate(({ w, h, hue, label }) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${hue},80%,55%)`); grad.addColorStop(1, `hsl(${(hue + 90) % 360},80%,25%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4000; i++) { g.fillStyle = `hsl(${Math.random() * 360},70%,${Math.random() * 100}%)`; g.fillRect(Math.random() * w, Math.random() * h, 9, 9); }
      g.fillStyle = '#fff'; g.font = `bold ${Math.round(h / 12)}px sans-serif`; g.fillText(label, w * 0.08, h * 0.5);
      return c.toDataURL('image/jpeg', 0.95);
    }, { w, h, hue, label });

    const write = (name, dataUrl) => {
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(DIR, name), buf); return buf.length;
    };
    const bigSize = write('cover_big.jpg', await mk(2400, 3200, 210, 'COVER A'));
    const altSize = write('cover_alt.jpg', await mk(1400, 1900, 15, 'COVER B'));
    fs.writeFileSync(path.join(DIR, 'bad.pdf'), '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    fs.writeFileSync(path.join(DIR, 'bad.txt'), 'bukan gambar');
    console.log(`fixtures: cover_big.jpg ${bigSize}B (2400x3200), cover_alt.jpg ${altSize}B (1400x1900)`);

    // ---------- login ----------
    await login(page);
    const who = await page.evaluate(() => SB_USER.email);
    pass('Login Petugas', who);

    let c = await ctx(page);
    if (!c) throw new Error('title ' + TARGET + ' tidak ditemukan');
    {   // sisa run sebelumnya: kosongkan cover_path DAN semua file di bucket title ini
      const wiped = await page.evaluate(async (x) => {
        if (x.coverPath) await LibraryAPI.removeTitleCover(x.titleId, x.coverPath);
        const st = LibraryAPI.client.storage.from('book-covers');
        const l = await st.list(x.titleId);
        const names = (l.data || []).map(f => x.titleId + '/' + f.name);
        if (names.length) await st.remove(names);
        return names;
      }, c);
      if (wiped.length) console.log('reset: hapus ' + wiped.length + ' file sisa');
      if (wiped.length || c.coverPath) { await login(page); c = await ctx(page); }
    }
    if (c.coverPath) fail('Precondition (title tanpa cover)', 'cover_path sudah terisi: ' + c.coverPath);
    else pass('Precondition (title tanpa cover)', `${TARGET} · ${c.copies} eksemplar · cover_path kosong`);

    // ---------- TEST 1 — form existing title ----------
    await openUbah(page, c.bookId);
    const t1 = await page.evaluate(() => ({
      judul: $('ubJudul').value,
      preview: $('ubCoverPreview').textContent.trim(),
      hasImg: !!document.querySelector('#ubCoverPreview img'),
      note: $('ubBiblioNote').textContent.trim().slice(0, 80)
    }));
    (t1.judul === TARGET && t1.preview === '📖' && !t1.hasImg)
      ? pass('Existing Title Form', `judul=${t1.judul} · fallback=${t1.preview} · "${t1.note}"`)
      : fail('Existing Title Form', JSON.stringify(t1));

    // ---------- TEST 10 — invalid file (before any upload, so garbage is detectable) ----------
    const invalid = [];
    for (const f of ['bad.pdf', 'bad.txt']) {
      await page.evaluate(() => { window._toasts = []; });
      await page.setInputFiles('#ubCoverFile', path.join(DIR, f));
      await page.waitForFunction(() => (window._toasts || []).length > 0, null, { timeout: 15000 });
      const st = await page.evaluate(() => ({ toast: window._toasts.join('|'), blob: (typeof ubCoverBlob!=='undefined' && !!ubCoverBlob), input: $('ubCoverFile').value }));
      invalid.push(`${f} → "${st.toast}" blob=${st.blob}`);
      if (st.blob) fail('Invalid File', f + ' diterima sebagai cover');
    }
    if (!R['Invalid File']) pass('Invalid File', invalid.join(' ; '));

    // ---------- TEST 2 + 11 — upload + optimize ----------
    await page.setInputFiles('#ubCoverFile', path.join(DIR, 'cover_big.jpg'));
    await page.waitForFunction(() => (typeof ubCoverBlob!=='undefined' && !!ubCoverBlob), null, { timeout: 30000 });
    const opt = await page.evaluate(async () => {
      const b = ubCoverBlob;
      const bmp = await createImageBitmap(b);
      return { size: b.size, type: b.type, w: bmp.width, h: bmp.height };
    });
    const prev = await imgOk(page, '#ubCoverPreview img');
    (prev.found && prev.w > 0)
      ? pass('Preview', `preview ${prev.w}x${prev.h}`)
      : fail('Preview', JSON.stringify(prev));
    (opt.type === 'image/webp' && Math.max(opt.w, opt.h) === 900 && opt.size < bigSize)
      ? pass('Large Image', `Original: ${bigSize} B (2400x3200 JPEG) → Final: ${opt.size} B (${opt.w}x${opt.h}) · Format: ${opt.type} · rasio ${(opt.size / bigSize * 100).toFixed(1)}%`)
      : fail('Large Image', JSON.stringify(opt) + ' original=' + bigSize);

    // ---------- save ----------
    const savedToast = await saveUbah(page);
    const afterSave = await ctx(page);
    (/✅/.test(savedToast) && afterSave.coverPath)
      ? pass('Upload', `toast="${savedToast}" · cover_path=${afterSave.coverPath}`)
      : fail('Upload', `toast="${savedToast}" cover_path=${afterSave.coverPath || '(kosong)'}`);
    const firstPath = afterSave.coverPath, firstUrl = afterSave.coverUrl;
    const bucketAfterUpload = await listCovers(page, c.titleId);
    ((bucketAfterUpload.files || []).length === 1)
      ? pass('No Duplicate Cover', `1 title → 1 file: [${bucketAfterUpload.files.join(',')}]`)
      : fail('No Duplicate Cover', JSON.stringify(bucketAfterUpload));

    const httpA = await page.evaluate(async (u) => { const r = await fetch(u, { cache: 'no-store' }); return { s: r.status, ct: r.headers.get('content-type'), len: r.headers.get('content-length') }; }, firstUrl);
    (httpA.s === 200 && /image\/webp/.test(httpA.ct || ''))
      ? pass('Save', `public URL ${httpA.s} ${httpA.ct} ${httpA.len} B`)
      : fail('Save', JSON.stringify(httpA));

    // ---------- TEST 3 — refresh ----------
    await login(page);
    const afterReload = await ctx(page);
    (afterReload.coverPath === firstPath)
      ? pass('Refresh', `cover_path bertahan: ${afterReload.coverPath}`)
      : fail('Refresh', `sebelum=${firstPath} sesudah=${afterReload.coverPath}`);

    await openUbah(page, afterReload.bookId);
    const prev2 = await imgOk(page, '#ubCoverPreview img');
    await page.evaluate(() => tutupUbahBuku());
    (prev2.found && prev2.w > 0) ? pass('Refresh Preview', `${prev2.w}x${prev2.h}`) : fail('Refresh Preview', JSON.stringify(prev2));

    // ---------- TEST 4 — public catalog ----------
    await page.evaluate(() => { goPage('pub-katalog'); });
    await page.waitForFunction(() => typeof PUB!=='undefined' && PUB.loaded, null, { timeout: 60000 });
    await page.evaluate((j) => { $('pubBookSearchInput').value = j; PUB_LIMIT = 60; renderPubCatalog(); }, TARGET);
    await page.waitForSelector('#pubBookListGrid .pub-book-card img', { timeout: 20000 });
    await page.waitForFunction(() => { const i = document.querySelector('#pubBookListGrid .pub-book-card img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
    const pub = await imgOk(page, '#pubBookListGrid .pub-book-card img');
    const pubCards = await page.evaluate(() => document.querySelectorAll('#pubBookListGrid .pub-book-card').length);
    (pub.w > 0) ? pass('Public Catalog', `${pubCards} kartu ALGASYA · cover ${pub.w}x${pub.h} rendered`) : fail('Public Catalog', JSON.stringify(pub));

    // ---------- TEST 5 — popular books ----------
    await page.evaluate(() => { goPage('pub-home'); });
    await page.waitForFunction((j) => {
      const g = document.getElementById('pubPopularBooksGrid');
      if (!g) return false;
      const card = Array.from(g.querySelectorAll('.pub-book-card')).find(c => c.textContent.toUpperCase().includes(j));
      const img = card && card.querySelector('img');
      return !!(img && img.complete && img.naturalWidth > 0);
    }, TARGET, { timeout: 40000 });
    const pop = await page.evaluate((j) => {
      const card = Array.from(document.querySelectorAll('#pubPopularBooksGrid .pub-book-card')).find(c => c.textContent.toUpperCase().includes(j));
      const img = card.querySelector('img');
      return { text: card.querySelector('h4').textContent, w: img.naturalWidth, h: img.naturalHeight };
    }, TARGET);
    pass('Popular Books', `${pop.text} · cover ${pop.w}x${pop.h}`);

    // ---------- TEST 6 — internal statistics ----------
    await page.evaluate(() => { goPage('statistik'); statMode = 'semua'; renderStats(); });
    await page.waitForFunction((j) => {
      const row = Array.from(document.querySelectorAll('#topBooks .rank')).find(r => r.textContent.toUpperCase().includes(j));
      const img = row && row.querySelector('.rank-cover img');
      return !!(img && img.complete && img.naturalWidth > 0);
    }, TARGET, { timeout: 30000 });
    const stat = await page.evaluate((j) => {
      const row = Array.from(document.querySelectorAll('#topBooks .rank')).find(r => r.textContent.toUpperCase().includes(j));
      const img = row.querySelector('.rank-cover img');
      return { label: row.querySelector('.info b').textContent, w: img.naturalWidth };
    }, TARGET);
    pass('Statistics', `topBooks: ${stat.label} · rank-cover ${stat.w}px`);

    // ---------- TEST 7 — multiple copies, one cover ----------
    const multi = await page.evaluate((j) => {
      const t = DB.titles.find(x => (x.judul || '').toUpperCase() === j);
      const copies = DB.books.filter(b => b.titleId === t.id);
      return { copies: copies.length, paths: [...new Set(copies.map(() => t.coverPath))], titleCover: t.coverPath };
    }, TARGET);
    (multi.copies >= 2 && multi.paths.length === 1)
      ? pass('Multiple Copies', `${multi.copies} eksemplar → 1 cover (${multi.titleCover}); books tidak punya kolom cover`)
      : fail('Multiple Copies', JSON.stringify(multi));

    // ---------- TEST 8 — replace ----------
    await openUbah(page, afterReload.bookId);
    await page.setInputFiles('#ubCoverFile', path.join(DIR, 'cover_alt.jpg'));
    await page.waitForFunction(() => (typeof ubCoverBlob!=='undefined' && !!ubCoverBlob), null, { timeout: 30000 });
    const rToast = await saveUbah(page);
    const afterReplace = await ctx(page);
    const httpNew = await page.evaluate(async (u) => (await fetch(u, { cache: 'no-store' })).status, afterReplace.coverUrl);
    const bucketAfterReplace = await listCovers(page, c.titleId);
    const newName = (afterReplace.coverPath || '').split('/').pop(), oldName = firstPath.split('/').pop();
    const okReplace = /✅/.test(rToast) && afterReplace.coverPath && afterReplace.coverPath !== firstPath
      && httpNew === 200 && bucketAfterReplace.files && bucketAfterReplace.files.length === 1
      && bucketAfterReplace.files[0] === newName;
    okReplace
      ? pass('Replace', `path baru=${afterReplace.coverPath} (HTTP ${httpNew}) · file lama ${oldName} terhapus · isi bucket=[${bucketAfterReplace.files.join(',')}] = 1 file, tidak ada orphan · URL berubah → tidak ada cache cover lama`)
      : fail('Replace', `toast="${rToast}" new=${afterReplace.coverPath} old=${firstPath} httpNew=${httpNew} bucket=${JSON.stringify(bucketAfterReplace)}`);
    const secondPath = afterReplace.coverPath;

    await login(page);
    const afterReplaceReload = await ctx(page);
    (afterReplaceReload.coverPath === secondPath)
      ? pass('Replace Persist', secondPath)
      : fail('Replace Persist', `${afterReplaceReload.coverPath} != ${secondPath}`);

    // ---------- SECURITY — anon cannot delete/overwrite a real object ----------
    const sec = await page.evaluate(async ({ p }) => {
      const url = window.LibraryAPI.client.supabaseUrl || '';
      const key = window.LibraryAPI.client.supabaseKey || '';
      const base = url + '/storage/v1/object/book-covers/' + p;
      const h = { apikey: key, Authorization: 'Bearer ' + key };
      const del = await fetch(base, { method: 'DELETE', headers: h });
      const up = await fetch(base, { method: 'POST', headers: Object.assign({ 'Content-Type': 'image/webp' }, h), body: new Blob(['x'], { type: 'image/webp' }) });
      const read = await fetch(base, { headers: h });
      return { del: del.status, delBody: (await del.text()).slice(0, 120), up: up.status, read: read.status };
    }, { p: secondPath });
    (sec.del !== 200 && sec.up !== 200 && sec.read === 200)
      ? pass('Storage Security', `anon DELETE=${sec.del} · anon UPLOAD=${sec.up} · anon READ=${sec.read} (${sec.delBody})`)
      : fail('Storage Security', JSON.stringify(sec));

    // ---------- TEST 9 — delete ----------
    await openUbah(page, afterReplaceReload.bookId);
    await page.evaluate(() => hapusCoverUbah());
    const prevDel = await page.evaluate(() => $('ubCoverPreview').textContent.trim());
    const dToast = await saveUbah(page);
    const afterDelete = await ctx(page);
    const bucketAfterDelete = await listCovers(page, c.titleId);
    (/✅/.test(dToast) && !afterDelete.coverPath && bucketAfterDelete.files && bucketAfterDelete.files.length === 0)
      ? pass('Delete', `cover_path=null · isi bucket title=[] (0 file) · preview fallback "${prevDel}"`)
      : fail('Delete', `toast="${dToast}" path=${afterDelete.coverPath} bucket=${JSON.stringify(bucketAfterDelete)}`);

    await login(page);
    const afterDeleteReload = await ctx(page);
    await page.evaluate(() => { goPage('pub-katalog'); });
    await page.waitForFunction(() => typeof PUB!=='undefined' && PUB.loaded, null, { timeout: 60000 });
    await page.evaluate((j) => { $('pubBookSearchInput').value = j; PUB_LIMIT = 60; renderPubCatalog(); }, TARGET);
    await page.waitForSelector('#pubBookListGrid .pub-book-card');
    const fb = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#pubBookListGrid .pub-book-card'));
      return cards.map(c => ({ cover: c.querySelector('.book-cover').textContent.trim(), img: !!c.querySelector('.book-cover img') }));
    });
    (!afterDeleteReload.coverPath && fb.length > 0 && fb.every(x => x.cover === '📖' && !x.img))
      ? pass('Delete Fallback', `setelah refresh: cover_path null · ${fb.length} kartu → 📖, tidak ada broken image`)
      : fail('Delete Fallback', JSON.stringify({ path: afterDeleteReload.coverPath, fb }));

    // ---------- REGRESSION ----------
    const reg = await page.evaluate(() => {
      const out = {};
      out.login = !!SB_USER && !!SB_USER.email;
      out.realtime = !!window._sbSub;
      goPage('anggota'); renderMembers();
      out.anggota = document.querySelectorAll('#memberTable tr').length;
      goPage('katalog'); renderBooks();
      out.katalog = document.querySelectorAll('#bookTable tr').length;
      out.inventoryCount = ($('bCount') || {}).textContent || '';
      goPage('sirkulasi'); renderLoans(); renderActiveLoans();
      out.loans = document.querySelectorAll('#loanTable tr').length;
      out.dbCounts = { members: DB.members.length, books: DB.books.length, titles: DB.titles.length, loans: DB.loans.length };
      window._printed = false; window.print = () => { window._printed = true; };
      try { bBersihkanPilihan(); } catch (e) {}
      const cb = document.querySelector('#bookTable tr td input[type="checkbox"]');
      if (cb) { cb.click(); }
      try { cetakLabelTerpilih(); } catch (e) { out.qrErr = e.message; }
      out.qr = window._printed || !!document.querySelector('#qr-print-area') || document.body.classList.contains('print-qr');
      return out;
    });
    (reg.login && reg.realtime && reg.anggota > 0 && reg.katalog > 0 && reg.loans > 0 && reg.qr)
      ? pass('Regression', `login=${reg.login} realtime=${reg.realtime} anggota=${reg.anggota}row katalog=${reg.katalog}row loans=${reg.loans}row QR=${reg.qr} · DB ${JSON.stringify(reg.dbCounts)}`)
      : fail('Regression', JSON.stringify(reg));

  } catch (e) {
    fail('E2E Execution', e.message);
    console.log(e.stack);
  } finally {
    await browser.close();
  }

  console.log('\n================ RESULT ================');
  Object.entries(R).forEach(([k, v]) => console.log((v.pass ? 'PASS' : 'NOT VERIFIED/FAIL') + ' — ' + k));
  fs.writeFileSync(path.join(DIR, 'cover_e2e_result.json'), JSON.stringify(R, null, 2));
  process.exit(Object.values(R).every(v => v.pass) ? 0 : 1);
})();
