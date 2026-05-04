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
  await page.goto('https://zuildup-quotes-zim2owjloq-el.a.run.app/app/preview.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  // Now fetch quote.js and find the splitPivot decision via regex on the HTML
  // it generated in DOM. The .zone-tag elements show which zones landed where.
  // Simpler: just count items in Zone A and Zone B as exposed in DOM.
  const result = await page.evaluate(() => {
    const sec = document.querySelectorAll('section.pg');
    const areas = Array.from(sec).filter(s => s.innerText.includes('Area Calculation'));
    const zRows = areas[0].querySelectorAll('tr.zone-hdr, tr.zone-total');
    return {
      page1ZoneHeaders: Array.from(areas[0].querySelectorAll('tr.zone-hdr')).map(t => t.innerText.slice(0,40)),
      page1ZoneTotals: Array.from(areas[0].querySelectorAll('tr.zone-total')).map(t => t.innerText.slice(0,80)),
      page2ZoneHeaders: areas[1] ? Array.from(areas[1].querySelectorAll('tr.zone-hdr')).map(t => t.innerText.slice(0,40)) : [],
      // Count items in Zone A (rows between A header and A total)
      page1AllRows: Array.from(areas[0].querySelectorAll('tbody tr')).map(r => r.className + ': ' + r.innerText.slice(0,40)),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
