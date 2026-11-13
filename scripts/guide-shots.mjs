// Regenerates the Guide's pictures from the real app: runs the built studio in a browser, crops each area,
// and records where every documented control sits so the numbered markers land on it.
// Run with `npm run guide` after changing the screen, then rebuild.
import { createRequire } from 'node:module';
import { preview } from 'vite';
import fs from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const guide = JSON.parse(fs.readFileSync('src/guide/guide.json', 'utf8'));
const OUT = 'src/guide/shots';
fs.mkdirSync(OUT, { recursive: true });

const server = await preview({ preview: { port: 4319, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem('sticky.anthropicKey', 'guide-picture'); } catch { /* fine */ } });
await page.goto('http://localhost:4319/');
await page.click('#start');
await page.waitForSelector('.pads');
const hit = (pad) => page.dispatchEvent(`#pad-${pad}`, 'pointerdown');
const size = (w, h) => page.setViewportSize({ width: w, height: h });

// How to get each area into a state worth photographing. `maxH` crops tall full-screen sheets.
const setups = {
  transport: async () => {},
  modules: async () => {},
  chop: async () => {},
  pads: async () => {},
  steps: async () => { await hit(0); await page.click('.tab:has-text("Steps")'); },
  pad: async () => { await page.click('.tab:has-text("Pad")'); },
  fx: async () => {
    await size(1280, 1560); // tall, so the whole panel shows without scrolling
    await page.click('#tab-fx');
    await page.click('#fx-filter-lowpass'); await page.fill('#fx-drive', '0.25'); await page.fill('#fx-delay', '0.3');
    await page.fill('#fx-reverb', '0.3'); await page.click('#fx-stretch-2'); await page.fill('#fx-scatter', '0.2');
  },
  roll: async () => {
    await page.click('#fx-reset'); await size(1280, 800);
    await page.click('#view-roll'); await page.waitForSelector('#roll');
    const box = await page.locator('#roll').boundingBox();
    const cell = (col, row) => ({ x: 46 + (box.width - 46) * ((col + 0.5) / 32), y: (box.height / 15) * (row + 0.5) });
    for (const [col, row] of [[0, 7], [4, 7], [6, 5], [8, 4], [12, 7], [16, 9], [20, 7], [22, 5], [24, 2], [28, 4]]) await page.locator('#roll').click({ position: cell(col, row) });
  },
  clips: async () => {
    await page.click('#view-chop'); await page.click('#mod-clips'); await page.click('#save-clip-0'); await page.click('#save-clip-0'); await page.click('#save-clip-1');
    await page.locator('.clip').nth(0).click(); await page.waitForSelector('.clip.playing'); await page.waitForTimeout(300);
    return { maxH: 420 };
  },
  arrange: async () => {
    await page.click('#play'); await page.click('#mod-arrange');
    const lane = (t) => page.locator(`.tl-track[data-track="${t}"]`);
    await lane(0).click({ position: { x: 10, y: 20 } }); await page.click('#arr-more');
    await page.locator('.brush').nth(2).click(); await lane(1).click({ position: { x: 48 * 2 + 10, y: 20 } }); await page.click('#arr-more'); await page.click('#arr-more');
    await page.locator('.brush').nth(1).click(); await lane(0).click({ position: { x: 48 * 4 + 10, y: 20 } });
    return { maxH: 430 };
  },
  mixer: async () => {
    await page.click('#mod-mixer'); await page.fill('#eq-high-0', '-3'); await page.fill('#pan-1', '-0.3'); await page.fill('#fader-1', '0.8');
    await page.click('#play'); await page.waitForTimeout(700);
    return { maxH: 600 };
  },
  library: async () => {
    await page.click('#play'); await page.click('#mix-reset'); await page.click('#mod-studio'); await page.click('#save-sample'); await page.waitForSelector('.toast');
    await page.click('.tab:has-text("Pad")'); await page.click('#save-pad'); await page.waitForTimeout(400);
    await page.click('#library'); await page.click('#lib-save-loop'); await page.waitForFunction(() => document.querySelectorAll('.lib-row').length === 3);
    await page.click('.lib-row >> nth=1 >> text=Rename / tag'); await page.fill('.lib-edit input[name="name"]', 'Kick A1'); await page.fill('.lib-edit input[name="tags"]', 'kick, one-shot');
    await page.click('.lib-edit >> text=Save'); await page.waitForSelector('.lib-name:has-text("Kick A1")');
    await page.waitForTimeout(4200); // let the confirmation message clear
    return { maxH: 330 };
  },
  projects: async () => {
    await page.click('#lib-tab-projects'); await page.fill('#proj-name', 'Dark loop idea'); await page.click('#proj-save');
    await page.waitForSelector('.lib-row:has-text("Dark loop idea")'); await page.fill('#proj-name', 'Next idea'); await page.waitForTimeout(4200);
    return { maxH: 290 };
  },
  assistant: async () => { await page.click('#lib-close'); await page.click('#assistant'); await page.waitForSelector('.chat-empty'); },
};

const marks = {};
for (const s of guide.sections) {
  const opt = (await setups[s.id]()) ?? {};
  await page.waitForTimeout(150);
  const b = await page.locator(s.clip).first().boundingBox();
  const clip = { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(Math.min(b.height, opt.maxH ?? Infinity)) };
  await page.screenshot({ path: `${OUT}/${s.id}.jpg`, type: 'jpeg', quality: 80, clip });
  const pts = [];
  for (const m of s.marks) {
    const el = page.locator(m.sel).first();
    const box = (await el.count()) && (await el.isVisible()) ? await el.boundingBox() : null;
    if (!box) { console.warn(`  ! ${s.id}: nothing on screen for "${m.name}" (${m.sel})`); pts.push(null); continue; }
    // The marker sits just outside the control's top-left corner so it does not cover the control's own text.
    // A slider is marked beside its label (the name above it), not on the track.
    const slider = await el.evaluate((n) => { const l = n.matches('input[type=range]') ? n.closest('label') : null; if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = slider ? { x: slider.x - 9, y: slider.y + 8 } : { x: box.x - 3, y: box.y + 1 };
    const x = Math.min(clip.width - 12, Math.max(12, at.x - clip.x)), y = Math.min(clip.height - 12, Math.max(12, at.y - clip.y));
    pts.push({ x: +((x / clip.width) * 100).toFixed(2), y: +((y / clip.height) * 100).toFixed(2) });
  }
  marks[s.id] = { w: clip.width, h: clip.height, pts };
  console.log(`${s.id}: ${clip.width}x${clip.height}, ${pts.filter(Boolean).length}/${pts.length} markers, ${(fs.statSync(`${OUT}/${s.id}.jpg`).size / 1024).toFixed(0)} kB`);
}
fs.writeFileSync('src/guide/marks.json', JSON.stringify(marks, null, 1) + '\n');
await browser.close();
await new Promise((r) => server.httpServer.close(r));
