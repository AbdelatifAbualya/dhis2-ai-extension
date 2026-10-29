#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * build-runtime-kit.js — DEV-ONLY. Rebuilds the prebuilt files that
 * manage_custom_app packs into every AI-built DHIS2 app / plugin.
 *
 * The extension itself has NO build step: it ships the COMMITTED output of this
 * script and never runs npm. Run this only when bumping a pinned version below:
 *
 *   node scripts/build-runtime-kit.js                 # temp dir, cleaned up after
 *   node scripts/build-runtime-kit.js --work-dir DIR  # reuse an install in DIR
 *
 * Output (commit all of it):
 *   libs/d2-kit/d2-kit.min.js    React 18 + @dhis2/ui + @dhis2/app-runtime +
 *                                post-robot as ONE IIFE exposing the globals
 *                                React, ReactDOMClient, D2UI, D2Runtime, postRobot
 *   libs/d2-kit/d2-kit.css       Roboto @font-face (latin + latin-ext, 400/500/700),
 *                                base body styles with an Arabic-capable system-font
 *                                fallback, and the @dhis2/ui design tokens as CSS
 *                                variables (--colors-*, --spacers-*, --elevations-*)
 *   libs/d2-kit/fonts/*.woff2    the font files d2-kit.css references
 *   libs/d2-kit/KIT_VERSION.json pinned versions, build date, file hashes, and the
 *                                exact export lists of D2UI / D2Runtime (the tool
 *                                rejects generated code that destructures a name
 *                                the kit does not export — it would be undefined
 *                                at runtime and crash React with no useful error)
 *   libs/sucrase.min.js          Sucrase as a worker/browser IIFE (self.sucrase)
 *   libs/fflate.min.js           fflate UMD (self.fflate)
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KIT_DIR = path.join(ROOT, 'libs', 'd2-kit');
const LIBS = path.join(ROOT, 'libs');

// Bump KIT_VERSION whenever the kit output changes. Installed apps record the
// kit version they were packaged with (src/manifest.ai.json → kit_version).
const KIT_VERSION = '1.0.0';
// Exact pins. Prefer releases that have been public for a few weeks.
const PINNED = {
  react: '18.3.1',
  'react-dom': '18.3.1',
  '@dhis2/ui': '10.18.0',
  '@dhis2/app-runtime': '3.17.4',
  '@dhis2/d2-i18n': '1.2.0',
  'styled-jsx': '4.0.1',
  'post-robot': '10.0.46', // the version @dhis2/app-service-plugin uses — host and plugin must speak the same protocol
  sucrase: '3.35.1',
  fflate: '0.8.3',
  esbuild: '0.28.2',
  '@fontsource/roboto': '5.3.0',
};
const FONT_WEIGHTS = [400, 500, 700];
// Unicode ranges from @fontsource/roboto's own CSS for these two subsets.
const FONT_SUBSETS = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const log = (m) => console.log(`[build-runtime-kit] ${m}`);

function install(dir) {
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'd2-kit-build', private: true }, null, 2));
  const specs = Object.entries(PINNED).map(([n, v]) => `${n}@${v}`);
  log(`npm install ${specs.join(' ')}`);
  // --ignore-scripts: nothing here needs an install script (esbuild ships its
  // platform binary as an optional dependency).
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', ...specs], { cwd: dir, stdio: 'inherit' });
  for (const [n, v] of Object.entries(PINNED)) {
    const got = require(path.join(dir, 'node_modules', n, 'package.json')).version;
    if (got !== v) throw new Error(`${n}: wanted ${v}, installed ${got}`);
  }
}

// esbuild reports the export names of an ESM output in its metafile — a static,
// DOM-free way to learn exactly what D2UI / D2Runtime will expose.
function exportNames(esbuild, dir, spec) {
  const entry = path.join(dir, `__exports_${spec.replace(/\W/g, '_')}.mjs`);
  fs.writeFileSync(entry, `export * from '${spec}';\n`);
  const r = esbuild.buildSync({
    entryPoints: [entry], bundle: true, format: 'esm', write: false, metafile: true,
    outdir: path.join(dir, '__out'), logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  });
  const out = Object.values(r.metafile.outputs).find((o) => o.entryPoint);
  return (out.exports || []).filter((n) => n !== 'default').sort();
}

function cssVariables(dir) {
  // @dhis2/ui-constants references the DOM `Element` class in a prop-type at
  // load time; a stub is enough to read the plain token objects.
  globalThis.Element = globalThis.Element || class Element {};
  const c = require(path.join(dir, 'node_modules', '@dhis2', 'ui-constants'));
  const lines = [];
  for (const [k, v] of Object.entries(c.colors || {})) lines.push(`  --colors-${k}: ${v};`);
  for (const [k, v] of Object.entries(c.spacers || {})) lines.push(`  --spacers-${k}: ${v};`);
  for (const [k, v] of Object.entries(c.elevations || {})) lines.push(`  --elevations-${k}: ${v};`);
  for (const [k, v] of Object.entries(c.theme || {})) if (typeof v === 'string') lines.push(`  --theme-${k}: ${v};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

function buildCss(dir) {
  const fontsOut = path.join(KIT_DIR, 'fonts');
  fs.rmSync(fontsOut, { recursive: true, force: true });
  fs.mkdirSync(fontsOut, { recursive: true });
  const faces = [];
  for (const [subset, range] of Object.entries(FONT_SUBSETS)) {
    for (const w of FONT_WEIGHTS) {
      const file = `roboto-${subset}-${w}-normal.woff2`;
      fs.copyFileSync(path.join(dir, 'node_modules', '@fontsource', 'roboto', 'files', file), path.join(fontsOut, file));
      faces.push(`@font-face {\n  font-family: 'Roboto';\n  font-style: normal;\n  font-display: swap;\n  font-weight: ${w};\n  src: url(fonts/${file}) format('woff2');\n  unicode-range: ${range};\n}`);
    }
  }
  const css = `/* d2-kit.css — base stylesheet for AI-built DHIS2 apps (generated by
   scripts/build-runtime-kit.js, kit ${KIT_VERSION}). The App Platform normally loads
   Roboto; without it @dhis2/ui text falls back to a serif font. Roboto has no
   Arabic glyphs, so Arabic text falls through to the system Arabic fonts. */
${faces.join('\n')}
${cssVariables(dir)}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: Roboto, "Segoe UI", "Noto Sans", "Noto Sans Arabic", "Noto Naskh Arabic", Tahoma, "Geeza Pro", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  color: #212934;
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font-family: inherit; }
#root { min-width: 0; }
/* Plugin pages (plugin.html has body.d2-plugin). The Dashboard app gives an
   item a FIXED size and passes setPluginHeight = null, so a plugin lays itself
   out to fill the iframe: #root is the full iframe height, never wider. */
html, body { height: 100%; }
body.d2-plugin { overflow-x: hidden; }
body.d2-plugin #root { height: 100%; }
`;
  fs.writeFileSync(path.join(KIT_DIR, 'd2-kit.css'), css);
}

function main() {
  const reuse = arg('--work-dir');
  const dir = reuse ? path.resolve(reuse) : fs.mkdtempSync(path.join(os.tmpdir(), 'd2-kit-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(KIT_DIR, { recursive: true });
  try {
    if (!fs.existsSync(path.join(dir, 'node_modules', 'esbuild')) || !reuse) install(dir);
    const esbuild = require(path.join(dir, 'node_modules', 'esbuild'));
    const define = { 'process.env.NODE_ENV': '"production"', global: 'globalThis' };

    // 1. The runtime kit.
    const entry = path.join(dir, 'kit-entry.js');
    fs.writeFileSync(entry, `
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as D2UI from '@dhis2/ui';
import * as D2Runtime from '@dhis2/app-runtime';
import postRobot from 'post-robot';
const g = typeof window !== 'undefined' ? window : self;
g.React = React;
g.ReactDOMClient = ReactDOMClient;
g.D2UI = D2UI;
g.D2Runtime = D2Runtime;
g.postRobot = postRobot;
g.D2_KIT_VERSION = ${JSON.stringify(KIT_VERSION)};
`);
    log('bundling d2-kit.min.js');
    esbuild.buildSync({
      entryPoints: [entry], bundle: true, minify: true, format: 'iife', target: 'es2018',
      platform: 'browser', define, outfile: path.join(KIT_DIR, 'd2-kit.min.js'), logLevel: 'warning',
    });
    buildCss(dir);

    // 2. Sucrase for the service worker (and verify.js) — self.sucrase.transform.
    const sEntry = path.join(dir, 'sucrase-entry.js');
    fs.writeFileSync(sEntry, `export { transform } from 'sucrase';\n`);
    log('bundling sucrase.min.js');
    esbuild.buildSync({
      entryPoints: [sEntry], bundle: true, minify: true, format: 'iife', globalName: 'sucrase',
      target: 'es2018', platform: 'browser', define, outfile: path.join(LIBS, 'sucrase.min.js'), logLevel: 'warning',
      banner: { js: `/* sucrase ${PINNED.sucrase} (MIT) — bundled by scripts/build-runtime-kit.js */` },
    });

    // 3. fflate ships a ready UMD build.
    fs.copyFileSync(path.join(dir, 'node_modules', 'fflate', 'umd', 'index.js'), path.join(LIBS, 'fflate.min.js'));

    // 4. Version + export manifest.
    const files = {};
    const walk = (d, rel = '') => {
      for (const f of fs.readdirSync(d)) {
        const abs = path.join(d, f);
        const r = rel ? `${rel}/${f}` : f;
        if (fs.statSync(abs).isDirectory()) walk(abs, r);
        else if (f !== 'KIT_VERSION.json') files[r] = { bytes: fs.statSync(abs).size, sha256: sha256(fs.readFileSync(abs)) };
      }
    };
    walk(KIT_DIR);
    const versions = {};
    for (const n of ['react', 'react-dom', '@dhis2/ui', '@dhis2/app-runtime', 'post-robot', 'styled-jsx', '@fontsource/roboto', 'sucrase', 'fflate', 'esbuild']) {
      versions[n] = require(path.join(dir, 'node_modules', n, 'package.json')).version;
    }
    const meta = {
      kit_version: KIT_VERSION,
      build_date: new Date().toISOString(),
      versions,
      globals: ['React', 'ReactDOMClient', 'D2UI', 'D2Runtime', 'postRobot'],
      files,
      exports: {
        D2UI: exportNames(esbuild, dir, '@dhis2/ui'),
        D2Runtime: exportNames(esbuild, dir, '@dhis2/app-runtime'),
      },
    };
    fs.writeFileSync(path.join(KIT_DIR, 'KIT_VERSION.json'), JSON.stringify(meta, null, 1) + '\n');
    for (const [f, i] of Object.entries(files)) log(`  libs/d2-kit/${f}  ${(i.bytes / 1024).toFixed(0)} KB`);
    log(`  libs/sucrase.min.js  ${(fs.statSync(path.join(LIBS, 'sucrase.min.js')).size / 1024).toFixed(0)} KB`);
    log(`  libs/fflate.min.js   ${(fs.statSync(path.join(LIBS, 'fflate.min.js')).size / 1024).toFixed(0)} KB`);
    log(`D2UI exports: ${meta.exports.D2UI.length}, D2Runtime exports: ${meta.exports.D2Runtime.length}`);
  } finally {
    if (!reuse) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
