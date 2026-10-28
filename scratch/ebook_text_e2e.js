const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();
for(const [label,block] of [['normal',false],['backend-gagal',true]]){
  const p=await b.newPage();
  if(block) await p.route('**/rest/v1/**',r=>r.abort());
  await p.goto('http://127.0.0.1:8000/index.html');
  await p.waitForFunction(()=>window.goPage);
  await p.evaluate(()=>goPage('pub-ebook')); await p.waitForTimeout(3000);
  const t=await p.evaluate(()=>document.getElementById('pubEbookGrid').innerText.trim());
  console.log(label,'=>',JSON.stringify(t), '| tombol baca:', await p.locator('#pubEbookGrid button').count());
  await p.close();}
await b.close();})();
