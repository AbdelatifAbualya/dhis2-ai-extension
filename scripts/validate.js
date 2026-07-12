'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const importedScripts = [...backgroundSource.matchAll(/importScripts\(([^)]+)\)/g)]
  .flatMap(call => [...call[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]));
assert.ok(importedScripts.length > 0, 'background.js must load its coarse-grained modules');

const javascriptFiles = [...new Set([
  'background.js',
  ...importedScripts,
  'content.js',
  'sidepanel/panel.js',
])];

for (const relativePath of javascriptFiles) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), 'Missing JavaScript entry: ' + relativePath);
  const result = spawnSync(process.execPath, ['--check', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    relativePath + ' failed syntax validation:\n' + (result.stderr || result.stdout)
  );
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3, 'manifest.json must remain Manifest V3');
assert.ok(
  fs.existsSync(path.join(root, manifest.background.service_worker)),
  'Manifest service worker does not exist'
);

const panelPath = path.join(root, manifest.side_panel.default_path);
const panelHtml = fs.readFileSync(panelPath, 'utf8');
for (const match of panelHtml.matchAll(/<script\s+src="([^"]+)"/g)) {
  assert.ok(
    fs.existsSync(path.resolve(path.dirname(panelPath), match[1])),
    'Missing side-panel script: ' + match[1]
  );
}

console.log('Validated ' + javascriptFiles.length + ' JavaScript files, manifest.json, and extension entry points.');
