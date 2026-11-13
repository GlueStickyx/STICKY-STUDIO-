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
  const rmsR = (from, to) => { let sum = 0, n = 0; for (let f = Math.floor(from * rate); f < to * rate && 44 + f * 4 + 3 < buf.length; f++) { const v = buf.readInt16LE(44 + f * 4 + 2) / 32768; sum += v * v; n++; } return Math.sqrt(sum / Math.max(1, n)); };
  return { bytes: buf.length, peak, rate, channels: buf.readUInt16LE(22), rms, rmsR };
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
  check('a tab exists for every tool', await page.locator('.modules .mod').count() === 9 && await page.locator('.mod .soon').count() === 3);
  await page.click('#mod-stems');
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
  // Arrange: lay the two clips out as a song and export it.
  await page.click('#mod-arrange');
  const lane = (t) => page.locator(`.tl-track[data-track="${t}"]`);
  await lane(0).click({ position: { x: 48 * 0 + 10, y: 20 } }); // Clip 1 (2 bars) at bar 1
  check('tapping the timeline places the chosen clip', await page.locator('.tl-block').count() === 1);
  await page.click('#arr-more');
  check('repeat doubles the block', (await page.locator('.arr-sel .meta').first().innerText()).includes('bars 1–4'));
  await page.locator('.brush').nth(1).click();
  await lane(3).click({ position: { x: 48 * 4 + 10, y: 20 } }); // Clip 2 lives on track 2; tapping any row places it there at bar 5
  check('a clip always lands on its own track', await lane(1).locator('.tl-block').count() === 1 && await page.locator('.tl-block').count() === 2);
  await lane(1).click({ position: { x: 48 * 6 + 10, y: 20 } });
  await page.locator('.brush').nth(0).click();
  await lane(0).click({ position: { x: 48 * 2 + 10, y: 60 } }).catch(() => {});
  check('song length follows the last block', (await page.locator('.arrange .group.end .meta').innerText()).startsWith('8 bars'), await page.locator('.arrange .group.end .meta').innerText());
  const [songDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-song')]);
  const song = await wavStats(songDl);
  const secs = (song.bytes - 44) / 4 / song.rate;
  // 8 bars at 100 BPM = 19.2 s, plus a 3 s tail. Bars 1-4 hold clip 1 (the starter beat); bars 5-6 clip 2; bars 7-8 clip 2 again.
  check('exported song is the right length', Math.abs(secs - 22.2) < 0.05, `${secs.toFixed(2)} s`);
  check('the song has sound in its blocks and silence in the tail', song.rms(0, 9.6) > 0.02 && song.rms(9.6, 19.2) > 0.001 && song.rms(21, 22.2) < 0.0005, `${song.rms(0, 9.6).toFixed(4)} / ${song.rms(9.6, 19.2).toFixed(4)} / ${song.rms(21, 22.2).toFixed(5)}`);
  check('the two halves differ, because different clips play', Math.abs(song.rms(0, 9.6) - song.rms(9.6, 19.2)) > 0.005);
  await page.click('#play');
  await page.waitForFunction(() => /\d+\.\d/.test(document.querySelector('.pos').textContent), null, { timeout: 3000 });
  check('play runs the song', true);
  await page.click('#play');
  if (shots) await page.screenshot({ path: `${shots}/arrange.png` });
  await page.click('#mod-clips');
  await page.click('[aria-label^="Options for Clip 1"]');
  await page.click('text=Edit in Sampler');
  check('edit in Sampler returns to the pads with the clip loaded', await page.locator('.pad.loaded').count() === 16 && await page.locator('.clips').count() === 0);
  for (let i = 0; i < 8; i++) await page.click('#undo'); // clip load, three placements (the overlapping one was refused), one repeat, two saves, one step: back to where this block began
  await page.dispatchEvent('#pad-0', 'pointerdown');

  // Mixer: it shapes the exported audio. Bank A holds the starter beat.
  const mixBase = await exportStats();
  await page.click('#mod-mixer');
  await page.click('#mix-mute-0');
  check('muting bank A silences the loop export', (await exportStats()).peak === 0);
  await page.click('#mix-mute-0');
  await page.click('#mix-solo-1');
  check('soloing an empty bank silences everything else', (await exportStats()).peak === 0);
  await page.click('#mix-solo-1');
  await page.fill('#pan-0', '-1');
  const left = await exportStats();
  check('panning hard left empties the right channel', left.rmsR(0, 4.8) < left.rms(0, 4.8) * 0.05, `L ${left.rms(0, 4.8).toFixed(4)} R ${left.rmsR(0, 4.8).toFixed(5)}`);
  await page.fill('#pan-0', '0');
  await page.fill('#eq-high-0', '-12');
  await page.fill('#eq-mid-0', '-12');
  await page.fill('#eq-low-0', '-12');
  check('cutting all EQ bands makes it quieter', (await exportStats()).rms(0, 4.8) < mixBase.rms(0, 4.8) * 0.5);
  await page.click('#mix-reset');
  check('reset brings the sound back', Math.abs((await exportStats()).rms(0, 4.8) - mixBase.rms(0, 4.8)) < 0.002);
  await page.click('#play');
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelectorAll('.meter')[0]).getPropertyValue('--level')) > 0.05, null, { timeout: 4000 });
  check('meters move while the loop plays', true);
  if (shots) await page.screenshot({ path: `${shots}/mixer.png` });
  await page.click('#play');
  await page.click('#mod-studio');

  // Analyze: a 16-second test song (120 BPM kick + hats, a sung-like line from 6 to 10 s).
  const asr = 22050, alen = asr * 16, apcm = Buffer.alloc(44 + alen * 2);
  apcm.write('RIFF', 0); apcm.writeUInt32LE(36 + alen * 2, 4); apcm.write('WAVEfmt ', 8); apcm.writeUInt32LE(16, 16); apcm.writeUInt16LE(1, 20);
  apcm.writeUInt16LE(1, 22); apcm.writeUInt32LE(asr, 24); apcm.writeUInt32LE(asr * 2, 28); apcm.writeUInt16LE(2, 32); apcm.writeUInt16LE(16, 34);
  apcm.write('data', 36); apcm.writeUInt32LE(alen * 2, 40);
  let aseed = 9; const arnd = () => { aseed = (aseed * 16807) % 2147483647; return (aseed / 2147483647) * 2 - 1; };
  const asig = new Float32Array(alen);
  for (let b = 0; b < 32; b++) {
    for (let i = 0; i < asr * 0.2; i++) asig[b * asr / 2 + i] += Math.sin(2 * Math.PI * 55 * i / asr) * Math.exp(-14 * i / asr) * 0.7;
    const h = Math.floor((b * 0.5 + 0.25) * asr); for (let i = 0; i < asr * 0.04; i++) if (h + i < alen) asig[h + i] += arnd() * Math.exp(-90 * i / asr) * 0.25;
  }
  let aph = 0; for (let i = 6 * asr; i < 10 * asr; i++) { aph += 2 * Math.PI * 220 * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * i / asr)) / asr; asig[i] += (Math.sin(aph) + 0.5 * Math.sin(2 * aph)) * 0.3; }
  for (let i = 0; i < alen; i++) apcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(asig[i] * 32767))), 44 + i * 2);
  await page.click('#mod-analyze');
  await page.setInputFiles('#an-file', { name: 'test-song.wav', mimeType: 'audio/wav', buffer: apcm });
  await page.waitForSelector('#an-sample option:has-text("test-song")', { state: 'attached' });
  await page.click('#an-run');
  await page.waitForSelector('.an-col', { timeout: 15000 });
  const cols = await page.locator('.an-col').allInnerTexts();
  check('analysis finds loops, hits and the sung line', /Loops \(([1-9]\d*)\)/.test(cols[0]) && /Hits \(([1-9]\d*)\)/.test(cols[1]) && /0:0[5-7]/.test(cols[2]), cols.map((c) => c.split('\n')[0]).join(' | '));
  check('the tempo is offered', (await page.locator('.analyze .chopbar').first().innerText()).includes('Use 120'));
  await page.selectOption('#an-bank', '2');
  await page.click('#an-send');
  await page.waitForSelector('.toast:has-text("on pads C1")');
  await page.click('#mod-studio');
  await page.click('#bank-2');
  check('ticked suggestions land on bank C', await page.locator('.pad.loaded').count() >= 8);
  await page.click('#undo');
  check('one undo takes them off again', await page.locator('.pad.loaded').count() === 0);
  await page.click('#bank-0');
  await page.dispatchEvent('#pad-0', 'pointerdown');
  await page.click('#mod-analyze');
  if (shots) await page.screenshot({ path: `${shots}/analyze.png` });
  await page.click('#mod-studio');
  await page.selectOption('#sample', { label: 'Demo loop' }); // back to the sample the later checks expect

  // Suno on the web build: the builder works without a connection and says where generating works.
  await page.click('#mod-suno');
  await page.click('.pillar:has(#pillar-era) .chip >> nth=0');
  await page.fill('#pillar-tempo', '124 BPM');
  check('the style is built from the seven parts', (await page.locator('.suno-style').innerText()) === 'late-90s UK garage, 124 BPM');
  await page.click('#suno-lyrics');
  await page.click('.chip.tag:has-text("[Chorus]")');
  check('section tags go on their own line', (await page.inputValue('#suno-lyrics')) === '[Chorus]\n');
  check('without the connector it explains where generating works', (await page.locator('.suno-side').innerText()).includes('opened in Claude'));
  await page.click('#mod-studio');

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
      window.__calls = [];
      const songs = { s1: { id: 's1', title: 'Night bus', status: 'queued' }, s2: { id: 's2', title: 'Night bus', status: 'queued' } };
      const mcp = { callTool: async (server, tool, input) => {
        window.__calls.push([server, tool, input]);
        if (tool === 'account-usage') return { payload: { allowed_models: ['v6', 'v6-wild'], suno_account: { credits_remaining: 1234 } } };
        if (tool === 'library-list' || tool === 'library-search') return { payload: { items: [{ id: 'lib1', title: 'Example song', status: 'complete', song_url: 'https://suno.com/song/lib1', metadata: { style: 'dusty boom bap, vinyl crackle', duration: 125 } }], next_cursor: null } };
        if (tool === 'audio-create') return { payload: [songs.s1, songs.s2] };
        if (tool === 'audio-retrieve') return { payload: { ...songs[input.id], status: 'complete' } };
        if (tool === 'audio-download') return input.confirm ? { payload: { url: 'https://cdn.example/file.wav' } } : { payload: { status: 'requires_credit' } };
        throw { code: 'tool_error', message: 'unexpected' };
      } };
      window.claude = { use: async (name) => (name === 'mcp' ? mcp : name === 'sample' ? sample : name === 'downloads'
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
    // Suno through the connector.
    await apage.click('#mod-suno');
    await apage.waitForSelector('#suno-generate');
    check('Suno page shows credits and the plan models', (await apage.locator('.suno-side').innerText()).includes('1,234 credits') && await apage.locator('#suno-model option').count() === 3);
    await apage.waitForSelector('.song:has-text("Example song")');
    await apage.click('.song:has-text("Example song") >> text=Use its style');
    check('a library song\'s style can be reused', (await apage.inputValue('#style-text')) === 'dusty boom bap, vinyl crackle');
    await apage.fill('#suno-title', 'Night bus');
    await apage.fill('#suno-weirdness', '0.3');
    await apage.click('#suno-generate');
    check('generate asks before spending credits', (await apage.locator('.confirm').innerText()).includes('spends Suno credits') && !(await apage.evaluate(() => window.__calls.some((c) => c[1] === 'audio-create'))));
    await apage.click('#suno-confirm');
    await apage.waitForSelector('.song:has-text("Night bus")');
    const create = await apage.evaluate(() => window.__calls.find((c) => c[1] === 'audio-create')[2]);
    check('generate sends the style, title and only the sliders that were set', create.style === 'dusty boom bap, vinyl crackle' && create.title === 'Night bus' && create.controls?.weirdness === 0.3 && !('variety' in (create.controls ?? {})) && create.instrumental === false, JSON.stringify(create));
    await apage.waitForSelector('.song:has-text("Night bus") >> text=Open in Suno', { timeout: 10000 });
    check('the queue updates when the songs finish', await apage.locator('.song:has-text("Night bus")').count() === 2);
    await apage.locator('.song:has-text("Night bus") >> text=Get WAV').first().click();
    await apage.waitForSelector('text=Uses 1 download credit.');
    check('a download credit is only spent after the user agrees', !(await apage.evaluate(() => window.__calls.some((c) => c[1] === 'audio-download' && c[2].confirm))));
    await apage.click('text=Use credit');
    await apage.waitForSelector('a:has-text("Download WAV")');
    if (shots) await apage.screenshot({ path: `${shots}/suno.png` });
    await apage.click('#mod-studio');
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
