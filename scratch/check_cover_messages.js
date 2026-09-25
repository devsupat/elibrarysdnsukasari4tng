/* Pesan error cover tidak boleh menampilkan istilah teknis Supabase ke petugas. */
const assert = require('assert');
global.window = global; // supabase-layer.js dipasang ke global object
require('../supabase-layer.js');
const msg = global.LibraryAPI.msg;
const cases = [
  ['Bucket not found', 'Penyimpanan cover belum siap. Hubungi admin.'],
  ["Could not find the 'cover_path' column of 'titles' in the schema cache (PGRST204)", 'Penyimpanan cover belum siap. Hubungi admin.'],
  ['mime type image/gif is not supported', 'Gambar cover ditolak penyimpanan. Pakai JPG/PNG/WebP ukuran wajar.'],
  ['The object exceeded the maximum allowed size', 'Gambar cover ditolak penyimpanan. Pakai JPG/PNG/WebP ukuran wajar.'],
  ['new row violates row-level security policy', 'Akses ditolak — login sebagai petugas dulu.'],
  ['StorageApiError: Object not found', 'Cover gagal disimpan. Silakan coba lagi.'],
];
for (const [raw, want] of cases) {
  const got = msg(new Error(raw));
  assert.strictEqual(got, want, `"${raw}" → "${got}" (harusnya "${want}")`);
  assert.ok(!/PGRST|StorageApiError|bucket|row-level/i.test(got), 'istilah teknis lolos: ' + got);
}
console.log('OK — ' + cases.length + ' pesan error cover ramah petugas');
