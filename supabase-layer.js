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
  function rowToBook(r) {
    return { id: r.id, kode: r.kode, judul: r.judul, pengarang: r.pengarang || '', penerbit: r.penerbit || '',
      tahun: r.tahun || '', kategori: r.kategori || '', jumlah: r.jumlah, tersedia: r.tersedia };
  }
  function bookToRow(b) {
    return { kode: String(b.kode), judul: b.judul, pengarang: b.pengarang || null, penerbit: b.penerbit || null,
      tahun: b.tahun || null, kategori: b.kategori || null, jumlah: b.jumlah, tersedia: b.tersedia,
      legacy_id: (b.id && /^B\d/.test(b.id)) ? b.id : null };
  }
  function rowToLoan(r) {
    return { id: r.id, memberId: r.member_id, bookId: r.book_id, nama: r.nama, kelas: r.kelas,
      jk: r.jk, noAnggota: r.no_anggota, kode: r.kode, judul: r.judul, pinjam: r.pinjam,
      batas: r.batas, kembali: r.kembali || '', sanksi: r.sanksi || '' };
  }

  function friendly(e) {
    var m = (e && e.message) || String(e || '');
    if (/STOK_HABIS/.test(m)) return 'Stok buku habis / semua eksemplar dipinjam.';
    if (/SUDAH_KEMBALI/.test(m)) return 'Transaksi sudah dikembalikan / tidak ditemukan.';
    if (/ANGGOTA_TIDAK/.test(m)) return 'Anggota tidak ditemukan.';
    if (/duplicate key/.test(m) && /barcode/.test(m)) return 'Barcode ID sudah dipakai anggota lain.';
    if (/duplicate key/.test(m) && /kode/.test(m)) return 'Kode buku sudah ada di katalog.';
    if (/row-level security|permission denied/.test(m)) return 'Akses ditolak — login sebagai petugas dulu.';
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
    async _pullAll(table, orderCol, ascending) {
      var PAGE = 1000, from = 0, all = [];
      for (;;) {
        var res = await sb.from(table).select('*')
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
    async pullLoans()   { return (await this._pullAll('loans', 'created_at', false)).map(rowToLoan); },

    // ---------- PUBLIC (anon) ----------
    // Catalog is public (RLS books_read_all). Paginated so ALL rows load, not capped at 1000.
    async publicBooks() { return (await this._pullAll('books', 'judul', true)).map(rowToBook); },
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

    // ---------- circulation (atomic on the server) ----------
    async borrow(bookId, memberId, pinjam) {
      var d = throwIf(await sb.rpc('borrow_book', { p_book_id: bookId, p_member_id: memberId, p_pinjam: pinjam }));
      return rowToLoan(Array.isArray(d) ? d[0] : d);
    },
    async returnLoan(loanId) {
      var d = throwIf(await sb.rpc('return_book', { p_loan_id: loanId }));
      return rowToLoan(Array.isArray(d) ? d[0] : d);
    },
    async deleteLoan(loanId) { throwIf(await sb.rpc('delete_loan', { p_loan_id: loanId })); },

    // ---------- public (anon-safe aggregates) ----------
    async stats() { return throwIf(await sb.rpc('public_stats')); },
    async popular(limit) { return throwIf(await sb.rpc('popular_books', { p_limit: limit || 10 })); },

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
      var mMap = {}, bMap = {};
      try {
        throwIf(await sb.from('members').select('id,legacy_id,barcode_id')).forEach(function (r) {
          if (r.legacy_id) mMap[r.legacy_id] = r.id;
          if (r.barcode_id) mMap['bc:' + r.barcode_id] = r.id;
        });
        throwIf(await sb.from('books').select('id,legacy_id,kode')).forEach(function (r) {
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
