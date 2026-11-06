// Fails the build if a script contains characters Chrome rejects in content scripts.
import { readFileSync } from 'node:fs';
const s = readFileSync(new URL('../dist/content.js', import.meta.url), 'utf-8');
const bad = [...s].filter((c) => { const n = c.codePointAt(0); return n === 0xfffe || n === 0xffff || (n < 32 && !'\n\r\t'.includes(c)); });
if (bad.length) { console.error('dist/content.js contains invalid characters:', bad.map((c) => c.codePointAt(0).toString(16))); process.exit(1); }
console.log('dist/content.js: encoding OK');
