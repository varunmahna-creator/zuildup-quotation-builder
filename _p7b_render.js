const puppeteer = require('puppeteer-core');
const fs = require('fs');
(async () => {
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const outPdf = process.argv[3];
  const outPng = process.argv[4]; // optional first-page png

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox','--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.authenticate({ username: 'zuildup-sales', password: 'zuildup' });

  // Plant localStorage on host first.
  await page.goto('https://zuildup-quotes-zim2owjloq-el.a.run.app/', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate((s) => {
    localStorage.setItem('zuildup.quote.v2', JSON.stringify(s));
  }, fixture);
  // Now load preview.
  await page.goto('https://zuildup-quotes-zim2owjloq-el.a.run.app/app/preview.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  await page.pdf({
    path: outPdf,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  console.log('PDF →', outPdf);

  if (outPng) {
    // Also screenshot the area-calc page (should be page 3-ish: cover, zone color key, area)
    // We render the full page and screenshot — caller will crop.
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 }); // A4 @ 96dpi
    await page.screenshot({ path: outPng, fullPage: true });
    console.log('PNG →', outPng);
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
