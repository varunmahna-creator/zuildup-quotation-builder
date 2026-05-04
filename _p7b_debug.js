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
  // Inspect: how many .pg sections were rendered? What's the count of Zones in each?
  const out = await page.evaluate(() => {
    const pgs = Array.from(document.querySelectorAll('section.pg'));
    return pgs.map((p, i) => {
      const txt = p.innerText.slice(0, 60).replace(/\n/g,'|');
      const zones = [];
      ['Zone A','Zone B','Zone C','Zone D','Zone E'].forEach(z => { if (p.innerText.includes(z)) zones.push(z); });
      return { i: i+1, txt, zones };
    });
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
