const assert = require('assert');
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8000/index.html';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.sbSetAuthUI === 'function');

    await page.evaluate(() => {
      LibraryAPI.signOut = async () => {};
      LibraryAPI.previewCounts = () => ({ members: 2, books: 3, loans: 1 });
      LibraryAPI.migrateLocal = async () => { throw new Error('Migrasi tidak boleh berjalan setelah dibatalkan'); };
      sbSetAuthUI({ email: 'petugas@sekolah.id' });
      goPage('beranda');
    });

    assert.strictEqual(await page.locator('#sbBar').count(), 0, 'bar akun lama masih ada');
    assert.strictEqual(await page.locator('#sbWho').count(), 0, 'email akun masih dirender permanen');
    assert.strictEqual(await page.locator('header').getByText('petugas@sekolah.id').count(), 0, 'email tampil di header');
    assert.ok(await page.locator('#sbLogoutButton').isVisible(), 'logout tidak terlihat setelah login');

    await page.evaluate(() => goPage('data'));
    const migrate = page.getByRole('button', { name: 'Mulai Pemindahan Data' });
    assert.ok(await migrate.isVisible(), 'migrasi tidak tersedia di Data & Sinkron');
    let dialogText = '';
    page.once('dialog', async dialog => { dialogText = dialog.message(); await dialog.dismiss(); });
    await migrate.click();
    assert.match(dialogText, /2[\s\S]*3[\s\S]*1/, 'preview migrasi tidak menampilkan jumlah data');

    const desktop = await page.evaluate(() => {
      const header = document.querySelector('header').getBoundingClientRect();
      const nav = document.querySelector('nav').getBoundingClientRect();
      const clock = document.querySelector('.hclock').getBoundingClientRect();
      const logout = document.querySelector('#sbLogoutButton').getBoundingClientRect();
      return { headerBottom: header.bottom, navTop: nav.top, clockRight: clock.right,
        logoutLeft: logout.left, logoutRight: logout.right, viewport: innerWidth };
    });
    assert.ok(desktop.navTop >= desktop.headerBottom - 1, 'navigasi menimpa header desktop');
    assert.ok(desktop.clockRight <= desktop.viewport, 'jam/tanggal keluar viewport desktop');
    assert.ok(desktop.logoutLeft >= 0 && desktop.logoutRight <= desktop.viewport, 'logout keluar viewport desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => goPage('beranda'));
    const mobile = await page.evaluate(() => {
      const header = document.querySelector('header').getBoundingClientRect();
      const nav = document.querySelector('nav').getBoundingClientRect();
      const clock = document.querySelector('.hclock').getBoundingClientRect();
      const logout = document.querySelector('#sbLogoutButton').getBoundingClientRect();
      return { headerBottom: header.bottom, navTop: nav.top, clockLeft: clock.left, clockRight: clock.right,
        logoutLeft: logout.left, logoutRight: logout.right, viewport: innerWidth };
    });
    assert.ok(mobile.navTop >= mobile.headerBottom - 1, 'navigasi menimpa header mobile');
    assert.ok(mobile.clockLeft >= 0 && mobile.clockRight <= mobile.viewport, 'jam/tanggal keluar viewport mobile');
    assert.ok(mobile.logoutLeft >= 0 && mobile.logoutRight <= mobile.viewport, 'logout keluar viewport mobile');
    for (const name of await page.evaluate(() => PAGES)) {
      await page.evaluate(pageName => goPage(pageName), name);
      assert.ok(await page.locator('#page-' + name).evaluate(el => el.classList.contains('active')), 'halaman gagal dibuka: ' + name);
    }
    await page.evaluate(() => goPage('pub-petugas'));
    assert.match(await page.locator('#pubPetugasStatusBox').innerText(), /petugas@sekolah\.id/, 'identitas akun tidak tersedia di Area Petugas');

    await page.locator('#sbLogoutButton').click();
    assert.strictEqual(await page.evaluate(() => SB_USER), null, 'state login tidak dibersihkan saat logout');
    assert.ok(await page.locator('#sbLogoutButton').isHidden(), 'logout masih tampil setelah sesi berakhir');
    assert.ok(await page.locator('#page-pub-home').evaluate(el => el.classList.contains('active')), 'logout tidak kembali ke portal publik');
    assert.deepStrictEqual(errors, [], 'terjadi JavaScript page error');

    console.log('OK — header/account desktop + mobile, migrasi, dan logout terverifikasi');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
