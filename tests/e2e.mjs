// End-to-end check in a real browser: the studio boots, pads sound, recording writes hits, export renders real audio.
// Run `npm run build` first. Usage: node tests/e2e.mjs [screenshotDir]
import { createRequire } from 'node:module';
import { preview } from 'vite';
import fs from 'node:fs';

// Playwright is resolved through require so a globally installed copy (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)('playwright');
const shots = process.argv[2];
const server = await preview({ preview: { port: 4317, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

async function wavStats(download) {
  const buf = fs.readFileSync(await download.path());
  let peak = 0;
  for (let o = 44; o + 1 < buf.length; o += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(o)));
  return { bytes: buf.length, peak, rate: buf.readUInt32LE(24), channels: buf.readUInt16LE(22) };
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:4317/');
  await page.click('#start');
  await page.waitForSelector('.pads');
  check('demo loop is on all 16 pads', (await page.locator('.pad.loaded').count()) === 16);
  check('waveform canvas has size', await page.evaluate(() => document.querySelector('.wave-canvas canvas').width > 200));

  await page.dispatchEvent('#pad-3', 'pointerdown');
  check('hitting a pad lights it', await page.locator('#pad-3.lit').count() === 1);
  check('hitting a pad selects it', await page.locator('#pad-3.sel').count() === 1);

  // Export the starter pattern: 2 bars at 100 BPM = 4.8 s of stereo 44.1 kHz.
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  let w = await wavStats(dl);
  check('export is 2 bars long', Math.abs((w.bytes - 44) / 4 / w.rate - 4.8) < 0.01, `${((w.bytes - 44) / 4 / w.rate).toFixed(3)} s`);
  check('export contains sound', w.peak > 2000, `peak ${w.peak}`);

  // Clearing every pattern must render silence: proves export follows the project, not a canned file.
  await page.evaluate(() => 0);
  for (const pad of [0, 1, 2]) {
    await page.dispatchEvent(`#pad-${pad}`, 'pointerdown');
    await page.click('text=Clear steps');
  }
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  w = await wavStats(dl);
  check('export of an empty pattern is silent', w.peak === 0, `peak ${w.peak}`);
  for (let i = 0; i < 3; i++) await page.click('#undo');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  check('undo brings the pattern back', (await wavStats(dl)).peak > 2000);

  // Step toggle cycles on -> soft -> off.
  await page.dispatchEvent('#pad-5', 'pointerdown');
  await page.click('#step-3');
  check('step turns on', await page.locator('#step-3.on').count() === 1);
  await page.click('#step-3');
  check('step turns soft', await page.locator('#step-3.soft').count() === 1);
  await page.click('#step-3');

  // Record two live hits into the loop.
  await page.click('#rec');
  await page.waitForTimeout(400);
  await page.dispatchEvent('#pad-7', 'pointerdown');
  await page.waitForTimeout(600);
  await page.dispatchEvent('#pad-7', 'pointerdown');
  await page.waitForTimeout(300);
  check('position counter runs', /\d\.\d/.test(await page.locator('.pos').innerText()));
  await page.click('#play');
  check('two hits were recorded', await page.locator('text=Erase 2 recorded hits').count() === 1);
  await page.click('#undo');
  check('one undo removes the whole take', await page.locator('text=Erase 0 recorded hits').count() === 1);

  // Auto-slice and send to pads.
  await page.click('#autoslice');
  const meta = await page.locator('.chopbar .meta').innerText();
  check('auto-slice finds slices', parseInt(meta) >= 6, meta);
  await page.click('#topads');

  // Pad editing.
  await page.click('.tab:has-text("Pad")');
  await page.click('#pad-reverse');
  check('reverse toggles', await page.locator('#pad-reverse[aria-pressed="true"]').count() === 1);

  // Import a user file.
  const sr = 44100, n = sr * 2, pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = (i % (sr / 2)) / sr; pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * Math.exp(-12 * t) * 20000), 44 + i * 2); }
  await page.setInputFiles('#file', { name: 'my-test-tone.wav', mimeType: 'audio/wav', buffer: pcm });
  await page.waitForSelector('#sample option:has-text("my-test-tone")', { state: 'attached' });
  check('imported file appears in the sample list', true);
  await page.click('#autoslice');
  check('imported file slices at its 4 hits', (await page.locator('.chopbar .meta').innerText()).startsWith('4 '), await page.locator('.chopbar .meta').innerText());
  await page.setInputFiles('#file', { name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not audio') });
  await page.waitForSelector('.toast');
  check('unreadable file shows a message', (await page.locator('.toast').innerText()).includes('Could not read'));

  if (shots) await page.screenshot({ path: `${shots}/landscape.png` });

  // Autosave: reload and the imported sample is still there.
  await page.waitForTimeout(700);
  await page.reload();
  await page.click('#start');
  await page.waitForSelector('.pads');
  check('project survives a reload', await page.locator('#sample option:has-text("my-test-tone")').count() === 1);

  await page.setViewportSize({ width: 800, height: 1280 });
  await page.waitForTimeout(200);
  check('portrait has no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (shots) await page.screenshot({ path: `${shots}/portrait.png`, fullPage: true });
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(200);
  check('phone width has no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (shots) await page.screenshot({ path: `${shots}/phone.png`, fullPage: true });

  check('no console errors', errors.filter((e) => !e.includes('Unable to decode')).length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
