function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = JSON.parse(e.postData.contents);
  var sheets = ['ANGGOTA','KATALOG','PEMINJAMAN','ABSENSI','KARYA','EBOOK'];
  sheets.forEach(function(name){
    var rows = data[name] || [];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clearContents();
    if (rows.length) {
      var headers = Object.keys(rows[0]);
      var values = [headers].concat(rows.map(function(r){
        return headers.map(function(h){ return r[h]; });
      }));
      sh.getRange(1, 1, values.length, headers.length).setValues(values);
    }
  });
  var log = ss.getSheetByName('LOG SINKRON') || ss.insertSheet('LOG SINKRON');
  log.appendRow([new Date(), 'Sinkron berhasil']);
  return ContentService.createTextOutput(JSON.stringify({ok:true}))
    .setMimeType(ContentService.MimeType.JSON);
}
