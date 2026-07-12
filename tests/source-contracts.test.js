'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const background = read('background.js');
const backgroundModulePaths = [
  'background/context.js',
  'background/tool-definitions.js',
  'background/providers.js',
  'background/tools-read.js',
  'background/tools-metadata.js',
  'background/tools-programs.js',
];
const worker = [background, ...backgroundModulePaths.map(read)].join('\n');
const panel = read('sidepanel/panel.js');
const panelHtml = read('sidepanel/panel.html');
const manifest = JSON.parse(read('manifest.json'));
const packageJson = JSON.parse(read('package.json'));
const toolCatalog = require('../shared/tool-catalog.js');

test('callable tool schemas are unique and all have shared presentation metadata', () => {
  const names = [...worker.matchAll(/function:\s*\{\s*name:\s*'([^']+)'/g)].map(match => match[1]);
  assert.equal(names.length, 32, 'Unexpected callable tool count');
  assert.equal(new Set(names).size, names.length, 'Duplicate callable tool schema');

  const catalogNames = Object.keys(toolCatalog).filter(name => name !== 'diagnose_save_error').sort();
  assert.deepEqual(catalogNames, [...names].sort());
});

test('background top-level function declarations cannot silently override each other', () => {
  const names = [...worker.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
  const unused = names.filter(name => (worker.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length === 1);
  assert.deepEqual(unused, [], 'Unused top-level background functions are dead code');
});

test('simple JavaScript declarations are not left unread', () => {
  for (const [file, source] of [
    ['background worker', worker],
    ['content.js', read('content.js')],
    ['sidepanel/panel.js', panel],
  ]) {
    const declarations = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
      .map(match => match[1]);
    const unused = [...new Set(declarations)].filter(name =>
      (source.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length === 1
    );
    assert.deepEqual(unused, [], file + ' has unread simple declarations');
  }
});

test('removed Inspect scaffolding and obsolete tool-result message cannot return', () => {
  assert.equal(/inspectSnapshot|inspectCapture|inspectMode/.test(worker), false);
  assert.equal(worker.includes("type: 'AI_TOOL_RESULT'"), false);
});

test('the side panel centralizes shared tool metadata and runtime messages', () => {
  assert.match(panelHtml, /shared\/tool-catalog\.js/);
  assert.match(panel, /Dhis2ToolCatalog/);
  assert.equal((panel.match(/document\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((panel.match(/chrome\.runtime\.onMessage\.addListener/g) || []).length, 1);
});

test('only the current tab in the last-focused window can drive global context', () => {
  assert.match(worker, /lastFocusedWindow:\s*true/);
  assert.match(worker, /await isCurrentActiveTab\(tabId\)/);
  assert.match(worker, /pageContextSyncQueue\.then/);
});

test('background worker stays within coarse module boundaries', () => {
  const imports = [...background.matchAll(/importScripts\(([^)]+)\)/g)]
    .flatMap(call => [...call[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]));
  assert.deepEqual(imports, [
    'background/core.js',
    'shared/tool-catalog.js',
    ...backgroundModulePaths,
  ]);
  assert.ok(background.split('\n').length < 5000, 'background.js orchestration shell grew too large');
  for (const modulePath of backgroundModulePaths) {
    assert.ok(read(modulePath).split('\n').length < 8000, modulePath + ' grew beyond a coarse module');
  }
});

test('conversation reset identity is captured before asynchronous turn work', () => {
  const start = background.indexOf('async function _runAgenticLoopInner');
  const end = background.indexOf('// ── Image Cropping', start);
  const loop = background.slice(start, end);
  assert.ok(loop.indexOf('const turnEpoch = conversationEpoch') < loop.indexOf('await buildSystemPrompt'));
  assert.ok((loop.match(/turnWasReset\(\)/g) || []).length >= 10);
  assert.match(loop, /priorConversationHistory = conversationHistory\.slice\(\)/);
});

test('manifest and package versions remain aligned', () => {
  assert.equal(manifest.version, packageJson.version);
});
