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
  // Pull the actual computed quote and compute splitPivot here.
  const out = await page.evaluate(() => {
    // The script ran; we have access to localStorage. computeQuote isn't global.
    // So just read the rendered state.
    const sec = document.querySelectorAll('section.pg');
    const areas = Array.from(sec).filter(s => s.innerText.includes('Area Calculation'));
    return {
      pgCount: sec.length,
      areaPgCount: areas.length,
      foots: areas.map(s => s.querySelector('.pg-foot')?.innerText),
      page1ZoneTags: Array.from(areas[0].querySelectorAll('.zone-tag')).map(t => t.textContent.trim()),
      page2ZoneTags: areas[1] ? Array.from(areas[1].querySelectorAll('.zone-tag')).map(t => t.textContent.trim()) : [],
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
