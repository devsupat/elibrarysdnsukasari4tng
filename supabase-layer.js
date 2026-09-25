/* ============================================================================
 * supabase-layer.js — eLibrary SDN Sukasari 4
 * Data/service layer between the existing SUPAT LIBRARY UI and Supabase.
 *
 * Design goals:
 *  - Supabase = source of truth for members/books/loans (multi-device).
 *  - Keep the legacy in-memory DB shape so existing render/report code is untouched.
 *  - If not configured (placeholders below), app stays in legacy offline mode.
 *  - Loans go through atomic RPCs (borrow_book/return_book) — never client-side stock math.
 *
 * Barcode ID comes from the school's central RFID generator and is input manually.
 * This app never generates student barcodes.
 * ==========================================================================*/
(function (global) {
  'use strict';

  // ==== CONFIG — isi dua nilai ini (aman untuk client; anon key memang publik) ====
  // Supabase Dashboard > Project Settings > API : Project URL + anon/public key.
  var SB_CFG = {
    url:     'https://lmnnuatmrfueiddpmdeb.supabase.co',  // project URL (bukan rahasia)
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxtbm51YXRtcmZ1ZWlkZHBtZGViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDY1ODgsImV4cCI6MjEwMzMyMjU4OH0.VygZ9ejQefMGaHCEqiadSKKDmDZZxOM5XXyLIswA3bY'                    // anon/publishable key — BUKAN service_role. Isi manual.
  };

  // ⚠️ HANYA anon/public key di sini. JANGAN PERNAH menaruh service_role key,
  //    database password, atau JWT secret di file frontend ini — semuanya ikut terpublish.
  var isPlaceholder = SB_CFG.url.indexOf('PASTE_') === 0 || SB_CFG.anonKey.indexOf('PASTE_') === 0;
  var CONFIGURED = !isPlaceholder;                       // URL + anon key sudah diisi?
  var hasLib = typeof global.supabase !== 'undefined' && global.supabase.createClient;
  var ENABLED = CONFIGURED && hasLib;                    // client bisa dibuat?
  var sb = ENABLED ? global.supabase.createClient(SB_CFG.url, SB_CFG.anonKey) : null;
  var COVER_BUCKET = 'book-covers';

  // ---------- mapping: Supabase row <-> legacy JS shape ----------
  function rowToMem(r) {
    return { id: r.id, barcodeId: r.barcode_id || '', nama: r.nama, kelas: r.kelas || '',
      rombel: r.rombel || '', jk: r.jk || 'L', tipe: r.tipe || 'Siswa', noAnggota: r.no_anggota || '',
      nis: r.nis || '', nisn: r.nisn || '', lifecycle: r.lifecycle || 'AKTIF',
      tahunAjaran: r.tahun_ajaran || '', status: r.status || (r.no_anggota ? 'Anggota' : 'Non-Anggota') };
  }
  function memToRow(m) {
    return { barcode_id: m.barcodeId || null, nama: m.nama, kelas: m.kelas || null, rombel: m.rombel || null,
      jk: m.jk || null, tipe: m.tipe || 'Siswa', no_anggota: m.noAnggota || null, nis: m.nis || null,
      nisn: m.nisn || null, lifecycle: m.lifecycle || 'AKTIF', tahun_ajaran: m.tahunAjaran || null,
      status: m.status || null, legacy_id: (m.id && /^M\d/.test(m.id)) ? m.id : null };
  }
  // 1 baris books = 1 eksemplar fisik. kode = identitas eksemplar itu (calon payload QR).
  function rowToBook(r) {
    return { id: r.id, kode: r.kode, judul: r.judul, pengarang: r.pengarang || '', penerbit: r.penerbit || '',
      tahun: r.tahun || '', kategori: r.kategori || '', jumlah: r.jumlah, tersedia: r.tersedia,
      titleId: r.title_id || '', sumber: r.sumber || '', tanggalMasuk: r.tanggal_masuk || '',
      lokasi: r.lokasi || '', kondisi: r.kondisi || 'BAIK', statusCopy: r.status_copy || 'AVAILABLE' };
  }
  function rowToTitle(r) {
    return { id: r.id, judul: r.judul, pengarang: r.pengarang || '', penerbit: r.penerbit || '',
      tahun: r.tahun || '', isbn: r.isbn || '', kategori: r.kategori || '', levelKelas: r.level_kelas || '',
      coverPath: r.cover_path || '', coverUrl: r.cover_url || coverUrl(r.cover_path || '') };
  }
  function coverUrl(path) {
    if (!path || !sb) return '';
    return sb.storage.from(COVER_BUCKET).getPublicUrl(path).data.publicUrl || '';
  }
  function withTitleCover(book, title) {
    if (!book) return book;
    var t = title || {};
    book.coverUrl = t.coverUrl || coverUrl(t.coverPath);
    return book;
  }
  function bookToRow(b) {
    return { kode: String(b.kode), judul: b.judul, pengarang: b.pengarang || null, penerbit: b.penerbit || null,
      tahun: b.tahun || null, kategori: b.kategori || null, jumlah: b.jumlah, tersedia: b.tersedia,
      legacy_id: (b.id && /^B\d/.test(b.id)) ? b.id : null };
  }
  function rowToSesi(r) {
    if (!r) return null;
    return { id: r.id, kelas: r.kelas, kegiatan: r.kegiatan || '', memberId: r.member_id || '',
      nama: r.nama || '', tanggal: r.tanggal, dibukaAt: r.dibuka_at, ditutupAt: r.ditutup_at || '' };
  }
  function rowToLoan(r) {
    return { id: r.id, memberId: r.member_id, bookId: r.book_id, nama: r.nama, kelas: r.kelas,
      jk: r.jk, noAnggota: r.no_anggota, kode: r.kode, judul: r.judul, pinjam: r.pinjam,
      batas: r.batas, kembali: r.kembali || '', sanksi: r.sanksi || '',
      // terisi = transaksi milik sesi "Pinjam ke Kelas", bukan bacaan pribadi
      sessionId: r.session_id || '' };
  }

  function friendly(e) {
    var m = (e && e.message) || String(e || '');
    // Jaringan sekolah putus di tengah transaksi.
    if (/Failed to fetch|NetworkError|Network request failed|ERR_INTERNET|ERR_NETWORK|Load failed/i.test(m)) {
      return 'Tidak ada koneksi internet. Data belum tersimpan — periksa jaringan lalu ulangi.';
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(m)) {
      return 'Jaringan lambat, permintaan kehabisan waktu. Coba ulangi sebentar lagi.';
    }
    // Sesi login habis / token rusak. Petugas hanya perlu tahu: login ulang.
    if (/JWT|jwt expired|token|Unauthorized|not authenticated|session|suitable key|invalid signature|invalid claim/i.test(m)) {
      return 'Sesi login Anda sudah berakhir. Silakan masuk kembali sebagai petugas.';
    }
    if (/STOK_HABIS/.test(m)) return 'Stok buku habis / semua eksemplar dipinjam.';
    if (/COPY_TIDAK_BEREDAR/.test(m)) return 'Eksemplar ini hilang/rusak/ditarik dari peredaran — tidak dapat dipinjam.';
    if (/uniq_active_loan_per_copy/.test(m)) return 'Eksemplar ini sedang dipinjam — tidak bisa dipinjam dua kali.';
    if (/SUDAH_KEMBALI/.test(m)) return 'Transaksi sudah dikembalikan / tidak ditemukan.';
    if (/ANGGOTA_TIDAK/.test(m)) return 'Anggota tidak ditemukan.';
    if (/duplicate key/.test(m) && /barcode/.test(m)) return 'Barcode ID sudah dipakai anggota lain.';
    if (/duplicate key/.test(m) && /kode/.test(m)) return 'Kode buku sudah ada di katalog.';
    if (/books_satu_eksemplar_check/.test(m)) return 'Satu baris buku = satu eksemplar fisik. Pakai "Jumlah Eksemplar" agar sistem membuatkan beberapa eksemplar.';
    if (/KODE_TIDAK_BOLEH_DIUBAH/.test(m)) return 'Kode eksemplar tidak dapat diubah — label QR-nya sudah tertempel di buku.';
    if (/JUDUL_WAJIB_DIISI/.test(m)) return 'Judul buku wajib diisi.';
    if (/JUDUL_TIDAK_DITEMUKAN/.test(m)) return 'Judul tidak ditemukan — muat ulang halaman.';
    if (/JUMLAH_COPY_TIDAK_VALID/.test(m)) return 'Jumlah eksemplar harus antara 1 sampai 200.';
    if (/MASIH_DIPINJAM/.test(m)) return 'Eksemplar ini sedang dipinjam. Proses pengembaliannya dulu.';
    if (/EKSEMPLAR_TIDAK_DITEMUKAN/.test(m)) return 'Eksemplar tidak ditemukan.';
    if (/SESI_TIDAK_AKTIF/.test(m)) return 'Sesi kelas sudah ditutup. Buka sesi baru dulu.';
    if (/KELAS_WAJIB_DIISI/.test(m)) return 'Kelas wajib diisi untuk peminjaman ke kelas.';
    if (/row-level security|permission denied/.test(m)) return 'Akses ditolak — login sebagai petugas dulu.';
    // Cover: petugas tidak boleh melihat istilah teknis Supabase/PostgREST.
    if (/[Bb]ucket not found|PGRST204|cover_path/.test(m)) return 'Penyimpanan cover belum siap. Hubungi admin.';
    if (/mime type|maximum allowed size|Payload too large|entity too large/i.test(m)) return 'Gambar cover ditolak penyimpanan. Pakai JPG/PNG/WebP ukuran wajar.';
    if (/[Ss]torage|[Oo]bject not found|NoSuchKey/.test(m)) return 'Cover gagal disimpan. Silakan coba lagi.';
    return m;
  }
  function throwIf(res) { if (res.error) throw res.error; return res.data; }

  var API = {
    enabled: ENABLED,       // client Supabase berhasil dibuat
    configured: CONFIGURED, // URL + anon key sudah diisi (bukan placeholder)
    libLoaded: hasLib,      // library supabase-js termuat
    client: sb,
    msg: friendly,

    // Cek koneksi tanpa perlu login: RPC agregat yang boleh diakses anon.
    // Melempar error bila anon key salah / project down / offline.
    async ping() { throwIf(await sb.rpc('public_stats')); return true; },

    // Jumlah data lokal yang AKAN dimigrasikan (untuk preview sebelum upload).
    previewCounts(DB) {
      return { members: (DB.members || []).length, books: (DB.books || []).length, loans: (DB.loans || []).length };
    },

    // ---------- auth (petugas) ----------
    async signIn(email, password) { return throwIf(await sb.auth.signInWithPassword({ email: email, password: password })); },
    async signOut() { return sb.auth.signOut(); },
    async currentUser() { var r = await sb.auth.getUser(); return r.data ? r.data.user : null; },
    onAuth(cb) { return sb.auth.onAuthStateChange(function (_e, session) { cb(session ? session.user : null); }); },

    // ---------- pulls (fill legacy DB arrays) ----------
    // PostgREST membatasi ~1000 row/response. Ambil per-halaman via .range() sampai batch < PAGE
    // supaya SELURUH baris termuat (mis. books 1548). Ordering: kolom niat + 'id' (pk unik) sebagai
    // tiebreaker → deterministik, tak ada baris terlewat/duplikat. Gagal 1 batch = throw (bukan parsial diam).
    // filterFn (opsional): terima query builder, kembalikan builder yang sudah difilter.
    async _pullAll(table, orderCol, ascending, filterFn) {
      var PAGE = 1000, from = 0, all = [];
      for (;;) {
        var q = sb.from(table).select('*');
        if (filterFn) q = filterFn(q);
        var res = await q
          .order(orderCol, { ascending: ascending !== false })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (res.error) throw res.error;
        var batch = res.data || [];
        all = all.concat(batch);
        if (batch.length < PAGE) break;
        from += PAGE;
      }
      return all;
    },
    async pullMembers() { return (await this._pullAll('members', 'nama', true)).map(rowToMem); },
    async pullBooks()   { return (await this._pullAll('books', 'judul', true)).map(rowToBook); },
    // delete_loan sekarang soft-cancel (histori transaksi tidak boleh hilang). Baris CANCELLED
    // disaring di sini supaya tampilan petugas tetap sama persis seperti sebelumnya:
    // catatan yang "dihapus" lenyap dari daftar, tetapi tetap utuh di database.
    async pullLoans()   { return (await this._pullAll('loans', 'created_at', false,
                            function (q) { return q.neq('status', 'CANCELLED'); })).map(rowToLoan); },

    // ---------- PUBLIC (anon) ----------
    // Catalog is public (RLS books_read_all). Paginated so ALL rows load, not capped at 1000.
    async publicBooks() {
      var rows = await this._pullAll('books', 'judul', true);
      var titles = await this.publicTitles();
      var byId = {}; titles.forEach(function (t) { byId[t.id] = t; });
      return rows.map(function (r) { return withTitleCover(rowToBook(r), byId[r.title_id]); });
    },
    async publicTitles() { return (await this._pullAll('titles', 'judul', true)).map(rowToTitle); },
    // Secure single-student lookup by access key (= barcode_id). RPC is SECURITY DEFINER; anon never
    // touches the members/loans tables directly. Returns {found:false} or one minimal profile + own loans.
    async studentLookup(key) { return throwIf(await sb.rpc('student_lookup', { p_key: key })); },

    // ---------- members ----------
    async upsertMember(m) {
      var row = memToRow(m);
      var data;
      if (m.id && !/^M\d/.test(m.id)) {           // existing Supabase uuid -> update
        data = throwIf(await sb.from('members').update(row).eq('id', m.id).select().single());
      } else {                                     // new -> insert
        data = throwIf(await sb.from('members').insert(row).select().single());
      }
      return rowToMem(data);
    },
    async deleteMember(id) { throwIf(await sb.from('members').delete().eq('id', id)); },

    // ---------- books ----------
    async upsertBook(b) {
      var row = bookToRow(b);
      var data;
      if (b.id && !/^B\d/.test(b.id)) {
        data = throwIf(await sb.from('books').update(row).eq('id', b.id).select().single());
      } else {
        data = throwIf(await sb.from('books').insert(row).select().single());
      }
      return rowToBook(data);
    },
    async deleteBook(id) { throwIf(await sb.from('books').delete().eq('id', id)); },

    // ---------- titles (bibliografi) ----------
    async pullTitles() { return (await this._pullAll('titles', 'judul', true)).map(rowToTitle); },

    // Satu operasi atomik: buat/pakai judul -> ambil N kode -> sisipkan N eksemplar.
    // Kode dibuat server (counter per-tanggal), TIDAK PERNAH diketik petugas.
    async addBookCopies(p) {
      var rows = throwIf(await sb.rpc('add_book_copies', {
        p_title_id: p.titleId || null, p_judul: p.judul || null,
        p_pengarang: p.pengarang || null, p_penerbit: p.penerbit || null,
        p_tahun: p.tahun || null, p_isbn: p.isbn || null,
        p_kategori: p.kategori || null, p_level_kelas: p.levelKelas || null,
        p_sumber: p.sumber || null, p_tanggal_masuk: p.tanggalMasuk || null,
        p_lokasi: p.lokasi || null, p_kondisi: p.kondisi || 'BAIK',
        p_jumlah: p.jumlah || 1
      }));
      return (rows || []).map(rowToBook);
    },

    // Bibliografi hanya diubah lewat titles; trigger menyalurkannya ke semua eksemplar.
    async updateTitle(id, t) {
      var row = { judul: (t.judul || '').toUpperCase(), pengarang: t.pengarang || null,
        penerbit: t.penerbit || null, tahun: t.tahun || null, isbn: t.isbn || null,
        kategori: t.kategori || null, level_kelas: t.levelKelas || null };
      if (Object.prototype.hasOwnProperty.call(t, 'coverPath')) row.cover_path = t.coverPath || null;
      return rowToTitle(throwIf(await sb.from('titles').update(row).eq('id', id).select().single()));
    },
    async createTitle(t) {
      var row = { judul: (t.judul || '').toUpperCase(), pengarang: t.pengarang || null,
        penerbit: t.penerbit || null, tahun: t.tahun || null, isbn: t.isbn || null,
        kategori: t.kategori || null, level_kelas: t.levelKelas || null };
      if (Object.prototype.hasOwnProperty.call(t, 'coverPath')) row.cover_path = t.coverPath || null;
      return rowToTitle(throwIf(await sb.from('titles').insert(row).select().single()));
    },
    async uploadTitleCover(id, blob, oldPath) {
      var path = id + '/' + Date.now() + '.webp';
      var storage = sb.storage.from(COVER_BUCKET);
      throwIf(await storage.upload(path, blob, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' }));
      try {
        var row = throwIf(await sb.from('titles').update({ cover_path: path }).eq('id', id).select().single());
        if (oldPath && oldPath !== path) { try { await storage.remove([oldPath]); } catch (_) {} }
        return rowToTitle(row);
      } catch (e) {
        try { await storage.remove([path]); } catch (_) {}
        throw e;
      }
    },
    async removeTitleCover(id, path) {
      var row = throwIf(await sb.from('titles').update({ cover_path: null }).eq('id', id).select().single());
      if (path) { try { await sb.storage.from(COVER_BUCKET).remove([path]); } catch (_) {} }
      return rowToTitle(row);
    },

    // Data inventaris melekat pada eksemplar, bukan pada judul. kode tidak ikut (immutable).
    async updateCopy(id, c) {
      var row = { sumber: c.sumber || null, tanggal_masuk: c.tanggalMasuk || null,
        lokasi: c.lokasi || null, kondisi: c.kondisi || 'BAIK' };
      return rowToBook(throwIf(await sb.from('books').update(row).eq('id', id).select().single()));
    },

    // Pengganti hapus: eksemplar tetap ada supaya histori peminjamannya tidak putus.
    async setCopyStatus(id, status, catatan) {
      var d = throwIf(await sb.rpc('set_copy_status',
        { p_book_id: id, p_status: status, p_catatan: catatan || null }));
      return rowToBook(Array.isArray(d) ? d[0] : d);
    },

    async assignTitle(bookIds, titleId) {
      return throwIf(await sb.rpc('assign_title_to_copies',
        { p_book_ids: bookIds, p_title_id: titleId }));
    },

    // ---------- circulation (atomic on the server) ----------
    // sessionId terisi = transaksi milik sesi "Pinjam ke Kelas", bukan bacaan pribadi.
    // Buku sesi kelas dipakai di jam pelajaran itu juga, jadi jatuh temponya hari yang sama.
    async borrow(bookId, memberId, pinjam, days, sessionId) {
      var args = { p_book_id: bookId, p_member_id: memberId, p_pinjam: pinjam };
      if (days !== undefined && days !== null) args.p_days = days;
      if (sessionId) args.p_session_id = sessionId;
      var d = throwIf(await sb.rpc('borrow_book', args));
      return rowToLoan(Array.isArray(d) ? d[0] : d);
    },

    // ---------- baca di tempat ----------
    // Tidak menyentuh stok: buku tetap di rak, hanya aktivitas & kunjungan yang tercatat.
    async bacaDitempat(memberId, bookId, catatan) {
      return throwIf(await sb.rpc('catat_baca_ditempat',
        { p_member_id: memberId, p_book_id: bookId, p_catatan: catatan || null }));
    },

    // ---------- sesi pinjam ke kelas ----------
    async bukaSesiKelas(kelas, kegiatan, memberId) {
      var d = throwIf(await sb.rpc('buka_sesi_kelas',
        { p_kelas: kelas, p_kegiatan: kegiatan || null, p_member_id: memberId || null }));
      return rowToSesi(Array.isArray(d) ? d[0] : d);
    },
    async sesiTerbuka() {
      var res = await sb.from('loan_sessions').select('*')
        .is('ditutup_at', null).order('dibuka_at', { ascending: false }).limit(50);
      return throwIf(res).map(rowToSesi);
    },
    async kembalikanSesi(sessionId) {
      return throwIf(await sb.rpc('kembalikan_sesi_kelas', { p_session_id: sessionId }));
    },
    async returnLoan(loanId) {
      var d = throwIf(await sb.rpc('return_book', { p_loan_id: loanId }));
      return rowToLoan(Array.isArray(d) ? d[0] : d);
    },
    async deleteLoan(loanId) { throwIf(await sb.rpc('delete_loan', { p_loan_id: loanId })); },

    // ---------- dashboard petugas (agregasi di server) ----------
    // Satu panggilan untuk seluruh dashboard. RPC-nya SECURITY INVOKER: isinya memuat
    // nama siswa, jadi RLS authenticated yang menjaga — anon tidak akan menerima apa pun.
    // days = 0 berarti seluruh waktu.
    coverUrl: coverUrl,

    async dashboard(days) { return throwIf(await sb.rpc('dashboard_stats', { p_days: days === undefined ? 30 : days })); },

    // Kunjungan: satu member maksimal satu baris per tanggal (upsert di dalam RPC),
    // jadi memanggilnya berkali-kali dalam sehari aman.
    async catatKunjungan(memberId) { return throwIf(await sb.rpc('catat_kunjungan', { p_member_id: memberId })); },

    // Daftar pengunjung hari ini — kecil, tidak menarik histori kunjungan.
    async visitsToday(limit) {
      var res = await sb.from('visits').select('member_id,nama,kelas,pertama_at,terakhir_at,jumlah_scan')
        .eq('tanggal', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }))
        .order('terakhir_at', { ascending: false }).limit(limit || 10);
      return throwIf(res);
    },

    // ---------- public (anon-safe aggregates) ----------
    async stats() { return throwIf(await sb.rpc('public_stats')); },
    async popular(limit) {
      var rows = throwIf(await sb.rpc('popular_books', { p_limit: limit || 10 }));
      var titles = await this.publicTitles(), byId = {}, byName = {};
      titles.forEach(function (t) { byId[t.id] = t; byName[(t.judul || '').toUpperCase()] = t; });
      return (rows || []).map(function (b) {
        var t = byId[b.title_id] || byName[(b.judul || '').toUpperCase()];
        return Object.assign({}, b, { coverUrl: t ? (t.coverUrl || coverUrl(t.coverPath)) : '' });
      });
    },

    // ---------- realtime: only books + loans ----------
    subscribe(onChange) {
      return sb.channel('elib')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'books' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'loans' }, onChange)
        .subscribe();
    },

    // ---------- one-time idempotent migration of local DB -> Supabase ----------
    // Upsert by natural keys (members.legacy_id / books.kode / loans.legacy_id) so re-running never duplicates.
    // Loans are upserted directly (NOT via borrow_book) so stock is never decremented twice.
    // Per-section try/catch: one failing section does not abort the others; each reports ok/fail + reason.
    async migrateLocal(DB) {
      var rep = {
        members: { total: 0, ok: 0, fail: 0, err: '' },
        books:   { total: 0, ok: 0, fail: 0, err: '' },
        loans:   { total: 0, ok: 0, fail: 0, unmapped: 0, unmappedList: [], err: '' }
      };

      // ---- members (upsert on legacy_id) ----
      var mRows = (DB.members || []).map(memToRow);
      rep.members.total = mRows.length;
      if (mRows.length) {
        try { throwIf(await sb.from('members').upsert(mRows, { onConflict: 'legacy_id' })); rep.members.ok = mRows.length; }
        catch (e) { rep.members.fail = mRows.length; rep.members.err = friendly(e); }
      }

      // ---- books (upsert on kode) ----
      var bRows = (DB.books || []).map(bookToRow);
      rep.books.total = bRows.length;
      if (bRows.length) {
        try { throwIf(await sb.from('books').upsert(bRows, { onConflict: 'kode' })); rep.books.ok = bRows.length; }
        catch (e) { rep.books.fail = bRows.length; rep.books.err = friendly(e); }
      }

      // ---- build legacy-id -> uuid maps for loan FKs (from what actually landed on the server) ----
      // PostgREST memotong response di ~1000 baris. Katalog sudah 1548 buku, sehingga
      // select polos membuat ratusan buku tak terpetakan dan loan-nya salah dilaporkan
      // sebagai "buku tidak ditemukan". Pakai _pullAll yang sudah paginasi.
      var mMap = {}, bMap = {};
      try {
        (await this._pullAll('members', 'id', true)).forEach(function (r) {
          if (r.legacy_id) mMap[r.legacy_id] = r.id;
          if (r.barcode_id) mMap['bc:' + r.barcode_id] = r.id;
        });
        (await this._pullAll('books', 'id', true)).forEach(function (r) {
          if (r.legacy_id) bMap[r.legacy_id] = r.id;
          if (r.kode) bMap['kode:' + r.kode] = r.id;
        });
      } catch (e) { rep.loans.err = 'Gagal memetakan relasi: ' + friendly(e); }

      // ---- loans: HANYA migrasikan yang punya member_id DAN book_id valid. ----
      // Aturan bisnis: loan = transaksi, wajib relasi valid. Yang tak terpetakan TIDAK ditulis
      // (tanpa row setengah rusak), dilaporkan sebagai UNMAPPED dengan identitas legacy.
      // Data localStorage sumber tidak disentuh.
      var lRows = [], unmapped = [];
      (DB.loans || []).forEach(function (l) {
        if (!l.id) return;
        rep.loans.total++;
        var mid = mMap[l.memberId] || (l.barcodeId ? mMap['bc:' + l.barcodeId] : null) || null;
        var bid = bMap[l.bookId] || bMap['kode:' + l.kode] || null;
        if (!mid || !bid) {
          unmapped.push({
            legacyLoanId: l.id,
            legacyMember: l.memberId || (l.barcodeId ? ('barcode:' + l.barcodeId) : '(kosong)'),
            legacyBook: l.bookId || (l.kode ? ('kode:' + l.kode) : '(kosong)'),
            reason: (!mid && !bid) ? 'anggota & buku tidak ditemukan'
                  : (!mid ? 'anggota tidak ditemukan' : 'buku tidak ditemukan')
          });
          return;   // JANGAN simpan loan tanpa relasi valid
        }
        lRows.push({
          legacy_id: /^L\d/.test(l.id) ? l.id : ('L' + l.id),
          member_id: mid, book_id: bid,
          nama: l.nama, kelas: l.kelas, jk: l.jk || null, no_anggota: l.noAnggota || null,
          kode: l.kode, judul: l.judul, pinjam: l.pinjam,
          batas: l.batas, kembali: l.kembali || null, sanksi: l.sanksi || null
        });
      });
      rep.loans.unmapped = unmapped.length;
      rep.loans.unmappedList = unmapped;
      if (lRows.length) {
        try { throwIf(await sb.from('loans').upsert(lRows, { onConflict: 'legacy_id' })); rep.loans.ok = lRows.length; }
        catch (e) { rep.loans.fail = lRows.length; rep.loans.err = (rep.loans.err ? rep.loans.err + ' | ' : '') + friendly(e); }
      }

      return rep;
    }
  };

  global.LibraryAPI = API;
  global.SB_ENABLED = ENABLED;
})(typeof window !== 'undefined' ? window : this);
