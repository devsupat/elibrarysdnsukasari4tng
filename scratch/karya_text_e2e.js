const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();
for(const [label,block] of [['normal',false],['backend-gagal',true]]){
  const p=await b.newPage();
  if(block) await p.route('**/rest/v1/**',r=>r.abort());
  await p.goto('http://127.0.0.1:8000/index.html');
  await p.waitForFunction(()=>window.goPage); await p.waitForTimeout(3000);
  const g=id=>p.evaluate(i=>document.getElementById(i).innerText.trim(),id);
  const fake=await p.evaluate(()=>/PETUALANGAN|INDONESIAKU|SEKOLAH BERSALJU|Siswa A|Budi Santoso/.test(document.body.innerText));
  const beranda=await g('pubKaryaPreviewGrid');
  await p.click('text=Lihat Semua Karya');
  const semua=await g('pubKaryaFullGrid');
  console.log(label,'| beranda:',JSON.stringify(beranda),'| semua:',JSON.stringify(semua),'| karya palsu:',fake,'| stat:',await g('pubStatKarya'));
  await p.close();}
await b.close();})();
