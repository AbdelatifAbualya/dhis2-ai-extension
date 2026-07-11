'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../background/core.js');

test('provider URL helpers reject unsafe schemes and normalize endpoints', () => {
  assert.equal(core.isValidProviderUrl('https://api.openai.com/v1'), true);
  assert.equal(core.isValidProviderUrl('javascript:alert(1)'), false);
  assert.equal(core.isValidProviderUrl('file:///tmp/model'), false);
  assert.equal(core.isLocalProviderUrl('http://localhost:11434/v1'), true);
  assert.equal(core.isLocalProviderUrl('https://models.internal.local/v1'), true);
  assert.equal(core.isLocalProviderUrl('https://api.openai.com/v1'), false);
  assert.equal(
    core.getChatCompletionsUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    core.getChatCompletionsUrl('https://generativelanguage.googleapis.com'),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );
  assert.equal(
    core.getChatCompletionsUrl('https://example.test/chat/completions'),
    'https://example.test/chat/completions'
  );
});

test('header sanitization strips control and Unicode characters and applies its cap', () => {
  assert.equal(core.sanitizeHeaderValue('  sk-test\u200B\r\n  '), 'sk-test');
  assert.equal(core.sanitizeHeaderValue('\u200B'), null);
  assert.equal(core.sanitizeHeaderValue('x'.repeat(5000)).length, 4096);
});

test('plain and search normalization have intentionally different semantics', () => {
  assert.equal(core.normalizePlainText('Sub-Unit'), 'sub-unit');
  assert.equal(core.normalizeSearchText('Sub-Unit'), 'sub unit');
});

test('free-text UID detection rejects English words and scans past them', () => {
  assert.equal(core.hasUidShape('Respiratory'), true);
  assert.equal(core.isLikelyDhisUid('Respiratory'), false);
  assert.equal(core.isLikelyDhisUid('XGcG2PFIvOU'), true);
  assert.equal(
    core.extractDhis2IdFromText(
      'Respiratory is a label; the visualization is XGcG2PFIvOU',
      'visualizations',
      ['id', 'visualization']
    ),
    'XGcG2PFIvOU'
  );
});

test('resource parsing trusts structural URL IDs but never scans unrelated URLs', () => {
  assert.equal(
    core.extractDhis2IdFromInput(
      'https://play.example.org/apps/maps#/voX07ulo2Bq',
      'maps',
      ['id', 'map']
    ),
    'voX07ulo2Bq'
  );
  assert.equal(
    core.extractDhis2IdFromInput(
      'https://play.example.org/api/visualizations/XGcG2PFIvOU.json',
      'visualizations',
      ['id', 'visualization']
    ),
    'XGcG2PFIvOU'
  );
  assert.equal(
    core.extractDhis2IdFromInput(
      'https://example.test/path/AbcDefGhijk/details',
      'maps',
      ['id', 'map']
    ),
    null
  );
  assert.equal(
    core.extractDhis2IdFromText(
      'See https://example.test/path/AbcDefGhijk then use voX07ulo2Bq',
      'maps',
      ['id', 'map']
    ),
    'voX07ulo2Bq'
  );
  assert.equal(
    core.extractDhis2IdFromText(
      'Open [the map](https://play.example.org/apps/maps#/voX07ulo2Bq).',
      'maps',
      ['id', 'map']
    ),
    'voX07ulo2Bq'
  );
  assert.doesNotThrow(() => core.extractDhis2IdFromInput(
    'https://play.example.org/api/maps/%E0%A4%A',
    'maps',
    ['id', 'map']
  ));
});

test('stableStringify makes logical call signatures key-order independent', () => {
  assert.equal(
    core.stableStringify({ z: 1, nested: { b: 2, a: 3 } }),
    core.stableStringify({ nested: { a: 3, b: 2 }, z: 1 })
  );
  assert.notEqual(core.stableStringify({ a: 1 }), core.stableStringify({ a: 2 }));
});

test('context identity includes datasets and organisation units', () => {
  assert.equal(
    core.contextIdentityChanged(
      { appType: 'Data Entry', datasetId: 'Abc12345678' },
      { appType: 'Data Entry', datasetId: 'Def12345678' }
    ),
    true
  );
  assert.equal(
    core.contextIdentityChanged(
      { appType: 'Capture', programId: 'Abc12345678', stageId: 'One12345678' },
      { appType: 'Capture', programId: 'Abc12345678', stageId: 'Two12345678' }
    ),
    false
  );
});
