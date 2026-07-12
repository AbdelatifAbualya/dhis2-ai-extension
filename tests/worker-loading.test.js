'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    hasListener(listener) { return listeners.includes(listener); },
  };
}

function createChromeStub() {
  const events = {
    actionClicked: createEvent(),
    permissionsAdded: createEvent(),
    permissionsRemoved: createEvent(),
    runtimeInstalled: createEvent(),
    runtimeMessage: createEvent(),
    runtimeStartup: createEvent(),
    storageChanged: createEvent(),
    tabActivated: createEvent(),
    tabUpdated: createEvent(),
    windowFocused: createEvent(),
    fragmentUpdated: createEvent(),
  };
  const storageArea = {
    async get() { return {}; },
    async set() {},
    async remove() {},
  };

  return {
    events,
    chrome: {
      action: {
        onClicked: events.actionClicked,
      },
      permissions: {
        async contains() { return false; },
        async getAll() { return { origins: [] }; },
        onAdded: events.permissionsAdded,
        onRemoved: events.permissionsRemoved,
      },
      runtime: {
        id: 'worker-loading-test',
        getURL(relativePath) { return 'chrome-extension://worker-loading-test/' + relativePath; },
        onInstalled: events.runtimeInstalled,
        onMessage: events.runtimeMessage,
        onStartup: events.runtimeStartup,
        async sendMessage() {},
      },
      scripting: {
        async executeScript() { return []; },
        async getRegisteredContentScripts() { return []; },
        async registerContentScripts() {},
        async unregisterContentScripts() {},
      },
      sidePanel: {
        async open() {},
        async setOptions() {},
      },
      storage: {
        local: storageArea,
        session: storageArea,
        onChanged: events.storageChanged,
      },
      tabs: {
        async get() { return null; },
        async query() { return []; },
        onActivated: events.tabActivated,
        onUpdated: events.tabUpdated,
      },
      webNavigation: {
        onReferenceFragmentUpdated: events.fragmentUpdated,
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: events.windowFocused,
      },
    },
  };
}

test('split classic-script worker loads with all cross-module bindings intact', async () => {
  const { chrome, events } = createChromeStub();
  let fetchCalls = 0;
  const sandbox = {
    AbortController,
    AbortSignal,
    Blob,
    DOMException,
    FormData,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    chrome,
    clearInterval,
    clearTimeout,
    console: {
      debug() {},
      error() {},
      info() {},
      log() {},
      warn() {},
    },
    crypto: globalThis.crypto,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('Worker initialization must not fetch network resources');
    },
    performance,
    queueMicrotask,
    setInterval,
    setTimeout,
    structuredClone,
  };
  const context = vm.createContext(sandbox);
  context.importScripts = (...relativePaths) => {
    for (const relativePath of relativePaths) {
      const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
      vm.runInContext(source, context, { filename: relativePath });
    }
  };

  const entrySource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInContext(entrySource, context, { filename: 'background.js' });
  await Promise.resolve();
  await Promise.resolve();

  const runtimeShape = vm.runInContext(
    '({' +
      'toolCount: TOOLS.length,' +
      'routerCount: Object.keys(TOOL_ROUTER).length,' +
      'context: typeof extractContext,' +
      'prompt: typeof buildSystemPrompt,' +
      'provider: typeof callProviderStreaming,' +
      'dispatch: typeof executeTool,' +
      'metadata: typeof executeManageDatasets,' +
      'programs: typeof executeManageProgramRules,' +
      'agent: typeof runAgenticLoop' +
    '})',
    context
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(runtimeShape)),
    {
      toolCount: 32,
      routerCount: 32,
      context: 'function',
      prompt: 'function',
      provider: 'function',
      dispatch: 'function',
      metadata: 'function',
      programs: 'function',
      agent: 'function',
    }
  );
  assert.equal(events.runtimeMessage.listeners.length, 1);
  assert.equal(fetchCalls, 0);
});
