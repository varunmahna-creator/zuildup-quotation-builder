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
  // Check the source of the area-page section  - look for "(1/2)" footer.
  const out = await page.evaluate(() => {
    const pgs = Array.from(document.querySelectorAll('section.pg'));
    const areaPgs = pgs.filter(p => p.innerText.includes('Area Calculation'));
    // Check footer label of each
    return areaPgs.map(p => {
      const foot = p.querySelector('.pg-foot');
      return { foot: foot ? foot.innerText : null, height: p.offsetHeight, scrollHeight: p.scrollHeight };
    });
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
