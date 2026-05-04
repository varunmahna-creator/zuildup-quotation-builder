const puppeteer = require('puppeteer-core');
const fs = require('fs');
(async () => {
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox','--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.authenticate({ username: 'zuildup-sales', password: 'zuildup' });
  await page.goto('https://zuildup-quotes-zim2owjloq-el.a.run.app/', { waitUntil: 'networkidle0' });
  await page.evaluate((s) => localStorage.setItem('zuildup.quote.v2', JSON.stringify(s)), fixture);
  // Inject a hook into preview.html: load the script via fetch, instrument, eval.
  await page.goto('https://zuildup-quotes-zim2owjloq-el.a.run.app/app/preview.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  const rowCounts = await page.evaluate(() => {
    // We can compute by counting visible items on the page via DOM inspection.
    const sec = document.querySelectorAll('section.pg');
    const areas = Array.from(sec).filter(s => s.innerText.includes('Area Calculation'));
    // Count zone-hdr + total per zone in DOM
    const tbl1 = areas[0].querySelector('.calc-table tbody');
    const tbl2 = areas[1] ? areas[1].querySelector('.calc-table tbody') : null;
    return {
      page1Rows: tbl1.querySelectorAll('tr').length,
      page2Rows: tbl2 ? tbl2.querySelectorAll('tr').length : 0,
      // For each zone, count items (tr without zone-hdr/zone-total class)
      page1ZoneA: tbl1 ? Array.from(tbl1.querySelectorAll('tr.zone-hdr')).map(z => z.innerText.slice(0,30)) : [],
    };
  });
  console.log(JSON.stringify(rowCounts, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
