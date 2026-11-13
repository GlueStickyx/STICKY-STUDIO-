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
  const rate = buf.readUInt32LE(24);
  // RMS of the left channel between two times in seconds.
  const rms = (from, to) => { let sum = 0, n = 0; for (let f = Math.floor(from * rate); f < to * rate && 44 + f * 4 + 1 < buf.length; f++) { const v = buf.readInt16LE(44 + f * 4) / 32768; sum += v * v; n++; } return Math.sqrt(sum / Math.max(1, n)); };
  return { bytes: buf.length, peak, rate, channels: buf.readUInt16LE(22), rms };
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

  // Effects change the rendered audio, not just the screen.
  const exportStats = async () => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#export')]); return wavStats(d); };
  const dry = await exportStats();
  await page.click('#tab-fx');
  for (const pad of [0, 1, 2]) {
    await page.dispatchEvent(`#pad-${pad}`, 'pointerdown');
    await page.click('#fx-filter-highpass');
    await page.fill('#fx-cutoff', '1');
  }
  const thin = await exportStats();
  check('a 16 kHz high-pass removes most of the sound', thin.rms(0, 4.8) < dry.rms(0, 4.8) * 0.3, `${dry.rms(0, 4.8).toFixed(4)} -> ${thin.rms(0, 4.8).toFixed(4)}`);
  for (const pad of [0, 1, 2]) { await page.dispatchEvent(`#pad-${pad}`, 'pointerdown'); await page.click('#fx-reset'); }
  check('removing effects restores the sound', Math.abs((await exportStats()).rms(0, 4.8) - dry.rms(0, 4.8)) < 0.001);
  await page.dispatchEvent('#pad-0', 'pointerdown');
  await page.fill('#fx-drive', '1');
  const driven = await exportStats();
  check('drive changes the sound without clipping the file', Math.abs(driven.rms(0, 4.8) - dry.rms(0, 4.8)) > 0.002 && driven.peak < 32767, `peak ${driven.peak}`);
  await page.click('#fx-reset');
  // One kick on the last step, with a quarter-note echo: the echo must wrap round to the start of the loop.
  await page.click('.tab:has-text("Steps")');
  for (const pad of [1, 2, 0]) { await page.dispatchEvent(`#pad-${pad}`, 'pointerdown'); await page.click('text=Clear steps'); }
  await page.click('#step-15');
  const lone = await exportStats();
  check('without echo the middle of the loop is silent', lone.rms(0.35, 0.7) < 0.0005, lone.rms(0.35, 0.7).toFixed(5));
  await page.click('#tab-fx');
  // Stretch: the kick on the last step normally ends 0.15 s into the next pass; at twice the length it runs to 0.45 s.
  check('unstretched, 0.2-0.4 s is silent', lone.rms(0.2, 0.4) < 0.0005, lone.rms(0.2, 0.4).toFixed(5));
  await page.click('#fx-stretch-2');
  const long = await exportStats();
  check('stretch x2 makes the slice last twice as long', long.rms(0.2, 0.4) > 0.01 && long.rms(0.5, 0.7) < 0.0005, `${long.rms(0.2, 0.4).toFixed(4)} then ${long.rms(0.5, 0.7).toFixed(5)}`);
  await page.click('#fx-fit-1');
  check('fit to 1/4 sets the stretch to one beat', (await page.locator('.fx-row .meta').innerText()).includes('0.60 s'), await page.locator('.fx-row .meta').innerText());
  await page.click('#fx-stretch-1');
  await page.fill('#fx-scatter', '1');
  const cloud = await exportStats();
  check('scatter changes the sound but not its length', Math.abs(cloud.rms(4.65, 4.8) - lone.rms(4.65, 4.8)) > 0.0005 && cloud.rms(0.2, 0.4) < 0.0005);
  await page.click('#fx-reset');
  await page.fill('#fx-reverb', '1');
  await page.click('#fx-space-vast');
  const wet = await exportStats();
  // The pattern repeats each bar, so the kick lands at 2.25 s and 4.65 s; 1.2-1.6 s is more than a second after either.
  check('reverb tail fills the gap and wraps round the loop', wet.rms(0.35, 0.7) > 0.002 && wet.rms(1.2, 1.6) > 0.0002 && wet.rms(0.35, 0.7) > wet.rms(1.2, 1.6), `${wet.rms(0.35, 0.7).toFixed(4)}, ${wet.rms(1.2, 1.6).toFixed(5)}`);
  await page.click('#fx-space-room');
  const room = await exportStats();
  check('a room is much shorter than vast', room.rms(1.2, 1.6) < wet.rms(1.2, 1.6) * 0.05, `${room.rms(1.2, 1.6).toFixed(6)} vs ${wet.rms(1.2, 1.6).toFixed(5)}`);
  await page.click('#fx-reset');
  await page.fill('#fx-delay', '1');
  await page.click('#fx-time-1-4');
  const echoed = await exportStats();
  check('echo tail wraps to the start so the loop is seamless', echoed.rms(0.35, 0.7) > 0.01, echoed.rms(0.35, 0.7).toFixed(4));
  await page.click('#fx-stutter-4');
  check('stutter changes the rendered hit', Math.abs((await exportStats()).rms(4.6, 4.8) - echoed.rms(4.6, 4.8)) > 0.0005);
  // Resample prints the pad with its effects into a new sample and clears the effects.
  await page.click('#fx-resample');
  await page.waitForSelector('#sample option:has-text("resampled")', { state: 'attached' });
  check('resample adds a new sample and clears the pad effects', !(await page.locator('#tab-fx').innerText()).includes('•') && await page.locator('#pad-0.loaded').count() === 1);
  const printed = await exportStats();
  check('the resampled pad still carries its echo', printed.rms(0.35, 0.7) > 0.005, printed.rms(0.35, 0.7).toFixed(4));
  await page.click('#undo');
  check('one undo reverses the resample', await page.locator('#sample option:has-text("resampled")').count() === 0 && (await page.locator('#tab-fx').innerText()).includes('•'));
  for (let i = 0; i < 40 && await page.locator('#undo:not([disabled])').count(); i++) await page.click('#undo');
  await page.dispatchEvent('#pad-0', 'pointerdown');
  await page.click('.tab:has-text("Steps")');

  // Piano roll: a drawn note is heard in the export, saved to MIDI, and comes back from the MIDI file.
  await page.click('#view-roll');
  await page.waitForSelector('#roll');
  const before = await exportStats();
  await page.click('#len-384'); // one bar
  const box = await page.locator('#roll').boundingBox();
  const cell = { x: 46 + (box.width - 46) * (0.5 / 32), y: 4 }; // first 16th, top row (one octave up)
  await page.locator('#roll').click({ position: cell });
  check('tapping the roll adds a note', (await page.locator('.chopbar .meta').first().innerText()).includes('1 note'));
  const withNote = await exportStats();
  check('the note is heard in the export', Math.abs(withNote.rms(0, 2.4) - before.rms(0, 2.4)) > 0.002, `${before.rms(0, 2.4).toFixed(4)} -> ${withNote.rms(0, 2.4).toFixed(4)}`);
  const [midiDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-midi')]);
  const midiBytes = fs.readFileSync(await midiDl.path());
  check('MIDI export is a MIDI file with the tempo track, pads and one note track', midiBytes.subarray(0, 4).toString() === 'MThd' && midiBytes.readUInt16BE(10) === 3, midiDl.suggestedFilename());
  await page.click('#clear-notes');
  check('clear notes empties the roll', (await page.locator('.chopbar .meta').first().innerText()).includes('0 notes'));
  await page.setInputFiles('#midi-file', { name: 'riff.mid', mimeType: 'audio/midi', buffer: midiBytes });
  await page.waitForSelector('.toast:has-text("Imported 1 notes onto pad A1")');
  check('MIDI import brings the note back', Math.abs((await exportStats()).rms(0, 2.4) - withNote.rms(0, 2.4)) < 0.001);
  await page.setInputFiles('#midi-file', { name: 'bad.mid', mimeType: 'audio/midi', buffer: Buffer.from('nope') });
  await page.waitForSelector('.toast:has-text("Could not read")');
  await page.locator('#roll').click({ position: cell });
  check('tapping a note removes it', (await page.locator('.chopbar .meta').first().innerText()).includes('0 notes'));
  if (shots) { await page.locator('#roll').click({ position: cell }); await page.locator('#roll').click({ position: { x: 46 + (box.width - 46) * (20.5 / 32), y: box.height / 2 } }); await page.screenshot({ path: `${shots}/roll.png` }); }
  for (let i = 0; i < 40 && await page.locator('#undo:not([disabled])').count(); i++) await page.click('#undo');
  await page.click('#view-chop');

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

  // Module tabs: tools not built yet say so plainly and lead back to the Sampler.
  check('a tab exists for every tool', await page.locator('.modules .mod').count() === 9 && await page.locator('.mod .soon').count() === 7);
  await page.click('#mod-arrange');
  check('an unbuilt tool says it is not built and what works today', /not built yet/i.test(await page.locator('.planned-card').innerText()) && /what you can do today/i.test(await page.locator('.planned-card').innerText()) && await page.locator('.pads').count() === 0);
  await page.click('text=Back to the Sampler');
  check('back returns to the working studio', await page.locator('.pad.loaded').count() === 16);

  // Clips: save the loop twice with different content, launch both in time, mix them.
  await page.click('#mod-clips');
  await page.click('#save-clip-0');
  await page.waitForSelector('.clip');
  await page.click('#mod-studio');
  await page.dispatchEvent('#pad-5', 'pointerdown');
  await page.click('#step-2');
  await page.click('#mod-clips');
  await page.click('#save-clip-1');
  check('two clips saved on two tracks', await page.locator('.clip').count() === 2 && await page.locator('#rec[disabled]').count() === 1);
  await page.locator('.clip').nth(0).click();
  await page.waitForSelector('.clip.playing');
  check('launching a clip starts the transport', /\d\.\d/.test(await page.locator('.pos').innerText()));
  await page.locator('.clip').nth(1).click();
  await page.waitForSelector('.clip.queued', { timeout: 2000 });
  check('a second clip waits for the bar line', true);
  await page.waitForFunction(() => document.querySelectorAll('.clip.playing').length === 2, null, { timeout: 6000 });
  check('then both play together', true);
  await page.click('#mute-0');
  check('mute is shown on the track', await page.locator('#mute-0[aria-pressed="true"]').count() === 1);
  await page.click('#mute-0');
  await page.click('#stop-0');
  await page.waitForFunction(() => document.querySelectorAll('.clip.playing').length === 1, null, { timeout: 6000 });
  check('stopping a track ends its clip on the bar line and leaves the other playing', true);
  if (shots) await page.screenshot({ path: `${shots}/clips.png` });
  await page.click('#play');
  await page.click('[aria-label^="Options for Clip 1"]');
  await page.click('text=Edit in Sampler');
  check('edit in Sampler returns to the pads with the clip loaded', await page.locator('.pad.loaded').count() === 16 && await page.locator('.clips').count() === 0);
  for (let i = 0; i < 4; i++) await page.click('#undo'); // the clip load, two saves and one step: back to where this block began
  await page.dispatchEvent('#pad-0', 'pointerdown');

  // Guide: every page opens, every picture loads, and every marker has its explanation.
  await page.click('#guide');
  check('guide opens on the workflows', await page.locator('.flow').count() >= 6);
  const pages = await page.locator('.guide-nav .btn').count();
  let pictures = 0, broken = 0, unexplained = 0;
  for (let i = 1; i < pages - 1; i++) {
    await page.locator('.guide-nav .btn').nth(i).click();
    await page.waitForSelector('.shot img');
    const ok = await page.evaluate(async () => { const im = document.querySelector('.shot img'); await im.decode().catch(() => {}); return im.naturalWidth > 100; });
    ok ? pictures++ : broken++;
    if (await page.locator('.shot .mark').count() !== await page.locator('.mark-list li').count()) unexplained++;
  }
  check('every guide picture loads', pictures === pages - 2 && broken === 0, `${pictures} pictures`);
  check('every numbered marker has an explanation', unexplained === 0);
  await page.click('#guide-fx');
  await page.locator('.shot .mark').nth(13).click();
  check('tapping a marker highlights its explanation', (await page.locator('.mark-list li.hot').innerText()).includes('Resample'));
  if (shots) await page.screenshot({ path: `${shots}/guide.png` });
  await page.click('#guide-shortcuts');
  check('keyboard page lists the shortcuts', await page.locator('.keys tr').count() >= 6);
  await page.click('#guide-close');

  // Library: sounds and projects kept outside the project.
  await page.click('#library');
  await page.waitForSelector('.lib-empty');
  check('library starts empty with an explanation', (await page.locator('.lib-empty').innerText()).includes('Nothing saved yet'));
  await page.click('#lib-save-loop');
  await page.waitForSelector('.lib-row');
  check('the current loop saves as a sound', (await page.locator('.lib-name').first().innerText()).startsWith('Loop 2 bar') && (await page.locator('.lib-row .meta').first().innerText()).includes('4.8 s'));
  await page.click('#lib-close');
  await page.click('#save-sample');
  await page.waitForSelector('.toast:has-text("saved to the library")');
  await page.click('.tab:has-text("Pad")');
  await page.click('#save-pad');
  await page.waitForSelector('.toast:has-text("saved to the library as")');
  await page.click('.tab:has-text("Steps")');
  await page.click('#library');
  await page.waitForSelector('.lib-row'); // the list loads from storage after the sheet opens
  check('sample and pad saves appear in the library', await page.locator('.lib-row').count() === 3);
  await page.fill('#lib-search', 'one-shot');
  check('search filters by tag', await page.locator('.lib-row').count() === 1);
  await page.fill('#lib-search', '');
  await page.click('.lib-row >> nth=0 >> text=Rename / tag');
  await page.fill('.lib-edit input[name="name"]', 'My kick');
  await page.fill('.lib-edit input[name="tags"]', 'Kick, favourite');
  await page.click('.lib-edit >> text=Save');
  await page.waitForSelector('.lib-name:has-text("My kick")');
  check('rename and tags are kept', (await page.locator('.lib-row:has-text("My kick") .meta').innerText()).includes('kick, favourite'));
  // Put a library sound on an empty pad in bank D.
  await page.click('#lib-close');
  await page.click('#bank-3');
  await page.dispatchEvent('#pad-5', 'pointerdown');
  await page.click('#library');
  await page.click('.lib-row:has-text("My kick") >> text=To pad D6');
  await page.waitForSelector('.toast:has-text("is on pad D6")');
  await page.click('#lib-close');
  check('a library sound lands on the chosen pad', await page.locator('#pad-5.loaded').count() === 1);
  await page.click('#undo');
  check('one undo takes it off again', await page.locator('#pad-5.loaded').count() === 0);
  await page.click('#bank-0');
  await page.dispatchEvent('#pad-0', 'pointerdown');
  // Projects: save, change, reopen.
  await page.click('#library');
  await page.click('#lib-tab-projects');
  await page.fill('#proj-name', 'First beat');
  await page.click('#proj-save');
  await page.waitForSelector('.lib-row:has-text("First beat")');
  await page.click('#lib-close');
  await page.fill('#bpm', '140');
  await page.click('#library');
  await page.click('#lib-tab-projects');
  await page.click('.lib-row:has-text("First beat") >> text=Open');
  await page.click('.lib-row:has-text("First beat") >> text=Tap again to replace the screen');
  await page.waitForSelector('.toast:has-text("Opened")');
  check('opening a saved project restores it', (await page.inputValue('#bpm')) === '100' && await page.locator('.pad.loaded').count() === 16 && await page.locator('.sheet').count() === 0);
  await page.click('#library');
  await page.click('.lib-row:has-text("Loop 2 bar") >> text=Delete');
  await page.click('.lib-row:has-text("Loop 2 bar") >> text=Tap again to delete');
  await page.waitForFunction(() => document.querySelectorAll('.lib-row').length === 2);
  check('delete needs two taps and removes the sound', true);
  if (shots) await page.screenshot({ path: `${shots}/library.png` });
  await page.click('#lib-close');

  // Pad banks: a later bank is empty until slices are sent to it, and both banks play in the export.
  check('20 slices spilled four pads into bank B', await (async () => { await page.click('#bank-1'); return (await page.locator('.pad.loaded').count()) === 4; })());
  await page.click('#bank-2');
  check('bank C starts empty', await page.locator('.pad.loaded').count() === 0);
  await page.click('#topads');
  check('send to pads fills the bank on screen', await page.locator('.pad.loaded').count() > 0 && (await page.locator('#pad-0').innerText()) === 'C1');
  await page.click('#undo');
  check('undo empties bank C again', await page.locator('.pad.loaded').count() === 0);
  await page.click('#bank-0');

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

  // Assistant, with Anthropic's API replaced by a scripted reply: one tool call, then a sentence.
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
  const end = (reason) => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 9 } }, { type: 'message_stop' }];
  const pattern = { patterns: [{ pad: 'A9', steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.4, 0] }] };
  const bodies = [];
  let mode = 'ok';
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (mode === '401') return route.fulfill({ status: 401, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    bodies.push({ json: req.postDataJSON(), headers: req.headers() });
    const body = bodies.length === 1
      ? sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_patterns', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(pattern) } },
          { type: 'content_block_stop', index: 0 }, ...end('tool_use')])
      : sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Four on the floor on pad 9.' } },
          { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body });
  });
  await page.click('#assistant');
  await page.fill('#api-key', 'sk-ant-test-key');
  await page.click('#save-key');
  // Typing in the assistant box must not play pads or toggle the transport.
  await page.click('#chat-input');
  await page.keyboard.type('a z 1 q');
  check('typing in the assistant box reaches the box', await page.inputValue('#chat-input') === 'a z 1 q');
  check('typing in the assistant box does not start playback', (await page.locator('.pos').innerText()).includes('–'));
  await page.fill('#chat-input', 'four on the floor on pad 9');
  await page.click('#chat-send');
  await page.waitForSelector('.msg.assistant:has-text("Four on the floor")');
  check('assistant reply is shown', true);
  check('assistant change is logged', await page.locator('.change:has-text("Wrote patterns for pad A9")').count() === 1);
  check('request used the expected model, tools and cached system prompt',
    bodies[0].json.model === 'claude-opus-5-5' && bodies[0].json.tools.length >= 6 && bodies[0].json.system[0].cache_control?.type === 'ephemeral' && bodies[0].json.stream === true);
  if (process.env.DEBUG_HEADERS) console.log(Object.keys(bodies[0].headers).join(' '));
  check('request carried the key and browser-access header', (bodies[0].headers['x-api-key'] === 'sk-ant-test-key' || (bodies[0].headers['authorization'] ?? '').includes('sk-ant-test-key')) && bodies[0].headers['anthropic-dangerous-direct-browser-access'] === 'true');
  const second = bodies[1].json.messages;
  check('tool result was sent back in one user message', second.length === 3 && second[2].role === 'user' && second[2].content[0].type === 'tool_result' && second[2].content[0].tool_use_id === 'toolu_1' && !second[2].content[0].is_error);
  await page.dispatchEvent('#pad-8', 'pointerdown');
  await page.click('.tab:has-text("Steps")');
  check('assistant pattern is in the sequencer', await page.locator('.step.on').count() === 4 && await page.locator('.step.soft').count() === 1);
  await page.click('text=Undo these changes');
  check('one tap undoes the assistant turn', await page.locator('.step.on').count() === 0);
  mode = '401';
  await page.fill('#chat-input', 'again');
  await page.click('#chat-send');
  await page.waitForSelector('.msg.error');
  check('a rejected key gives a clear message', (await page.locator('.msg.error').innerText()).includes('rejected the API key'));
  if (shots) await page.screenshot({ path: `${shots}/assistant.png` });
  await page.click('#chat-close');

  if (shots) await page.screenshot({ path: `${shots}/landscape.png` });

  // Autosave: reload and the imported sample is still there.
  await page.waitForTimeout(700);
  await page.reload();
  await page.click('#start');
  await page.waitForSelector('.pads');
  check('project survives a reload', await page.locator('#sample option:has-text("my-test-tone")').count() === 1);
  await page.click('#library');
  await page.waitForSelector('.lib-row');
  check('the library survives a reload', await page.locator('.lib-row').count() === 2 && await page.locator('.lib-name:has-text("My kick")').count() === 1);
  await page.click('#lib-close');

  await page.setViewportSize({ width: 800, height: 1280 });
  await page.waitForTimeout(200);
  check('portrait has no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (shots) await page.screenshot({ path: `${shots}/portrait.png`, fullPage: true });
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(200);
  check('phone width has no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (shots) await page.screenshot({ path: `${shots}/phone.png`, fullPage: true });

  // The single-file artifact build, opened the way the Claude app opens it: with a `window.claude` runtime.
  // The runtime here is a stand-in that plays Claude's part: it calls one page tool, then writes a sentence.
  if (fs.existsSync('artifact/sticky-studio.html')) {
    const apage = await ctx.newPage();
    apage.on('pageerror', (e) => errors.push('artifact: ' + String(e)));
    const fragment = fs.readFileSync('artifact/sticky-studio.html', 'utf8');
    await apage.route('http://localhost:4317/artifact-test.html', (r) => r.fulfill({ contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${fragment}</body></html>` }));
    await apage.addInitScript(() => {
      window.__saved = []; window.__asked = [];
      const sample = async (input, opts) => {
        window.__asked.push(input);
        const tool = opts.tools.find((t) => t.name === 'write_patterns');
        let bad = '';
        try { await tool.execute({ patterns: [{ pad: 'Z9', steps: [] }] }); } catch (e) { bad = String(e.message); }
        window.__badInput = bad;
        await tool.execute({ patterns: [{ pad: 'A4', steps: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0] }] });
        opts.onText({ text: 'Kick pattern on pad 4.', delta: 'Kick pattern on pad 4.' });
        return { text: 'Kick pattern on pad 4.', truncated: false };
      };
      window.claude = { use: async (name) => (name === 'sample' ? sample : name === 'downloads'
        ? { save: async (r) => { window.__saved.push({ filename: r.filename, bytes: Array.from(new Uint8Array(await r.data.arrayBuffer())) }); return { status: 'saved' }; } } : null) };
    });
    await apage.goto('http://localhost:4317/artifact-test.html');
    await apage.click('#start');
    await apage.waitForSelector('.pads');
    check('artifact build boots with the demo on the pads', await apage.locator('.pad.loaded').count() === 16);
    await apage.click('#assistant');
    await apage.waitForSelector('#chat-input');
    check('artifact assistant needs no API key', await apage.locator('#api-key').count() === 0);
    await apage.fill('#chat-input', 'kick on pad 4');
    await apage.click('#chat-send');
    await apage.waitForSelector('.msg.assistant:has-text("Kick pattern on pad 4")');
    check('artifact assistant writes into the studio', await apage.locator('.change:has-text("Wrote patterns for pad A4")').count() === 1);
    check('bad tool input is reported back to Claude, not applied', (await apage.evaluate(() => window.__badInput)).includes('pad name like'));
    const asked = await apage.evaluate(() => window.__asked[0]);
    check('artifact request starts with the instructions and ends with the message', asked.length === 2 && asked[0].content.includes('Sticky Studio') && asked[1].content === 'kick on pad 4');
    await apage.click('text=Undo these changes');
    await apage.click('#chat-close');
    await apage.click('#export');
    await apage.waitForFunction(() => window.__saved.length === 1);
    const saved = await apage.evaluate(() => window.__saved[0]);
    fs.writeFileSync('/tmp/sticky-export-test.zip', Buffer.from(saved.bytes));
    check('artifact export hands a zip to the host', saved.filename.endsWith('.zip') && saved.bytes[0] === 0x50 && saved.bytes[1] === 0x4b, saved.filename);
    if (shots) await apage.screenshot({ path: `${shots}/artifact.png` });
    await apage.close();
  }

  check('no console errors', errors.filter((e) => !e.includes('Unable to decode') && !e.includes('401')).length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
