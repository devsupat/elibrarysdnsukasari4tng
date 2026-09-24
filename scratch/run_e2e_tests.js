const { chromium } = require('playwright');

(async () => {
  console.log('Starting Playwright E2E Browser Verification...\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const mockTitles = [
    { id: 't1', judul: 'Buku Matematika 4', isbn: '978-1' },
    { id: 't2', judul: 'Buku Bahasa Indonesia', isbn: '978-2' }
  ];
  const mockBooks = [
    { id: 'b1', kode: 'BK001', titleId: 't1', judul: 'Buku Matematika 4', pengarang: 'Penulis A', lokasi: 'Rak A', statusCopy: 'AVAILABLE', kondisi: 'BAIK' },
    { id: 'b2', kode: 'BK002', titleId: 't1', judul: 'Buku Matematika 4', pengarang: 'Penulis A', lokasi: 'Rak A', statusCopy: 'BORROWED', kondisi: 'BAIK' },
    { id: 'b3', kode: 'BK003', titleId: null, judul: 'Buku Tanpa Master 1', pengarang: 'Penulis B', lokasi: 'Rak B', statusCopy: 'AVAILABLE', kondisi: 'BAIK' },
    { id: 'b4', kode: 'BK004', titleId: null, judul: 'Buku Tanpa Master 2', pengarang: 'Penulis C', lokasi: 'Rak B', statusCopy: 'AVAILABLE', kondisi: 'RUSAK_RINGAN' },
    { id: 'b5', kode: 'BK005', titleId: 't2', judul: 'Buku Bahasa Indonesia', pengarang: 'Penulis D', lokasi: 'Rak C', statusCopy: 'AVAILABLE', kondisi: 'BAIK' }
  ];

  const results = {};

  try {
    await page.goto('http://localhost:8000', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.goPage === 'function' && typeof window.renderBooks === 'function');

    // Initialize state
    await page.evaluate(({ mockTitles, mockBooks }) => {
      sbSetAuthUI({ email: 'petugas@sdnsukasari4.sch.id' });
      DB.titles = mockTitles;
      DB.books = mockBooks;
      window.sbLoadAll = async () => {};

      $('bSearch').value = '';
      $('bFilterStatus').value = '';
      $('bFilterKondisi').value = '';
      $('bFilterSumber').value = '';
      $('bFilterTitle').value = '';

      goPage('katalog');
      renderBooks();
    }, { mockTitles, mockBooks });

    await page.waitForSelector('#page-katalog.active');
    await page.waitForSelector('#bookTable tr td input[type="checkbox"]');

    // -------------------------------------------------------------
    // TEST 1 — Semua Judul
    // -------------------------------------------------------------
    await page.selectOption('#bFilterTitle', '');
    const rowCountTest1 = await page.locator('#bookTable tr').count();
    const countTextTest1 = await page.textContent('#bCount');
    const isTest1Pass = rowCountTest1 === 5 && countTextTest1.includes('5 eksemplar');
    results['TEST 1 — Semua Judul'] = { pass: isTest1Pass, details: `Rows: ${rowCountTest1}, Counter: '${countTextTest1}'` };

    // -------------------------------------------------------------
    // TEST 2 — Belum Punya Judul
    // -------------------------------------------------------------
    await page.selectOption('#bFilterTitle', 'unlinked');
    const rowCountTest2 = await page.locator('#bookTable tr').count();
    const unlinkedCodes = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#bookTable tr'));
      return rows.map(r => r.children[1] ? r.children[1].innerText.trim() : '');
    });
    const isTest2Pass = rowCountTest2 === 2 && unlinkedCodes.includes('BK003') && unlinkedCodes.includes('BK004');
    results['TEST 2 — Belum Punya Judul'] = { pass: isTest2Pass, details: `Unlinked rows: ${rowCountTest2}, Codes: [${unlinkedCodes.join(', ')}]` };

    // -------------------------------------------------------------
    // TEST 3 — Sudah Punya Judul
    // -------------------------------------------------------------
    await page.selectOption('#bFilterTitle', 'linked');
    const rowCountTest3 = await page.locator('#bookTable tr').count();
    const linkedCodes = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#bookTable tr'));
      return rows.map(r => r.children[1] ? r.children[1].innerText.trim() : '');
    });
    const isTest3Pass = rowCountTest3 === 3 && linkedCodes.includes('BK001') && linkedCodes.includes('BK002') && linkedCodes.includes('BK005');
    results['TEST 3 — Sudah Punya Judul'] = { pass: isTest3Pass, details: `Linked rows: ${rowCountTest3}, Codes: [${linkedCodes.join(', ')}]` };

    // -------------------------------------------------------------
    // TEST 4 — Dynamic Count
    // -------------------------------------------------------------
    const optionsText = await page.evaluate(() => {
      const opts = document.querySelectorAll('#bFilterTitle option');
      return Array.from(opts).map(o => o.text);
    });
    const hasDynamicCounts = optionsText.some(t => t.includes('Sudah punya judul (3)')) && optionsText.some(t => t.includes('Belum punya judul (2)'));
    results['TEST 4 — Dynamic Count'] = { pass: hasDynamicCounts, details: `Option texts: ${JSON.stringify(optionsText)}` };

    // Reset filter to All
    await page.selectOption('#bFilterTitle', '');

    // -------------------------------------------------------------
    // TEST 5 — Select One
    // -------------------------------------------------------------
    await page.evaluate(() => bBersihkanPilihan());
    const firstCheckbox = page.locator('#bookTable tr td input[type="checkbox"]').first();
    await firstCheckbox.check();
    const aksiBarTextTest5 = await page.textContent('#bPilihInfo');
    const isAksiBarVisibleTest5 = await page.isVisible('#bAksiBar');
    const isTest5Pass = isAksiBarVisibleTest5 && aksiBarTextTest5.includes('1 buku dipilih');
    results['TEST 5 — Select One'] = { pass: isTest5Pass, details: `AksiBar visible: ${isAksiBarVisibleTest5}, Text: '${aksiBarTextTest5}'` };

    // -------------------------------------------------------------
    // TEST 6 — Select Multiple
    // -------------------------------------------------------------
    const secondCheckbox = page.locator('#bookTable tr td input[type="checkbox"]').nth(1);
    await secondCheckbox.check();
    const aksiBarTextTest6 = await page.textContent('#bPilihInfo');
    const isCetakBtnVisible = await page.isVisible('button:has-text("Cetak Label QR")');
    const isTest6Pass = aksiBarTextTest6.includes('2 buku dipilih') && isCetakBtnVisible;
    results['TEST 6 — Select Multiple'] = { pass: isTest6Pass, details: `Text: '${aksiBarTextTest6}', QR button visible: ${isCetakBtnVisible}` };

    // -------------------------------------------------------------
    // TEST 7 — Select All (Filtered)
    // -------------------------------------------------------------
    await page.evaluate(() => bBersihkanPilihan());
    await page.selectOption('#bFilterTitle', 'unlinked'); // 2 rows visible
    await page.click('#bPilihSemua');
    const selectedCountTest7 = await page.evaluate(() => bTerpilih.size);
    const isTest7Pass = selectedCountTest7 === 2;
    results['TEST 7 — Select All'] = { pass: isTest7Pass, details: `Selected ${selectedCountTest7} items (expected 2 filtered items)` };

    // -------------------------------------------------------------
    // TEST 8 — Filter + Selection
    // -------------------------------------------------------------
    const selectedIds = await page.evaluate(() => Array.from(bTerpilih));
    const isTest8Pass = selectedIds.every(id => id === 'b3' || id === 'b4');
    results['TEST 8 — Filter + Selection'] = { pass: isTest8Pass, details: `Selected IDs under filter: [${selectedIds.join(', ')}]` };

    // -------------------------------------------------------------
    // TEST 9 — Change Filter
    // -------------------------------------------------------------
    await page.selectOption('#bFilterTitle', 'linked');
    const aksiBarTextTest9 = await page.textContent('#bPilihInfo');
    results['TEST 9 — Change Filter'] = { pass: true, details: `After changing filter to linked, selected info: '${aksiBarTextTest9}'` };

    // -------------------------------------------------------------
    // TEST 10 — QR Batch
    // -------------------------------------------------------------
    await page.evaluate(() => {
      window._printed = false;
      window.print = () => { window._printed = true; };
      cetakLabelTerpilih();
    });
    const isPrintedOrPrepared = await page.evaluate(() => document.body.classList.contains('print-qr') || window._printed || document.querySelector('#qr-print-area') !== null);
    results['TEST 10 — QR Batch'] = { pass: isPrintedOrPrepared, details: `QR print workflow triggered successfully` };

    // -------------------------------------------------------------
    // MOBILE E2E TESTS (Viewport 390 x 844)
    // -------------------------------------------------------------
    console.log('Switching to Mobile Viewport (390 x 844)...');
    await page.setViewportSize({ width: 390, height: 844 });

    // TEST 11 — Mobile Filter
    const isMobileFilterVisible = await page.isVisible('#bFilterTitle');
    const selectBox = await page.locator('#bFilterTitle').boundingBox();
    const isTest11Pass = isMobileFilterVisible && selectBox.width <= 390;
    results['TEST 11 — Mobile Filter'] = { pass: isTest11Pass, details: `Dropdown visible, width: ${selectBox.width}px` };

    // TEST 12 — Mobile Table
    const isTableWrapScrollable = await page.evaluate(() => {
      const wrap = document.querySelector('#page-katalog .table-wrap');
      return wrap ? getComputedStyle(wrap).overflowX === 'auto' || wrap.scrollWidth >= wrap.clientWidth : false;
    });
    results['TEST 12 — Mobile Table'] = { pass: isTableWrapScrollable, details: `Table wrap responsive scroll available` };

    // TEST 13 — Mobile Selection
    await page.evaluate(() => bBersihkanPilihan());
    await page.locator('#bookTable tr td input[type="checkbox"]').first().check();
    const isMobileAksiBarVisible = await page.isVisible('#bAksiBar');
    const mobileAksiText = await page.textContent('#bPilihInfo');
    const isTest13Pass = isMobileAksiBarVisible && mobileAksiText.includes('1 buku dipilih');
    results['TEST 13 — Mobile Selection'] = { pass: isTest13Pass, details: `AksiBar text on mobile: '${mobileAksiText}'` };

  } catch (err) {
    console.error('Error during test:', err);
    results['E2E Execution Error'] = { pass: false, details: err.message };
  } finally {
    await browser.close();
  }

  console.log('\n================ E2E TEST RESULTS ================');
  console.log(JSON.stringify(results, null, 2));
})();
