#!/usr/bin/env node
/**
 * build-standalone.mjs -- fold the whole calculator into one HTML file.
 *
 * The result opens straight off a hard drive or an email attachment: no
 * server, no build step, no network. Handy for sending to someone who just
 * wants to use the thing.
 *
 *   node build-standalone.mjs [out.html]
 *   node build-standalone.mjs --artifact [out.html]
 *
 * --artifact emits the same page as a fragment (title, fonts, styles, body
 * content) for hosts that supply their own document skeleton.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

/** Names a module exports, so the wrapper can hand them back. */
function exportedNames(src) {
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) names.push(m[1]);
  return names;
}

/** Wrap a module as an IIFE returning its exports, with imports pre-bound. */
function wrapModule(src, varName, preamble = '') {
  const names = exportedNames(src);
  const body = src
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  return `const ${varName} = (() => {\n${preamble}\n${body}\nreturn { ${names.join(', ')} };\n})();\n`;
}

const math = read('./spring-math.js');
const catalog = read('./catalog.js');
const app = read('./app.js');

// catalog.js pulls a fixed set of names out of spring-math.js.
const catImports = catalog.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/spring-math\.js['"]/);
const bound = catImports[1].split(',').map((x) => x.trim()).filter(Boolean).join(', ');

const bundle = [
  wrapModule(math, 'sm'),
  wrapModule(catalog, 'cat', `const { ${bound} } = sm;`),
  app.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, ''),
].join('\n');

const example = JSON.parse(read('./data/example-catalogue.json'));
// The shared catalogue is fetched on the hosted site; a one-file build has
// nothing to fetch from, so it travels inside the page.
const shared = JSON.parse(read('./data/catalogue.json'));

let html = read('./index.html');
html = html.replace(
  '<script type="module" src="./app.js"></script>',
  `<script>window.EXAMPLE_CATALOGUE = ${JSON.stringify(example)};\n`
  + `window.SHARED_CATALOGUE = ${JSON.stringify(shared)};</script>\n`
  + `<script type="module">\n${bundle}\n</script>`,
);
// Nothing to fetch, so the "serve it over HTTP" advice no longer applies.
html = html.replace(
  'Engine, tests and a command-line version:',
  'This is the standalone build &mdash; one file, works offline. Engine, tests and a command-line version:',
);

const args = process.argv.slice(2);
const artifact = args.includes('--artifact');
if (artifact) {
  // Host supplies <!doctype>/<html>/<head>/<body>; hand back only our content,
  // title first so a host that scans the head of the file still finds it.
  const head = html.slice(html.indexOf('<title>'), html.indexOf('</style>') + 8);
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  html = `${head}\n${body}`;
}
const fallback = artifact ? './artifact.html' : './standalone.html';
const out = args.find((a) => !a.startsWith('--')) || new URL(fallback, import.meta.url).pathname;
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} kB)`);
