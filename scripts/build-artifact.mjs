// Builds the studio as one self-contained HTML fragment for publishing as a Claude artifact:
// everything inline, no document skeleton (the publisher adds it).
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

const out = process.argv[2] ?? 'artifact/sticky-studio.html';
const result = await build({
  configFile: false, base: './', plugins: [react()], logLevel: 'warn',
  build: { write: false, target: 'es2021', cssCodeSplit: false, assetsInlineLimit: 100_000_000, // guide pictures travel inside the one file
    rollupOptions: { output: { inlineDynamicImports: true } } },
});
const files = (Array.isArray(result) ? result[0] : result).output;
const js = files.filter((f) => f.type === 'chunk').map((f) => f.code).join('\n');
const css = files.filter((f) => f.type === 'asset' && f.fileName.endsWith('.css')).map((f) => f.source).join('\n');
if (!js || !css) throw new Error('build produced no script or stylesheet');
// A literal U+FFFD inside bundled library strings is written as its escape, so the file stays clean text.
const html = `<title>Sticky Studio</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js.replace(/<\/script/gi, '<\\/script').replace(/\uFFFD/g, '\\uFFFD')}</script>
`;
fs.mkdirSync(out.replace(/\/[^/]*$/, ''), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024).toFixed(0)} kB`);
