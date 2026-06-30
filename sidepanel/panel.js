/* ══════════════════════════════════════════════════════════════════════════════
   DHIS2 AI Assistant — Side Panel
   Chat UI, ECharts rendering, settings, context display
   ══════════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ── Health Chart Palette ─────────────────────────────────────────────────
  const PALETTE = [
    '#2E86AB','#E8655A','#F2B134','#5B8C5A','#8B5CF6',
    '#E07B53','#3AAFA9','#6C757D','#D4A574','#7FB3D8',
  ];
  const SEMANTIC = {
    threshold_line: '#E74C3C',
    target_line: '#27AE60',
    average_line: '#8E8E93',
  };

  // ── DOM ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const statusBar = $('status-bar');
  const statusText = $('status-text');
  const contextBar = $('context-bar');
  const contextSummary = $('context-summary');
  const welcome = $('welcome');
  const messagesDiv = $('messages');
  const messagesArea = $('messages-area');
  const chatInput = $('chat-input');
  const btnSend = $('btn-send');
  const btnSettings = $('btn-settings');
  const btnClear = $('btn-clear');
  const settingsOverlay = $('settings-overlay');
  const apiKeyInput = $('api-key-input');
  const apiBaseUrlInput = $('api-base-url-input');
  const modelIdInput = $('model-id-input');
  const maxTokensInput = $('max-tokens-input');
  const temperatureInput = $('temperature-input');
  const thinkBlockCheckbox = $('think-block-checkbox');
  const visionModelIdInput = $('vision-model-id-input');
  const visionApiBaseUrlInput = $('vision-api-base-url-input');
  const btnSaveSettings = $('btn-save-settings');
  const btnCloseSettings = $('btn-close-settings');
  const btnToggleKey = $('btn-toggle-key');
  const keyStatus = $('key-status');
  const themeSelect = $('theme-select');
  const btnAttach = $('btn-attach');
  const attachDropdown = $('attach-dropdown');
  const btnUploadImage = $('btn-upload-image');
  const btnTakeScreenshot = $('btn-take-screenshot');
  const btnBrowseWeb = $('btn-browse-web');
  const imageFileInput = $('image-file-input');
  const imagePreview = $('image-preview');
  const imagePreviewImg = $('image-preview-img');
  const btnRemoveImage = $('btn-remove-image');
  const webBrowseIndicator = $('web-browse-indicator');
  const btnClearWebBrowse = $('btn-clear-web-browse');
  const tavilyApiKeyInput = $('tavily-api-key-input');
  const providerSelect = $('provider-select');
  const grantBanner = $('grant-banner');
  const grantBannerOrigin = $('grant-banner-origin');
  const btnGrantAccess = $('btn-grant-access');

  // ── Provider Presets ────────────────────────────────────────────────────
  // `local: true` providers run on your machine (no API key required).
  const PROVIDER_PRESETS = {
    ollama:      { url: 'http://localhost:11434/v1', model: 'llama3.2', keyHint: 'Leave blank — local Ollama needs no key', think: false, local: true },
    fireworks:   { url: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/kimi-k2p5', keyHint: 'fw_...', think: true },
    openai:      { url: 'https://api.openai.com/v1', model: 'gpt-4o', keyHint: 'sk-...', think: false },
    anthropic:   { url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', keyHint: 'sk-ant-...', think: false },
    google:      { url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyHint: 'AIza...', think: false },
    openrouter:  { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4', keyHint: 'sk-or-...', think: false },
    together:    { url: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyHint: '', think: false },
    groq:        { url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyHint: 'gsk_...', think: false },
    custom:      { url: '', model: '', keyHint: '', think: false },
  };

  // Local hostnames that don't require an API key (mirrors background.js).
  function isLocalUrlValue(rawUrl) {
    if (!rawUrl) return false;
    let u;
    try { u = new URL(rawUrl); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local');
  }
  function isLocalProviderSelection(providerType, baseUrl) {
    if (providerType === 'ollama') return true;
    return isLocalUrlValue(baseUrl);
  }

  function applyProviderPreset(providerType, overwriteValues = false) {
    const preset = PROVIDER_PRESETS[providerType];
    if (!preset) return;
    // Update placeholders always
    if (apiBaseUrlInput) apiBaseUrlInput.placeholder = preset.url || 'https://your-provider/v1';
    if (modelIdInput) modelIdInput.placeholder = preset.model || 'model-id';
    if (apiKeyInput) apiKeyInput.placeholder = preset.keyHint || 'API key';
    // Overwrite actual values only when user explicitly changes provider
    if (overwriteValues) {
      if (apiBaseUrlInput) apiBaseUrlInput.value = preset.url;
      if (modelIdInput) modelIdInput.value = preset.model;
      if (thinkBlockCheckbox) thinkBlockCheckbox.checked = preset.think;
    }
    updateApiKeyVisibilityState(providerType);
  }

  // Show/hide the "optional for local providers" badge based on selection.
  function updateApiKeyVisibilityState(providerType) {
    const badge = document.getElementById('api-key-optional-badge');
    if (!badge) return;
    const baseUrl = apiBaseUrlInput?.value || PROVIDER_PRESETS[providerType]?.url || '';
    const isLocal = isLocalProviderSelection(providerType, baseUrl);
    badge.style.display = isLocal ? '' : 'none';
  }

  // ── State ───────────────────────────────────────────────────────────────
  let currentState = null;
  let isSending = false;
  let chartInstances = [];
  let pendingImageBase64 = null; // base64 data URL of attached image
  let pendingWebBrowse = false; // one-shot toggle for next message
  let pendingGrantInfo = null; // { origin, originPattern } awaiting host-permission grant
  const toolTimers = new Map();

  // ── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    setupListeners();
    updateWebBrowseIndicator();
    await loadUiPreferences();
    setStatus('connecting', 'Connecting to DHIS2...');

    // Try to load existing state
    const stored = await chrome.storage.session.get(['dhis2State']);
    if (stored.dhis2State?.connected) {
      updateState(stored.dhis2State);
    }

    // Request fresh initialization (gated behind a per-server host-permission grant)
    connectOrPromptGrant();

    // Load API key status
    chrome.runtime.sendMessage({ type: 'GET_API_KEY' }, (resp) => {
      if (resp?.key) apiKeyInput.value = resp.key;
    });
    chrome.runtime.sendMessage({ type: 'GET_TAVILY_API_KEY' }, (resp) => {
      if (resp?.key && tavilyApiKeyInput) tavilyApiKeyInput.value = resp.key;
    });
    // Load provider configuration
    chrome.runtime.sendMessage({ type: 'GET_PROVIDER_CONFIG' }, (resp) => {
      if (resp?.config) {
        const c = resp.config;
        const providerType = c.providerType || 'ollama';
        if (providerSelect) {
          providerSelect.value = providerType;
          applyProviderPreset(providerType, false);
        }
        if (apiBaseUrlInput) apiBaseUrlInput.value = c.apiBaseUrl || '';
        if (modelIdInput) modelIdInput.value = c.modelId || '';
        if (maxTokensInput) maxTokensInput.value = c.maxTokens || '';
        if (temperatureInput) temperatureInput.value = c.temperature ?? '';
        if (thinkBlockCheckbox) thinkBlockCheckbox.checked = !!c.hasThinkBlock;
        if (visionModelIdInput) visionModelIdInput.value = c.visionModelId || '';
        if (visionApiBaseUrlInput) visionApiBaseUrlInput.value = c.visionApiBaseUrl || '';
        updateApiKeyVisibilityState(providerType);
      }
    });
  }

  // ── Host-permission grant flow ─────────────────────────────────────────────
  // The extension ships with no broad host access. The first time the user opens
  // the panel on a given DHIS2 server we ask Chrome to grant that one origin via
  // its native prompt. Chrome only shows that prompt from a user gesture, so the
  // request fires from the "Allow access" button click — after which the server
  // works silently forever (the grant persists).
  async function getActiveTabInfo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return null;
      const u = new URL(tab.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      // Same DHIS2 URL markers the extension already trusts everywhere else.
      const looksDhis2 = /\/(dhis-web-|apps\/|api\/)/.test(tab.url);
      return { origin: u.origin, originPattern: u.origin + '/*', looksDhis2 };
    } catch { return null; }
  }

  function showGrantBanner(origin) {
    if (grantBannerOrigin) grantBannerOrigin.textContent = origin;
    if (grantBanner) grantBanner.classList.remove('hidden');
  }

  function hideGrantBanner() {
    if (grantBanner) grantBanner.classList.add('hidden');
  }

  function sendInitialize() {
    chrome.runtime.sendMessage({ type: 'INITIALIZE' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus('disconnected', 'Open a DHIS2 page to connect');
        return;
      }
      if (resp?.error) {
        setStatus('disconnected', resp.error);
      } else if (resp?.state) {
        updateState(resp.state);
      }
    });
  }

  async function connectOrPromptGrant() {
    const tabInfo = await getActiveTabInfo();
    if (tabInfo?.looksDhis2) {
      let granted = false;
      try { granted = await chrome.permissions.contains({ origins: [tabInfo.originPattern] }); } catch {}
      if (!granted) {
        pendingGrantInfo = tabInfo;
        showGrantBanner(tabInfo.origin);
        setStatus('disconnected', 'Allow access to this DHIS2 server to connect');
        return;
      }
    }
    hideGrantBanner();
    sendInitialize();
  }

  // ── Listeners ────────────────────────────────────────────────────────────
  function setupListeners() {
    btnSend.addEventListener('click', sendMessage);

    // Grant access to the current DHIS2 server. Must run inside this click
    // handler (no awaits before the request) so the user gesture is preserved
    // for chrome.permissions.request — otherwise Chrome refuses to show the prompt.
    if (btnGrantAccess) {
      btnGrantAccess.addEventListener('click', () => {
        if (!pendingGrantInfo) { connectOrPromptGrant(); return; }
        const origins = [pendingGrantInfo.originPattern];
        chrome.permissions.request({ origins }, (granted) => {
          if (chrome.runtime.lastError || !granted) {
            setStatus('disconnected', 'Access not granted. Click Allow to use the assistant here.');
            return;
          }
          pendingGrantInfo = null;
          hideGrantBanner();
          setStatus('connecting', 'Connecting to DHIS2...');
          // Give the background a moment to register the URL-monitor content
          // script (permissions.onAdded) before re-initializing the connection.
          setTimeout(sendInitialize, 150);
        });
      });
    }
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    chatInput.addEventListener('input', () => {
      btnSend.disabled = !chatInput.value.trim() && !pendingImageBase64 && !pendingWebBrowse;
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    btnSettings.addEventListener('click', () => settingsOverlay.classList.remove('hidden'));
    btnCloseSettings.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
    });
    btnSaveSettings.addEventListener('click', saveSettings);
    if (providerSelect) {
      providerSelect.addEventListener('change', () => applyProviderPreset(providerSelect.value, true));
    }
    if (apiBaseUrlInput) {
      // Hide the "optional" badge if user manually points a non-Ollama provider at a remote URL.
      apiBaseUrlInput.addEventListener('input', () => updateApiKeyVisibilityState(providerSelect?.value || 'ollama'));
    }
    btnToggleKey.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      btnToggleKey.textContent = isPassword ? 'Hide' : 'Show';
    });

    btnClear.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
      messagesDiv.innerHTML = '';
      welcome.classList.remove('hidden');
      chartInstances.forEach(c => { if (c._resizeObserver) c._resizeObserver.disconnect(); c.dispose(); });
      chartInstances = [];
    });

    // ── Conversation download (header button) ──
    const btnDownloadChat = $('btn-download-chat');
    const chatDownloadDropdown = $('chat-download-dropdown');
    if (btnDownloadChat && chatDownloadDropdown) {
      btnDownloadChat.addEventListener('click', (e) => {
        e.stopPropagation();
        chatDownloadDropdown.classList.toggle('hidden');
      });
      document.addEventListener('click', () => chatDownloadDropdown.classList.add('hidden'));
      chatDownloadDropdown.addEventListener('click', (e) => e.stopPropagation());
      chatDownloadDropdown.querySelectorAll('.chat-download-option').forEach(opt => {
        opt.addEventListener('click', () => {
          downloadConversation(opt.dataset.format);
          chatDownloadDropdown.classList.add('hidden');
        });
      });
    }

    // Example prompts
    document.querySelectorAll('.example-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        chatInput.value = btn.dataset.prompt;
        btnSend.disabled = false;
        sendMessage();
      });
    });

    // ── Attach menu (+ button) ──
    btnAttach.addEventListener('click', (e) => {
      e.stopPropagation();
      attachDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', () => attachDropdown.classList.add('hidden'));
    attachDropdown.addEventListener('click', (e) => e.stopPropagation());

    // Upload image option
    btnUploadImage.addEventListener('click', () => {
      attachDropdown.classList.add('hidden');
      imageFileInput.click();
    });

    imageFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) processImageFile(file);
      imageFileInput.value = ''; // reset so same file can be re-selected
    });

    // Take screenshot option
    btnTakeScreenshot.addEventListener('click', () => {
      attachDropdown.classList.add('hidden');
      triggerScreenshotCapture();
    });
    btnBrowseWeb?.addEventListener('click', () => {
      attachDropdown.classList.add('hidden');
      pendingWebBrowse = true;
      updateWebBrowseIndicator();
      btnSend.disabled = !chatInput.value.trim() && !pendingImageBase64 && !pendingWebBrowse;
    });
    btnClearWebBrowse?.addEventListener('click', () => {
      pendingWebBrowse = false;
      updateWebBrowseIndicator();
      btnSend.disabled = !chatInput.value.trim() && !pendingImageBase64;
    });
    // Remove attached image
    btnRemoveImage.addEventListener('click', () => {
      clearPendingImage();
    });

    // Paste image from clipboard
    chatInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) processImageFile(blob);
          return;
        }
      }
    });

    // Listen for screenshot result from background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'SCREENSHOT_RESULT' && msg.dataUrl) {
        setPendingImage(msg.dataUrl);
      }
    });

    // Messages from background
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);
  }

  // ── Streaming state ────────────────────────────────────────────────────
  let streamingBubble = null;      // The DOM element currently being streamed into
  let streamingRawText = '';       // Accumulated raw markdown text during streaming
  let streamingRenderTimer = null; // Debounce timer for re-rendering markdown
  let streamingRafId = null;       // requestAnimationFrame ID for smooth rendering
  let streamingDirty = false;      // Whether new chunks arrived since last render
  let streamingLastHtml = '';      // Last rendered HTML — used for incremental DOM patching

  // Watchdog: if a thinking/streaming indicator stays up for too long with no
  // progress, the background service worker was likely suspended or the fetch
  // hung. Recover the UI so the user isn't stuck staring at "Processing...".
  let progressWatchdog = null;
  const WATCHDOG_MS = 90_000;
  function cancelProgressWatchdog() {
    if (progressWatchdog) { clearTimeout(progressWatchdog); progressWatchdog = null; }
  }
  function startProgressWatchdog() {
    cancelProgressWatchdog();
    progressWatchdog = setTimeout(() => {
      progressWatchdog = null;
      if (!isSending) return;
      removeThinking();
      markAllToolsDone();
      finalizeStream();
      addMessage('error', 'The assistant stopped responding (background worker interrupted or upstream timeout). Any tool calls above that show ✓ did complete — please verify in DHIS2 and try again if needed.');
      isSending = false;
      chatInput.disabled = false;
      chatInput.focus();
    }, WATCHDOG_MS);
  }

  // ── Background Messages ──────────────────────────────────────────────────
  const LIFE_SIGNALS = new Set([
    'AI_THINKING', 'AI_TOOL_CALL', 'AI_TOOL_DONE', 'AI_CHART',
    'AI_STREAM_START', 'AI_STREAM_CHUNK',
  ]);
  function handleBackgroundMessage(msg) {
    // Any signal from the SW proves it's alive — reset the watchdog so a long
    // tool call (e.g. multi-step create_metadata) doesn't fire the "worker
    // interrupted" error just because that step takes >90s on its own.
    if (isSending && LIFE_SIGNALS.has(msg.type)) startProgressWatchdog();
    switch (msg.type) {
      case 'CONTEXT_UPDATED':
        updateState(msg.state);
        break;
      case 'AI_THINKING':
        showThinking(msg.iteration, msg.label);
        break;
      case 'AI_TOOL_CALL':
        showToolCall(msg.tool, msg.args);
        break;
      case 'AI_TOOL_DONE':
        markToolDone(msg.tool, msg.success, msg.summary, msg.apiPath, msg.details);
        break;
      case 'AI_CHART':
        renderChart(msg.spec);
        break;
      case 'AI_STREAM_START':
        handleStreamStart();
        break;
      case 'AI_STREAM_CHUNK':
        handleStreamChunk(msg.text);
        break;
      case 'AI_STREAM_END':
        handleStreamEnd(msg.text);
        break;
      case 'AI_RESPONSE':
        removeThinking();
        markAllToolsDone();
        // If response was already streamed, text is null — just finalize state
        if (!msg.streamed && msg.text) addMessage('assistant', msg.text);
        isSending = false;
        chatInput.disabled = false;
        chatInput.focus();
        break;
      case 'AI_ERROR':
        removeThinking();
        markAllToolsDone();
        finalizeStream();
        addMessage('error', msg.error);
        isSending = false;
        chatInput.disabled = false;
        break;
    }
  }

  // ── Streaming Handlers ──────────────────────────────────────────────────
  function handleStreamStart() {
    removeThinking();
    markAllToolsDone();

    // Create the assistant message bubble for streaming
    const el = document.createElement('div');
    el.className = 'msg msg-assistant';
    el.id = 'streaming-msg';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="var(--primary)"/><path d="M6 16V11M10 16V8M14 16V13M18 16V6" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const content = document.createElement('div');
    content.className = 'msg-content streaming';

    // Start with a cursor inside an empty paragraph
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    content.appendChild(cursor);

    bubble.appendChild(content);

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.appendChild(avatar);
    row.appendChild(bubble);

    el.appendChild(row);
    messagesDiv.appendChild(el);

    streamingBubble = content;
    streamingRawText = '';
    streamingLastHtml = '';
    scrollToBottom();
  }

  function handleStreamChunk(text) {
    if (!streamingBubble || !text) return;
    streamingRawText += text;
    streamingDirty = true;
    // Streaming is making progress — keep the watchdog at bay.
    startProgressWatchdog();

    // Use rAF-based rendering for smooth, jank-free updates synced to display refresh
    if (!streamingRafId) {
      streamingRafId = requestAnimationFrame(renderStreamingFrame);
    }
  }

  /**
   * Incremental DOM patching for streaming.
   * Instead of replacing innerHTML (which destroys and recreates all DOM nodes causing
   * flicker and re-triggering animations), this morphs the existing DOM:
   *   1. Parse new HTML into a temporary element
   *   2. Walk children in parallel — reuse existing nodes, update only what changed
   *   3. Append genuinely new nodes with a fade-in animation
   *   4. Keep the cursor at the end
   */
  function renderStreamingFrame() {
    streamingRafId = null;
    if (!streamingBubble || !streamingDirty) return;
    streamingDirty = false;

    const displayText = cleanStreamingText(streamingRawText);
    const newHtml = renderMarkdown(displayText);

    // Skip if nothing changed
    if (newHtml === streamingLastHtml) return;
    streamingLastHtml = newHtml;

    // Parse new HTML into a document fragment for diffing
    const tmp = document.createElement('div');
    tmp.innerHTML = newHtml;

    // Remove the cursor temporarily so it doesn't interfere with diffing
    const oldCursor = streamingBubble.querySelector('.streaming-cursor');
    if (oldCursor) oldCursor.remove();

    // Morph: walk through children and patch in-place
    patchChildren(streamingBubble, tmp);

    // Re-append cursor at the very end (inside the last text-containing element)
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    const lastBlock = findLastTextNode(streamingBubble);
    if (lastBlock) {
      lastBlock.parentNode.insertBefore(cursor, lastBlock.nextSibling);
    } else {
      streamingBubble.appendChild(cursor);
    }

    scrollToBottom();
  }

  /**
   * Patch the children of `existing` to match `desired`.
   * Reuses DOM nodes where possible to avoid flicker.
   */
  function patchChildren(existing, desired) {
    const oldNodes = Array.from(existing.childNodes);
    const newNodes = Array.from(desired.childNodes);

    let i = 0;
    for (; i < newNodes.length; i++) {
      const newChild = newNodes[i];

      if (i < oldNodes.length) {
        const oldChild = oldNodes[i];

        // Same type — try to reuse
        if (oldChild.nodeType === newChild.nodeType) {
          if (oldChild.nodeType === Node.TEXT_NODE) {
            // Text node — just update content if different
            if (oldChild.textContent !== newChild.textContent) {
              oldChild.textContent = newChild.textContent;
            }
          } else if (oldChild.nodeType === Node.ELEMENT_NODE) {
            // Element node — same tag: patch in-place
            if (oldChild.tagName === newChild.tagName) {
              // For simple inline/leaf elements, update innerHTML if different
              // For block containers (p, li, ul, ol, etc.), recursively patch children
              if (isLeafElement(oldChild) || isLeafElement(newChild)) {
                if (oldChild.innerHTML !== newChild.innerHTML) {
                  oldChild.innerHTML = newChild.innerHTML;
                }
              } else {
                // Copy over attributes (like style for table alignment)
                patchAttributes(oldChild, newChild);
                patchChildren(oldChild, newChild);
              }
            } else {
              // Different tag — replace with the new node (with fade-in)
              const imported = newChild.cloneNode(true);
              imported.classList?.add?.('stream-new');
              existing.replaceChild(imported, oldChild);
            }
          }
        } else {
          // Different node type — replace
          const imported = newChild.cloneNode(true);
          if (imported.nodeType === Node.ELEMENT_NODE) imported.classList?.add?.('stream-new');
          existing.replaceChild(imported, oldChild);
        }
      } else {
        // New node doesn't exist yet — append with animation
        const imported = newChild.cloneNode(true);
        if (imported.nodeType === Node.ELEMENT_NODE) imported.classList?.add?.('stream-new');
        existing.appendChild(imported);
      }
    }

    // Remove excess old nodes (if the new content is shorter — rare during streaming)
    while (existing.childNodes.length > newNodes.length) {
      const last = existing.lastChild;
      // Don't remove the cursor
      if (last && last.classList?.contains?.('streaming-cursor')) break;
      if (last) existing.removeChild(last);
      else break;
    }
  }

  /** Check if an element is a "leaf" — should be updated via innerHTML, not recursed into */
  function isLeafElement(el) {
    const tag = el.tagName;
    return tag === 'CODE' || tag === 'PRE' || tag === 'STRONG' || tag === 'EM' ||
           tag === 'A' || tag === 'SPAN' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'HR';
  }

  /** Sync attributes from `src` to `dest` */
  function patchAttributes(dest, src) {
    // Copy style attribute (used for table cell alignment)
    const srcStyle = src.getAttribute('style');
    const destStyle = dest.getAttribute('style');
    if (srcStyle !== destStyle) {
      if (srcStyle) dest.setAttribute('style', srcStyle);
      else dest.removeAttribute('style');
    }
    // Copy class (but preserve stream-new if present)
    const srcClass = src.getAttribute('class') || '';
    const destClass = (dest.getAttribute('class') || '').replace(/\bstream-new\b/g, '').trim();
    if (srcClass !== destClass) {
      dest.setAttribute('class', srcClass);
    }
  }

  /** Find the last text node in an element (for cursor placement) */
  function findLastTextNode(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let last = null;
    while (walker.nextNode()) last = walker.currentNode;
    return last;
  }

  /** Strip trailing incomplete markdown tokens so users never see raw "##" or "**" mid-stream */
  function cleanStreamingText(text) {
    let cleaned = text.replace(/(^|\n)#{1,4}\s*$/, '$1');
    cleaned = cleaned.replace(/[\*_]{1,3}$/, '');
    cleaned = cleaned.replace(/\[([^\]]*?)$/, '$1');
    cleaned = cleaned.replace(/\]\([^)]*$/, '');
    cleaned = cleaned.replace(/`{1,3}$/, '');
    cleaned = cleaned.replace(/\|[^|\n]*$/, '');
    return cleaned;
  }

  function handleStreamEnd(fullText) {
    if (streamingRafId) {
      cancelAnimationFrame(streamingRafId);
      streamingRafId = null;
    }
    streamingDirty = false;
    // Defensive: if stream ends without a prior STREAM_START (shouldn't happen,
    // but guards against provider edge cases), make sure the thinking indicator
    // doesn't linger.
    removeThinking();

    const finalText = fullText || streamingRawText;
    if (streamingBubble) {
      // Final render — full replace is fine here (single repaint, no flicker)
      streamingBubble.classList.remove('streaming');
      streamingBubble.innerHTML = renderMarkdown(finalText);

      // Add feedback buttons to the streaming message
      const msgEl = document.getElementById('streaming-msg');
      if (msgEl) {
        msgEl.removeAttribute('id');
        const feedbackBar = buildFeedbackBar(finalText, streamingBubble.innerHTML);
        msgEl.appendChild(feedbackBar);
      }
    }

    streamingBubble = null;
    streamingRawText = '';
    streamingLastHtml = '';
    scrollToBottom();
  }

  function finalizeStream() {
    if (streamingRafId) {
      cancelAnimationFrame(streamingRafId);
      streamingRafId = null;
    }
    streamingDirty = false;
    if (streamingBubble) {
      streamingBubble.classList.remove('streaming');
      const cursor = streamingBubble.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
    }
    streamingBubble = null;
    streamingRawText = '';
  }

  // ── Status & Context ─────────────────────────────────────────────────────
  function setStatus(state, text) {
    statusBar.className = `status-bar status-${state}`;
    statusText.textContent = text;
  }

  function updateState(state) {
    currentState = state;
    if (state.connected) {
      const label = state.programName
        ? `Connected: ${state.programName}`
        : `Connected to DHIS2 v${state.version || ''}`;
      setStatus('connected', label);
      updateContextBar(state);
    } else {
      setStatus('disconnected', 'Open a DHIS2 page to connect');
      contextBar.classList.add('hidden');
    }
  }

  function updateContextBar(state) {
    const chips = [];
    if (state.pageContext?.appType) chips.push({ label: 'App', value: state.pageContext.appType });
    if (state.programName) chips.push({ label: 'Program', value: state.programName });
    if (state.datasetName) {
      const peLabel = state.datasetPeriodType ? ` · ${state.datasetPeriodType}` : '';
      chips.push({ label: 'Dataset', value: `${state.datasetName}${peLabel}` });
    }
    if (state.visualizationName) chips.push({ label: 'Viz', value: state.visualizationName });
    if (state.ouName) chips.push({ label: 'OU', value: state.ouName });
    if (state.stagesCount) chips.push({ label: 'Stages', value: state.stagesCount });
    if (state.trackedEntityType) chips.push({ label: 'TE', value: state.trackedEntityType });

    if (chips.length === 0) {
      contextBar.classList.add('hidden');
      return;
    }

    contextSummary.innerHTML = chips.map(c =>
      `<span class="ctx-chip"><span class="ctx-label">${esc(c.label)}</span> ${esc(String(c.value))}</span>`
    ).join('');
    contextBar.classList.remove('hidden');
  }

  function updateWebBrowseIndicator() {
    if (!webBrowseIndicator) return;
    webBrowseIndicator.classList.toggle('hidden', !pendingWebBrowse);
    if (btnBrowseWeb) btnBrowseWeb.classList.toggle('attach-option-active', !!pendingWebBrowse);
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  async function loadUiPreferences() {
    const stored = await chrome.storage.local.get(['uiTheme']);
    applyTheme(stored.uiTheme || 'light');
    if (themeSelect) {
      themeSelect.value = stored.uiTheme || 'light';
      themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
    }
  }

  function applyTheme(theme) {
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');
  }

  function saveSettings() {
    const theme = (themeSelect?.value || 'light') === 'dark' ? 'dark' : 'light';
    chrome.storage.local.set({ uiTheme: theme }).catch(() => {});
    applyTheme(theme);

    const key = apiKeyInput.value.trim();
    const tavilyKey = tavilyApiKeyInput?.value.trim() || '';

    const providerType = providerSelect?.value || 'ollama';
    const baseUrl = apiBaseUrlInput?.value.trim();
    const modelId = modelIdInput?.value.trim();
    const maxTok = maxTokensInput?.value ? parseInt(maxTokensInput.value, 10) : null;
    const temp = temperatureInput?.value !== '' ? parseFloat(temperatureInput.value) : null;
    const hasThink = thinkBlockCheckbox?.checked ?? false;
    const visionModel = visionModelIdInput?.value.trim() || '';
    const visionBase = visionApiBaseUrlInput?.value.trim() || '';

    // Client-side URL validation. Background revalidates and is the source of truth.
    const URL_RE = /^https?:\/\//i;
    if (baseUrl && !URL_RE.test(baseUrl)) {
      showKeyStatus('API Base URL must start with http:// or https://', true);
      return;
    }
    if (visionBase && !URL_RE.test(visionBase)) {
      showKeyStatus('Vision API Base URL must start with http:// or https://', true);
      return;
    }
    // Cloud providers need a key. Local providers don't.
    const isLocal = isLocalProviderSelection(providerType, baseUrl);
    if (!isLocal && !key) {
      showKeyStatus('This provider requires an API key. Paste it above, or pick "Ollama (local)".', true);
      return;
    }

    const tasks = [];

    // Always save the API key field — even if cleared — so users can wipe a stale key
    // when switching to a local provider.
    tasks.push(new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'SAVE_API_KEY', payload: { key } }, (resp) => resolve(resp));
    }));
    if (tavilyKey) {
      tasks.push(new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'SAVE_TAVILY_API_KEY', payload: { key: tavilyKey } }, (resp) => resolve(resp));
      }));
    }

    // Build provider config from form fields
    const providerConfig = {};
    providerConfig.providerType = providerType;
    if (baseUrl) providerConfig.apiBaseUrl = baseUrl;
    if (modelId) providerConfig.modelId = modelId;
    if (maxTok && !isNaN(maxTok) && maxTok >= 256) providerConfig.maxTokens = maxTok;
    if (temp !== null && !isNaN(temp)) providerConfig.temperature = temp;
    providerConfig.hasThinkBlock = hasThink;
    providerConfig.visionModelId = visionModel;
    providerConfig.visionApiBaseUrl = visionBase;
    // Compose a human label from model ID
    providerConfig.modelLabel = modelId || 'Custom Model';

    tasks.push(new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'SAVE_PROVIDER_CONFIG', payload: { config: providerConfig } }, (resp) => resolve(resp));
    }));

    Promise.all(tasks).then((results) => {
      const failed = results.find(r => !r?.success);
      if (failed) {
        showKeyStatus('Failed to save: ' + (failed?.error || 'Unknown error'), true);
        return;
      }
      showKeyStatus('Settings saved', false);
      setTimeout(() => settingsOverlay.classList.add('hidden'), 1000);
    }).catch((e) => {
      showKeyStatus('Failed to save: ' + (e?.message || 'Unknown error'), true);
    });
  }

  function showKeyStatus(text, isError) {
    keyStatus.textContent = text;
    keyStatus.className = `key-status ${isError ? 'key-error' : 'key-saved'}`;
    keyStatus.classList.remove('hidden');
    setTimeout(() => keyStatus.classList.add('hidden'), 3000);
  }

  // ── Chat ─────────────────────────────────────────────────────────────────
  function sendMessage() {
    const text = chatInput.value.trim();
    if ((!text && !pendingImageBase64 && !pendingWebBrowse) || isSending) return;

    welcome.classList.add('hidden');
    const userPreview = text || (pendingImageBase64 ? '(image)' : '(web browse)');
    addMessage('user', userPreview, pendingImageBase64);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    btnSend.disabled = true;
    isSending = true;
    chatInput.disabled = true;

    const payload = { text: text || (pendingWebBrowse ? 'Browse the web and answer my question.' : 'Analyze this image') };
    if (pendingImageBase64) {
      payload.imageBase64 = pendingImageBase64;
    }
    if (pendingWebBrowse) payload.browseWeb = true;
    clearPendingImage();
    pendingWebBrowse = false;
    updateWebBrowseIndicator();

    chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', payload });
  }

  // ── Image Helpers ────────────────────────────────────────────────────────
  function processImageFile(file) {
    if (!file.type.startsWith('image/')) return;
    // Limit to 4MB
    if (file.size > 4 * 1024 * 1024) {
      addMessage('error', 'Image too large (max 4MB). Please use a smaller image.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      // Resize if needed to keep payload manageable
      resizeImage(dataUrl, 1200, (resized) => {
        setPendingImage(resized);
      });
    };
    reader.readAsDataURL(file);
  }

  function resizeImage(dataUrl, maxDim, callback) {
    const img = new Image();
    img.onload = () => {
      if (img.width <= maxDim && img.height <= maxDim) {
        callback(dataUrl);
        return;
      }
      const scale = Math.min(maxDim / img.width, maxDim / img.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = dataUrl;
  }

  function setPendingImage(dataUrl) {
    pendingImageBase64 = dataUrl;
    imagePreviewImg.src = dataUrl;
    imagePreview.classList.remove('hidden');
    btnSend.disabled = false;
  }

  function clearPendingImage() {
    pendingImageBase64 = null;
    imagePreviewImg.src = '';
    imagePreview.classList.add('hidden');
    if (!chatInput.value.trim() && !pendingWebBrowse) btnSend.disabled = true;
  }

  function triggerScreenshotCapture() {
    // Send message to background to initiate screenshot capture on active tab
    chrome.runtime.sendMessage({ type: 'START_SCREENSHOT_CAPTURE' });
  }

  function addMessage(role, content, imageDataUrl) {
    const el = document.createElement('div');
    el.className = `msg msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    // Show image in bubble if present
    if (imageDataUrl && role === 'user') {
      const img = document.createElement('img');
      img.src = imageDataUrl;
      img.className = 'msg-image';
      bubble.appendChild(img);
    }
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.innerHTML = role === 'user' ? esc(content) : renderMarkdown(content);
    bubble.appendChild(contentDiv);

    if (role === 'assistant' || role === 'error') {
      // Assistant messages get an avatar + row layout
      const avatar = document.createElement('div');
      avatar.className = 'msg-avatar';
      if (role === 'error') {
        avatar.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="var(--error)"/><path d="M12 8v4M12 16h.01" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
      } else {
        avatar.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="var(--primary)"/><path d="M6 16V11M10 16V8M14 16V13M18 16V6" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
      }

      const row = document.createElement('div');
      row.className = 'msg-row';
      row.appendChild(avatar);
      row.appendChild(bubble);
      el.appendChild(row);
    } else {
      el.appendChild(bubble);
    }

    // Add feedback buttons for assistant messages
    if (role === 'assistant') {
      const feedbackBar = buildFeedbackBar(content, bubble.innerHTML);
      el.appendChild(feedbackBar);
    }

    messagesDiv.appendChild(el);
    scrollToBottom();
    return el;
  }

  // ── Build feedback bar (shared by addMessage and streaming) ──────────────
  function buildFeedbackBar(answerContent, renderedHtml) {
    const feedbackBar = document.createElement('div');
    feedbackBar.className = 'feedback-bar';
    feedbackBar.innerHTML = `
      <button class="feedback-btn feedback-up" title="Good answer" data-type="thumbs_up">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
        </svg>
      </button>
      <button class="feedback-btn feedback-down" title="Bad answer" data-type="thumbs_down">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
        </svg>
      </button>
      <span class="feedback-separator"></span>
      <div class="download-menu-container">
        <button class="feedback-btn download-btn" title="Download report">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <div class="download-dropdown hidden">
          <button class="download-option" data-format="html">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            HTML Report
          </button>
          <button class="download-option" data-format="word">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13l1.5 4L12 11l2.5 6L16 13"/></svg>
            Word (.doc)
          </button>
          <button class="download-option" data-format="csv">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
            CSV Data
          </button>
          <button class="download-option" data-format="json">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>
            JSON Data
          </button>
          <button class="download-option" data-format="xml">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13l-2 2 2 2"/><path d="M15 13l2 2-2 2"/></svg>
            XML Data
          </button>
        </div>
      </div>
    `;

    feedbackBar.querySelectorAll('.feedback-btn:not(.download-btn)').forEach(btn => {
      btn.addEventListener('click', () => handleFeedbackClick(btn, feedbackBar, answerContent));
    });

    const dlBtn = feedbackBar.querySelector('.download-btn');
    const dlDropdown = feedbackBar.querySelector('.download-dropdown');
    if (dlBtn && dlDropdown) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dlDropdown.classList.toggle('hidden');
      });
      document.addEventListener('click', () => dlDropdown.classList.add('hidden'));
      dlDropdown.addEventListener('click', (e) => e.stopPropagation());

      feedbackBar.querySelectorAll('.download-option').forEach(opt => {
        opt.addEventListener('click', () => {
          dlDropdown.classList.add('hidden');
          downloadReport(opt.dataset.format, answerContent, renderedHtml);
        });
      });
    }

    return feedbackBar;
  }

  function handleFeedbackClick(btn, feedbackBar, answerContent) {
    const feedbackType = btn.dataset.type;

    // Disable buttons immediately
    feedbackBar.querySelectorAll('.feedback-btn').forEach(b => b.disabled = true);

    // Highlight selected
    btn.classList.add('feedback-selected');

    // Show comment input area
    let commentArea = feedbackBar.querySelector('.feedback-comment-area');
    if (!commentArea) {
      commentArea = document.createElement('div');
      commentArea.className = 'feedback-comment-area';
      commentArea.innerHTML = `
        <textarea class="feedback-comment-input" placeholder="Add a comment (optional)..." rows="2"></textarea>
        <div class="feedback-comment-actions">
          <button class="feedback-submit-btn">Submit</button>
          <button class="feedback-skip-btn">Skip</button>
        </div>
      `;
      feedbackBar.appendChild(commentArea);

      const submitFn = (comment) => {
        chrome.runtime.sendMessage({
          type: 'STORE_FEEDBACK',
          payload: {
            type: feedbackType,
            answer: answerContent,
            comment: comment,
          }
        }, (resp) => {
          commentArea.remove();
          const confirmation = document.createElement('span');
          confirmation.className = 'feedback-confirmation';
          confirmation.textContent = feedbackType === 'thumbs_up' ? '\u2713 Thanks!' : '\u2713 Feedback saved';
          feedbackBar.appendChild(confirmation);
          setTimeout(() => { confirmation.style.opacity = '0.5'; }, 2000);
        });
      };

      commentArea.querySelector('.feedback-submit-btn').addEventListener('click', () => {
        const comment = commentArea.querySelector('.feedback-comment-input').value.trim();
        submitFn(comment);
      });

      commentArea.querySelector('.feedback-skip-btn').addEventListener('click', () => {
        submitFn('');
      });

      // Focus the textarea
      setTimeout(() => commentArea.querySelector('.feedback-comment-input').focus(), 50);
      scrollToBottom();
    }
  }

  // ── Report Download ────────────────────────────────────────────────────
  function downloadReport(format, rawMarkdown, renderedHtml) {
    const timestamp = new Date().toLocaleString();
    const contextInfo = currentState || {};
    const filename = `DHIS2_Report_${new Date().toISOString().slice(0, 10)}_${Date.now()}`;

    if (format === 'html') {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DHIS2 Report — ${esc(contextInfo.programName || 'Report')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; line-height: 1.6; padding: 0; background: #fff; }
    .report-header { background: linear-gradient(135deg, #0f172a, #1e293b); color: white; padding: 28px 36px; }
    .report-header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
    .report-header .subtitle { font-size: 13px; opacity: 0.8; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px 36px; background: #f8f9fb; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #64748b; }
    .report-meta .meta-item { display: flex; gap: 4px; }
    .report-meta .meta-label { font-weight: 600; color: #475569; }
    .report-body { padding: 28px 36px; font-size: 14px; }
    .report-body p { margin: 0 0 12px; }
    .report-body h2 { font-size: 17px; font-weight: 700; margin: 20px 0 8px; color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
    .report-body h3 { font-size: 15px; font-weight: 600; margin: 16px 0 6px; color: #334155; }
    .report-body h4 { font-size: 14px; font-weight: 600; margin: 12px 0 4px; }
    .report-body strong { font-weight: 600; }
    .report-body ul, .report-body ol { margin: 4px 0 12px 24px; }
    .report-body li { margin-bottom: 4px; }
    .report-body code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 13px; font-family: monospace; }
    .report-body pre { background: #f8f9fb; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 16px; overflow-x: auto; margin: 8px 0 12px; }
    .report-body pre code { background: none; padding: 0; }
    .report-body hr { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }
    .report-body a { color: #4f46e5; text-decoration: none; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
    th { background: #f1f5f9; padding: 10px 14px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; color: #475569; border-bottom: 2px solid #e2e8f0; }
    td { padding: 9px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:nth-child(even) td { background: #fafbfc; }
    tr:hover td { background: #e0e7ff; }
    .report-footer { padding: 16px 36px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
    @media print {
      .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="report-header">
    <h1>DHIS2 AI Assistant Report</h1>
    <div class="subtitle">${esc(contextInfo.programName || '')}${contextInfo.ouName ? ' — ' + esc(contextInfo.ouName) : ''}</div>
  </div>
  <div class="report-meta">
    <div class="meta-item"><span class="meta-label">Generated:</span> ${esc(timestamp)}</div>
    ${contextInfo.programName ? `<div class="meta-item"><span class="meta-label">Program:</span> ${esc(contextInfo.programName)}</div>` : ''}
    ${contextInfo.ouName ? `<div class="meta-item"><span class="meta-label">Org Unit:</span> ${esc(contextInfo.ouName)}</div>` : ''}
    ${contextInfo.version ? `<div class="meta-item"><span class="meta-label">DHIS2:</span> v${esc(contextInfo.version)}</div>` : ''}
  </div>
  <div class="report-body">
    ${renderedHtml}
  </div>
  <div class="report-footer">
    Generated by DHIS2 AI Assistant &bull; ${esc(timestamp)}
  </div>
</body>
</html>`;

      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.html';
      a.click();
      URL.revokeObjectURL(url);

    } else if (format === 'word') {
      const wordHtml = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(contextInfo.programName || 'DHIS2 Report')}</title></head>
<body>
  <h1>DHIS2 AI Assistant Report</h1>
  <p><strong>Generated:</strong> ${esc(timestamp)}</p>
  ${contextInfo.programName ? `<p><strong>Program:</strong> ${esc(contextInfo.programName)}</p>` : ''}
  ${contextInfo.ouName ? `<p><strong>Org Unit:</strong> ${esc(contextInfo.ouName)}</p>` : ''}
  <hr />
  ${renderedHtml}
</body></html>`;

      const blob = new Blob(['\uFEFF' + wordHtml], { type: 'application/msword;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.doc';
      a.click();
      URL.revokeObjectURL(url);

    } else if (format === 'csv') {
      // Extract tables from rendered HTML and convert to CSV
      const temp = document.createElement('div');
      temp.innerHTML = renderedHtml;
      const tables = temp.querySelectorAll('table');

      if (tables.length === 0) {
        // No tables — export the text content as a simple text file
        const textContent = rawMarkdown || temp.textContent;
        const blob = new Blob([textContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename + '.txt';
        a.click();
        URL.revokeObjectURL(url);
        return;
      }

      let csvParts = [];
      tables.forEach((table, idx) => {
        if (idx > 0) csvParts.push('\n');
        const rows = table.querySelectorAll('tr');
        rows.forEach(row => {
          const cells = [...row.querySelectorAll('th, td')].map(cell => {
            let text = cell.textContent.trim().replace(/"/g, '""');
            return `"${text}"`;
          });
          csvParts.push(cells.join(','));
        });
      });

      const csvText = csvParts.join('\n');
      // UTF-8 BOM for proper Excel encoding
      const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.csv';
      a.click();
      URL.revokeObjectURL(url);

    } else if (format === 'json') {
      // Build structured JSON output
      const jsonOutput = {
        meta: {
          title: 'DHIS2 AI Assistant Report',
          generatedAt: new Date().toISOString(),
          program: contextInfo.programName || null,
          orgUnit: contextInfo.ouName || null,
          dhis2Version: contextInfo.version || null,
        },
        content: {
          markdown: rawMarkdown || '',
          text: '',
          tables: [],
        },
      };

      // Extract plain text and tables from rendered HTML
      const temp = document.createElement('div');
      temp.innerHTML = renderedHtml;
      jsonOutput.content.text = temp.textContent.trim();

      const tables = temp.querySelectorAll('table');
      tables.forEach((table) => {
        const headers = [];
        const rows = [];
        const headerCells = table.querySelectorAll('thead th, tr:first-child th');
        headerCells.forEach(th => headers.push(th.textContent.trim()));

        const dataRows = headers.length > 0
          ? table.querySelectorAll('tbody tr, tr:not(:first-child)')
          : table.querySelectorAll('tr');
        dataRows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length === 0) return;
          if (headers.length > 0) {
            const rowObj = {};
            cells.forEach((td, i) => {
              rowObj[headers[i] || `col_${i}`] = td.textContent.trim();
            });
            rows.push(rowObj);
          } else {
            rows.push([...cells].map(td => td.textContent.trim()));
          }
        });

        jsonOutput.content.tables.push({ headers, rows });
      });

      const jsonStr = JSON.stringify(jsonOutput, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.json';
      a.click();
      URL.revokeObjectURL(url);

    } else if (format === 'xml') {
      const xmlEsc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      // Re-use the same content extraction used for JSON
      const temp = document.createElement('div');
      temp.innerHTML = renderedHtml;
      const plainText = temp.textContent.trim();
      const tables = [];
      temp.querySelectorAll('table').forEach((table) => {
        const headers = [];
        const rows = [];
        table.querySelectorAll('thead th, tr:first-child th').forEach(th => headers.push(th.textContent.trim()));
        const dataRows = headers.length > 0
          ? table.querySelectorAll('tbody tr, tr:not(:first-child)')
          : table.querySelectorAll('tr');
        dataRows.forEach(tr => {
          const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
          if (cells.length) rows.push(cells);
        });
        tables.push({ headers, rows });
      });

      const tableXml = tables.map(t => {
        const headerXml = t.headers.map(h => `      <header>${xmlEsc(h)}</header>`).join('\n');
        const rowXml = t.rows.map(cells => {
          const cellXml = cells.map((c, i) => {
            const colName = t.headers[i] ? ` name="${xmlEsc(t.headers[i])}"` : '';
            return `        <cell${colName}>${xmlEsc(c)}</cell>`;
          }).join('\n');
          return `      <row>\n${cellXml}\n      </row>`;
        }).join('\n');
        return `    <table>\n      <headers>\n${headerXml}\n      </headers>\n      <rows>\n${rowXml}\n      </rows>\n    </table>`;
      }).join('\n');

      const xmlStr = `<?xml version="1.0" encoding="UTF-8"?>
<report>
  <meta>
    <title>DHIS2 AI Assistant Report</title>
    <generatedAt>${xmlEsc(new Date().toISOString())}</generatedAt>
    <program>${xmlEsc(contextInfo.programName || '')}</program>
    <orgUnit>${xmlEsc(contextInfo.ouName || '')}</orgUnit>
    <dhis2Version>${xmlEsc(contextInfo.version || '')}</dhis2Version>
  </meta>
  <content>
    <markdown><![CDATA[${String(rawMarkdown || '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></markdown>
    <text><![CDATA[${plainText.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></text>
${tableXml}
  </content>
</report>`;

      const blob = new Blob([xmlStr], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.xml';
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  // ── Full-conversation download (Word / JSON / XML) ──────────────────────
  function collectConversationTurns() {
    // Walk the messages DOM and extract user / assistant / error turns in order.
    const turns = [];
    const nodes = messagesDiv.querySelectorAll('.msg-user, .msg-assistant, .msg-error');
    nodes.forEach(node => {
      const bubble = node.querySelector('.msg-bubble');
      if (!bubble) return;
      const contentDiv = bubble.querySelector('.msg-content');
      if (!contentDiv) return;
      let role = 'user';
      if (node.classList.contains('msg-assistant')) role = 'assistant';
      else if (node.classList.contains('msg-error')) role = 'error';

      // Clone the content so we can strip cursors/feedback UI without mutating the live DOM.
      const clone = contentDiv.cloneNode(true);
      clone.querySelectorAll('.streaming-cursor, .thinking-dots').forEach(n => n.remove());

      const html = clone.innerHTML.trim();
      const text = clone.textContent.replace(/\s+\n/g, '\n').trim();
      const imgEl = bubble.querySelector('.msg-image');
      const hasImage = !!imgEl;

      if (!text && !hasImage) return;
      turns.push({ role, text, html, hasImage });
    });
    return turns;
  }

  function downloadConversation(format) {
    const turns = collectConversationTurns();
    if (!turns.length) {
      alert('No conversation to export yet.');
      return;
    }

    const timestamp = new Date().toLocaleString();
    const contextInfo = currentState || {};
    const filename = `DHIS2_Conversation_${new Date().toISOString().slice(0, 10)}_${Date.now()}`;

    const roleLabel = r => r === 'assistant' ? 'Assistant' : r === 'error' ? 'Error' : 'User';

    if (format === 'word') {
      const turnHtml = turns.map(t => `
        <div style="margin: 0 0 18px 0; padding: 12px 14px; border-left: 4px solid ${t.role === 'assistant' ? '#4f46e5' : t.role === 'error' ? '#dc2626' : '#64748b'}; background: ${t.role === 'assistant' ? '#f5f7ff' : '#f8f9fb'};">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; margin-bottom: 6px;">${roleLabel(t.role)}${t.hasImage ? ' (image attached)' : ''}</div>
          <div>${t.html}</div>
        </div>`).join('');

      const wordHtml = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>DHIS2 Conversation</title></head>
<body style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1a1a2e;">
  <h1>DHIS2 AI Conversation</h1>
  <p><strong>Generated:</strong> ${esc(timestamp)}</p>
  ${contextInfo.programName ? `<p><strong>Program:</strong> ${esc(contextInfo.programName)}</p>` : ''}
  ${contextInfo.ouName ? `<p><strong>Org Unit:</strong> ${esc(contextInfo.ouName)}</p>` : ''}
  ${contextInfo.version ? `<p><strong>DHIS2 version:</strong> ${esc(contextInfo.version)}</p>` : ''}
  <p><strong>Turns:</strong> ${turns.length}</p>
  <hr />
  ${turnHtml}
</body></html>`;

      const blob = new Blob(['\uFEFF' + wordHtml], { type: 'application/msword;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.doc';
      a.click();
      URL.revokeObjectURL(url);

    } else if (format === 'json') {
      const payload = {
        meta: {
          title: 'DHIS2 AI Conversation',
          generatedAt: new Date().toISOString(),
          program: contextInfo.programName || null,
          orgUnit: contextInfo.ouName || null,
          dhis2Version: contextInfo.version || null,
          turnCount: turns.length,
        },
        turns: turns.map((t, i) => ({
          index: i,
          role: t.role,
          hasImage: t.hasImage,
          text: t.text,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.json';
      a.click();
      URL.revokeObjectURL(url);

    } else if (format === 'xml') {
      const xmlEsc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const cdata = (s) => `<![CDATA[${String(s ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;

      const turnXml = turns.map((t, i) =>
        `    <turn index="${i}" role="${xmlEsc(t.role)}"${t.hasImage ? ' hasImage="true"' : ''}>
      <text>${cdata(t.text)}</text>
    </turn>`
      ).join('\n');

      const xmlStr = `<?xml version="1.0" encoding="UTF-8"?>
<conversation>
  <meta>
    <title>DHIS2 AI Conversation</title>
    <generatedAt>${xmlEsc(new Date().toISOString())}</generatedAt>
    <program>${xmlEsc(contextInfo.programName || '')}</program>
    <orgUnit>${xmlEsc(contextInfo.ouName || '')}</orgUnit>
    <dhis2Version>${xmlEsc(contextInfo.version || '')}</dhis2Version>
    <turnCount>${turns.length}</turnCount>
  </meta>
  <turns>
${turnXml}
  </turns>
</conversation>`;

      const blob = new Blob([xmlStr], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.xml';
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  function showThinking(iteration, label) {
    removeThinking();
    startProgressWatchdog();
    const text = label || (iteration > 1 ? 'Processing' : 'Thinking');
    const el = document.createElement('div');
    el.id = 'thinking';
    el.className = 'thinking';
    el.innerHTML = `
      <div class="thinking-avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="var(--primary)"/><path d="M6 16V11M10 16V8M14 16V13M18 16V6" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div class="thinking-content">
        <div class="thinking-shimmer"></div>
        <span class="thinking-label">${esc(text)}</span>
      </div>
    `;
    messagesDiv.appendChild(el);
    scrollToBottom();
  }

  function removeThinking() {
    const el = $('thinking');
    if (el) el.remove();
    cancelProgressWatchdog();
  }

  function showToolCall(tool, args) {
    removeThinking();
    const el = document.createElement('div');
    el.className = 'tool-card';
    const toolId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    el.dataset.toolId = toolId;
    toolTimers.set(toolId, Date.now());

    const isChart = tool === 'render_chart';
    const iconMap = {
      render_chart: { cls: 'tool-icon-chart', icon: '\u{1F4CA}' },
      count_records: { cls: 'tool-icon-count', icon: '\u{1F522}' },
      get_event_analytics: { cls: 'tool-icon-analytics', icon: '\u{1F4C8}' },
      get_program_info: { cls: 'tool-icon-info', icon: '\u{2139}\uFE0F' },
      get_program_recent_changes: { cls: 'tool-icon-info', icon: '\u{1F4DD}' },
      search_metadata: { cls: 'tool-icon-search', icon: '\u{1F50E}' },
      resolve_option_codes: { cls: 'tool-icon-search', icon: '\u{1F3F7}' },
      detect_enrollment_abnormalities: { cls: 'tool-icon-warning', icon: '\u26A0\uFE0F' },
      cross_stage_entity_intersection: { cls: 'tool-icon-analytics', icon: '\u{1F517}' },
      line_listing_guide: { cls: 'tool-icon-info', icon: '\u{1F5FA}\uFE0F' },
      get_visualization_details: { cls: 'tool-icon-chart', icon: '\u{1F4CA}' },
      get_map_details: { cls: 'tool-icon-map', icon: '\u{1F5FA}\uFE0F' },
      browse_web: { cls: 'tool-icon-search', icon: '\u{1F30D}' },
      dhis2_query: { cls: 'tool-icon-api', icon: '\u{1F50D}' },
      create_metadata: { cls: 'tool-icon-create', icon: '\u{1F3D7}\uFE0F' },
      architect_metadata: { cls: 'tool-icon-architect', icon: '\u{1F9E0}' },
      manage_program_rules: { cls: 'tool-icon-info', icon: '\u{1F4CB}' },
      manage_program_indicators: { cls: 'tool-icon-analytics', icon: '\u{1F4CF}' },
      manage_metadata: { cls: 'tool-icon-create', icon: '\u{1F527}' },
      manage_program_notifications: { cls: 'tool-icon-notification', icon: '\u{1F4E8}' },
      manage_datasets: { cls: 'tool-icon-dataset', icon: '\u{1F4D1}' },
      manage_custom_forms: { cls: 'tool-icon-create', icon: '\u{1F4DD}' },
      manage_custom_translations: { cls: 'tool-icon-create', icon: '\u{1F310}' },
      manage_growth_chart_plugin: { cls: 'tool-icon-create', icon: '\u{1F4C8}' },
      manage_validation_rules: { cls: 'tool-icon-info', icon: '\u{2705}' },
      manage_org_units: { cls: 'tool-icon-create', icon: '\u{1F3E2}' },
      manage_backups: { cls: 'tool-icon-backup', icon: '\u{1F4BE}' },
      diagnose_save_error: { cls: 'tool-icon-warning', icon: '\u{1F50D}' },
    };
    const iconInfo = iconMap[tool] || { cls: 'tool-icon-api', icon: '\u{1F50D}' };

    const toolLabels = {
      render_chart: 'Rendering chart',
      dhis2_query: 'Querying DHIS2 API',
      count_records: 'Counting records',
      get_event_analytics: 'Fetching analytics',
      get_program_info: 'Loading program info',
      get_program_recent_changes: 'Loading recent changes',
      search_metadata: 'Searching metadata',
      resolve_option_codes: 'Resolving codes to names',
      detect_enrollment_abnormalities: 'Scanning abnormalities',
      cross_stage_entity_intersection: 'Intersecting conditions',
      line_listing_guide: 'Loading line-listing guide',
      get_visualization_details: 'Loading visualization details',
      get_map_details: 'Loading map details',
      browse_web: 'Browsing the web',
      create_metadata: 'Creating metadata',
      architect_metadata: 'Architecting metadata',
      manage_program_rules: 'Managing program rules',
      manage_program_indicators: 'Managing program indicators',
      manage_metadata: 'Managing metadata',
      manage_program_notifications: 'Managing program notifications',
      manage_datasets: 'Managing datasets',
      manage_custom_forms: 'Designing custom form',
      manage_custom_translations: 'Managing custom translations',
      manage_growth_chart_plugin: 'Setting up growth chart plugin',
      manage_validation_rules: 'Managing validation rules',
      manage_org_units: 'Managing org units',
      manage_backups: 'Managing backups',
      diagnose_save_error: 'Diagnosing save error',
    };
    const label = toolLabels[tool] || 'Querying DHIS2';

    // Build detailed info showing actual API call
    let detail = '';
    if (isChart) {
      detail = args.title || args.chart_type || '';
    } else if (tool === 'count_records') {
      const parts = [args.record_type || 'records'];
      if (args.stage_id) parts.push(`stage=${args.stage_id.slice(0, 11)}`);
      if (args.filters?.length) parts.push(`${args.filters.length} filter(s)`);
      if (args.date_after || args.date_before) parts.push(`${args.date_after || '...'} to ${args.date_before || '...'}`);
      if (args.include_children) parts.push('+ children');
      detail = parts.join(', ');
    } else if (tool === 'get_event_analytics') {
      const parts = [args.aggregate_type || 'aggregate'];
      if (args.stage_id) parts.push(`stage=${args.stage_id.slice(0, 11)}`);
      if (args.period) parts.push(`pe:${args.period}`);
      if (args.breakdown_dimension) parts.push(`by:${args.breakdown_dimension.slice(0, 25)}`);
      detail = parts.join(', ');
    } else if (tool === 'get_program_info') {
      detail = args.info_type || 'metadata';
      if (args.target_id) detail += ` [${args.target_id.slice(0, 11)}]`;
    } else if (tool === 'search_metadata') {
      detail = args.object_type || '';
      if (args.name_filter) detail += ` "${args.name_filter}"`;
      if (args.id) detail += ` id:${args.id.slice(0, 11)}`;
    } else if (tool === 'dhis2_query') {
      const method = args.method && args.method !== 'GET' ? `${args.method} ` : '';
      detail = method + (args.path || '').slice(0, 120);
    } else if (tool === 'detect_enrollment_abnormalities') {
      const parts = ['enrollments'];
      if (args.status) parts.push(`status=${args.status}`);
      if (args.include_children) parts.push('+ children');
      if (args.date_after || args.date_before) parts.push(`${args.date_after || '...'} to ${args.date_before || '...'}`);
      detail = parts.join(', ');
    } else if (tool === 'line_listing_guide') {
      detail = (args.query || '').slice(0, 120);
      if (args.is_screenshot) detail += ' (screenshot)';
    } else if (tool === 'get_visualization_details') {
      detail = args.visualization_id || 'current visualization';
      if (args.include_analytics_preview) detail += ', +analytics preview';
    } else if (tool === 'get_map_details') {
      detail = args.map_id || 'current map';
      if (args.include_analytics_preview) detail += ', +analytics preview';
    } else if (tool === 'browse_web') {
      const q = (args.query || '').slice(0, 120);
      const n = args.max_results ? `, max=${args.max_results}` : '';
      detail = `query="${q}"${n}`;
    } else if (tool === 'cross_stage_entity_intersection') {
      const allN = Array.isArray(args.all_of) ? args.all_of.length : 0;
      const anyN = Array.isArray(args.any_of) ? args.any_of.length : 0;
      detail = `all_of=${allN}, any_of=${anyN}${args.include_children === false ? ', selected OU' : ', +children'}`;
    } else if (tool === 'create_metadata') {
      const action = args.action || 'unknown';
      let parts = [action];
      if (args.program_name) parts.push(`"${args.program_name}"`);
      if (args.stage_name) parts.push(`stage: "${args.stage_name}"`);
      if (args.stages?.length) parts.push(`${args.stages.length} stage(s)`);
      if (args.data_elements?.length) parts.push(`${args.data_elements.length} DE(s)`);
      if (args.rules?.length) parts.push(`${args.rules.length} rule(s)`);
      if (args.dry_run_only) parts.push('DRY RUN');
      detail = parts.join(', ');
    } else if (tool === 'architect_metadata') {
      const action = args.action || 'unknown';
      let parts = [action];
      if (args.schema_type) parts.push(`schema: ${args.schema_type}`);
      if (args.object_type) parts.push(`type: ${args.object_type}`);
      if (args.name_filter) parts.push(`"${args.name_filter}"`);
      if (args.docs_query) parts.push(`"${(args.docs_query || '').slice(0, 60)}"`);
      if (args.program_id) parts.push(`program: ${args.program_id.slice(0, 11)}`);
      if (args.verify_ids?.length) parts.push(`${args.verify_ids.length} object(s)`);
      if (args.verify_program_id) parts.push(`program: ${args.verify_program_id.slice(0, 11)}`);
      detail = parts.join(', ');
    } else if (tool === 'manage_program_rules') {
      const parts = [args.action || 'list'];
      if (args.program_id) parts.push(`program: ${args.program_id.slice(0, 11)}`);
      if (args.rule_id) parts.push(`rule: ${args.rule_id.slice(0, 11)}`);
      detail = parts.join(', ');
    } else if (tool === 'manage_program_indicators') {
      const parts = [args.action || 'list'];
      if (args.program_id) parts.push(`program: ${args.program_id.slice(0, 11)}`);
      if (args.indicator_id) parts.push(`indicator: ${args.indicator_id.slice(0, 11)}`);
      detail = parts.join(', ');
    } else if (tool === 'manage_metadata') {
      const parts = [args.action || 'unknown'];
      if (args.object_type) parts.push(`type: ${args.object_type}`);
      if (args.object_id) parts.push(`id: ${args.object_id.slice(0, 11)}`);
      if (args.stage_id) parts.push(`stage: ${args.stage_id.slice(0, 11)}`);
      if (args.icon) parts.push(`icon: ${args.icon}`);
      if (args.color) parts.push(`color: ${args.color}`);
      if (args.value_type) parts.push(`→ ${args.value_type}`);
      if (Array.isArray(args.keywords) && args.keywords.length) {
        parts.push(`keywords: ${args.keywords.slice(0, 6).join(', ')}${args.keywords.length > 6 ? '…' : ''}`);
      }
      detail = parts.join(', ');
    } else if (tool === 'manage_program_notifications') {
      const parts = [args.action || 'unknown'];
      if (args.program_id) parts.push(`program: ${args.program_id.slice(0, 11)}`);
      if (args.template_id) parts.push(`template: ${args.template_id.slice(0, 11)}`);
      if (args.trigger) parts.push(`on: ${args.trigger}`);
      if (args.recipient) parts.push(`→ ${args.recipient}`);
      if (args.webhook_url) {
        try { parts.push(`url: ${new URL(args.webhook_url).host}`); } catch { parts.push('webhook'); }
      }
      detail = parts.join(', ');
    } else if (tool === 'manage_datasets') {
      const parts = [args.action || 'unknown'];
      if (args.dataset_id) parts.push(`id: ${args.dataset_id.slice(0, 11)}`);
      if (args.dataset_name) parts.push(`"${String(args.dataset_name).slice(0, 30)}"`);
      if (args.period_type) parts.push(`pe: ${args.period_type}`);
      if (args.form_type) parts.push(`form: ${args.form_type}`);
      if (Array.isArray(args.data_element_ids) && args.data_element_ids.length) {
        parts.push(`${args.data_element_ids.length} DE(s)`);
      }
      if (Array.isArray(args.org_unit_ids) && args.org_unit_ids.length) {
        parts.push(`${args.org_unit_ids.length} OU(s)`);
      }
      if (Array.isArray(args.sections) && args.sections.length) {
        parts.push(`${args.sections.length} section(s)`);
      }
      if (args.merge_mode) parts.push(`merge: ${args.merge_mode}`);
      if (args.public_access) parts.push(`access: ${args.public_access}`);
      if (args.section_id) parts.push(`section: ${args.section_id.slice(0, 11)}`);
      if (args.dry_run_only) parts.push('DRY RUN');
      detail = parts.join(', ');
    } else if (tool === 'manage_custom_forms') {
      const parts = [args.action || 'unknown'];
      if (args.dataset_id || args.object_id) parts.push(`dataset: ${String(args.dataset_id || args.object_id).slice(0, 11)}`);
      if (args.program_stage_id || args.stage_id) parts.push(`stage: ${String(args.program_stage_id || args.stage_id).slice(0, 11)}`);
      if (args.html_code) parts.push('custom html');
      else if (args.action && args.action.startsWith('set')) parts.push('auto-generated');
      if (args.style) parts.push(`style: ${args.style}`);
      if (args.new_form_type) parts.push(`revert: ${args.new_form_type}`);
      detail = parts.join(', ');
    } else if (tool === 'manage_custom_translations') {
      const parts = [args.action || 'unknown'];
      if (args.app) parts.push(`app: ${args.app}`);
      if (args.locale) parts.push(`locale: ${args.locale}`);
      if (args.translations && typeof args.translations === 'object') parts.push(`${Object.keys(args.translations).length} string(s)`);
      if (args.replace) parts.push('replace');
      if (Array.isArray(args.keys)) parts.push(`${args.keys.length} key(s)`);
      detail = parts.join(', ');
    } else if (tool === 'manage_growth_chart_plugin') {
      const parts = [args.action || 'status'];
      if (args.program_id) parts.push(`program: ${String(args.program_id).slice(0, 11)}`);
      if (args.program_stage_id) parts.push(`stage: ${String(args.program_stage_id).slice(0, 11)}`);
      if (args.org_unit_id) parts.push(`ou: ${String(args.org_unit_id).slice(0, 11)}`);
      detail = parts.join(', ');
    } else if (tool === 'manage_validation_rules') {
      const parts = [args.action || 'unknown'];
      if (args.rule_id) parts.push(`id: ${String(args.rule_id).slice(0, 11)}`);
      if (args.rule && typeof args.rule === 'object') {
        if (args.rule.name) parts.push(`"${String(args.rule.name).slice(0, 30)}"`);
        if (args.rule.operator) parts.push(`op: ${args.rule.operator}`);
        if (args.rule.importance) parts.push(args.rule.importance);
      }
      if (args.name_filter) parts.push(`name~${String(args.name_filter).slice(0, 20)}`);
      if (args.importance && !(args.rule && args.rule.importance)) parts.push(args.importance);
      if (args.period_type) parts.push(`pe: ${args.period_type}`);
      if (args.dry_run_only) parts.push('DRY RUN');
      detail = parts.join(', ');
    } else if (tool === 'manage_org_units') {
      const parts = [args.action || 'unknown'];
      if (args.org_unit_id) parts.push(`id: ${String(args.org_unit_id).slice(0, 11)}`);
      if (args.org_unit && typeof args.org_unit === 'object') {
        if (args.org_unit.name) parts.push(`"${String(args.org_unit.name).slice(0, 30)}"`);
        if (args.org_unit.parent_id) parts.push(`parent: ${String(args.org_unit.parent_id).slice(0, 11)}`);
      }
      if (args.parent_id && !(args.org_unit && args.org_unit.parent_id)) parts.push(`parent: ${String(args.parent_id).slice(0, 11)}`);
      if (args.name_filter) parts.push(`name~${String(args.name_filter).slice(0, 20)}`);
      if (args.level != null) parts.push(`level: ${args.level}`);
      if (args.dry_run_only) parts.push('DRY RUN');
      detail = parts.join(', ');
    } else if (tool === 'manage_backups') {
      const parts = [args.action || 'list'];
      if (args.backup_key) parts.push(`key: ${String(args.backup_key).slice(0, 24)}…`);
      if (args.operation) parts.push(`op: ${args.operation}`);
      if (args.limit) parts.push(`limit: ${args.limit}`);
      if (args.retention_days) parts.push(`keep: ${args.retention_days}d`);
      detail = parts.join(', ');
    } else if (tool === 'get_program_recent_changes') {
      const parts = [];
      if (args.program_id) parts.push(`program: ${args.program_id.slice(0, 11)}`);
      if (args.days) parts.push(`last ${args.days} days`);
      detail = parts.join(', ') || 'current program';
    } else if (args.path) {
      detail = args.path;
    } else {
      detail = JSON.stringify(args).slice(0, 150);
    }

    el.innerHTML = `
      <div class="tool-icon ${iconInfo.cls}">${iconInfo.icon}</div>
      <div class="tool-info">
        <div class="tool-head">
          <div class="tool-name">${esc(label)}</div>
          <span class="tool-state">Running</span>
        </div>
        <div class="tool-detail">${esc(detail)}</div>
      </div>
      <div class="tool-spinner"></div>
    `;
    messagesDiv.appendChild(el);
    scrollToBottom();
  }

  function markToolDone(tool, success, summary, apiPath, details) {
    const cards = messagesDiv.querySelectorAll('.tool-card:not(.tool-done)');
    const card = cards[cards.length - 1];
    if (!card) return;
    card.classList.add('tool-done');
    const toolId = card.dataset.toolId;
    const startedAt = toolId ? toolTimers.get(toolId) : null;
    const elapsedMs = startedAt ? (Date.now() - startedAt) : null;
    if (toolId) toolTimers.delete(toolId);
    const spinner = card.querySelector('.tool-spinner');
    if (spinner) {
      spinner.classList.add('hidden');
      const check = document.createElement('div');
      check.className = success ? 'tool-check' : 'tool-fail';
      check.textContent = success ? '\u2713' : '\u2717';
      spinner.parentNode.insertBefore(check, spinner);
    }
    if (summary) {
      const detail = card.querySelector('.tool-detail');
      if (detail) detail.textContent += ` | ${summary}`;
    }
    // Show actual API path if available
    if (apiPath && tool !== 'browse_web') {
      const detail = card.querySelector('.tool-detail');
      if (detail) detail.textContent = apiPath;
    } else if (apiPath && tool === 'browse_web') {
      const detail = card.querySelector('.tool-detail');
      if (detail) detail.textContent += ` | source=${apiPath}`;
    }
    const state = card.querySelector('.tool-state');
    if (state) {
      const statusText = success ? 'Done' : 'Failed';
      const timeText = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      state.textContent = statusText + timeText;
      state.classList.toggle('tool-state-fail', !success);
    }

    // \u2500\u2500 Failure-detail panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // On a failed tool call, append a collapsible block under the card with the
    // full error sentence + structured hint/scope/origin/refused/history. The
    // user no longer has to wonder "what actually failed?" \u2014 every field that
    // background.js produced is shown verbatim. Keeps successful runs compact.
    if (!success && details && typeof details === 'object') {
      const block = document.createElement('details');
      block.className = 'tool-failure-details';
      const fields = [];
      if (details.error)        fields.push(['Error', String(details.error)]);
      if (details.scope)        fields.push(['Scope', String(details.scope)]);
      if (details.hint)         fields.push(['Hint', String(details.hint)]);
      if (details.originServer) fields.push(['Server', String(details.originServer)]);
      if (details.existingId)   fields.push(['Existing ID', String(details.existingId)]);
      if (details.httpStatus)   fields.push(['HTTP', String(details.httpStatus)]);
      if (details.status)       fields.push(['Import status', String(details.status)]);
      if (details.refused)      fields.push(['Refused', JSON.stringify(details.refused, null, 2)]);
      if (details.unresolved && details.unresolved.length) {
        fields.push(['Unresolved', JSON.stringify(details.unresolved, null, 2)]);
      }
      if (details.rawErrors && details.rawErrors.length) {
        fields.push(['Server errors', JSON.stringify(details.rawErrors, null, 2)]);
      }
      if (details.history && details.history.length) {
        fields.push(['History', JSON.stringify(details.history, null, 2)]);
      }
      if (!fields.length) return;

      const summaryEl = document.createElement('summary');
      summaryEl.textContent = 'Why it failed (full detail)';
      block.appendChild(summaryEl);

      for (const [label, value] of fields) {
        const row = document.createElement('div');
        row.className = 'tool-failure-row';
        const k = document.createElement('div');
        k.className = 'tool-failure-key';
        k.textContent = label;
        const v = document.createElement('div');
        v.className = 'tool-failure-value';
        v.textContent = value;
        row.appendChild(k);
        row.appendChild(v);
        block.appendChild(row);
      }
      card.appendChild(block);
    }
  }

  function markAllToolsDone() {
    messagesDiv.querySelectorAll('.tool-card:not(.tool-done)').forEach(card => {
      card.classList.add('tool-done');
      const spinner = card.querySelector('.tool-spinner');
      if (spinner) {
        spinner.classList.add('hidden');
        const check = document.createElement('div');
        check.className = 'tool-check';
        check.textContent = '\u2713';
        spinner.parentNode.insertBefore(check, spinner);
      }
      const state = card.querySelector('.tool-state');
      if (state) state.textContent = 'Done';
    });
  }

  // ── Chart Rendering ──────────────────────────────────────────────────────
  function renderChart(spec) {
    if (!spec || !spec.series || spec.series.length === 0) return;
    const normalizedSpec = normalizeChartSpec(spec);
    if (!normalizedSpec.series.length) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'chart-wrapper';

    let html = '<div class="chart-container">';

    // Header with download button
    html += `<div class="chart-header">
      <div>
        <div class="chart-title">${esc(normalizedSpec.title || '')}</div>
        ${normalizedSpec.subtitle ? `<div class="chart-subtitle">${esc(normalizedSpec.subtitle)}</div>` : ''}
      </div>
      <button class="chart-download-btn" data-download>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        PNG
      </button>
    </div>`;

    // Chart canvas
    html += '<div class="chart-canvas" data-chart></div>';

    // Data table
    if (normalizedSpec.data_table !== false && normalizedSpec.x_axis?.categories) {
      html += buildDataTable(normalizedSpec);
    }

    // Source
    if (normalizedSpec.source_info) {
      const date = new Date().toLocaleDateString();
      html += `<div class="chart-source">${esc(normalizedSpec.source_info)} | Generated: ${date}</div>`;
    }

    html += '</div>';
    wrapper.innerHTML = html;
    messagesDiv.appendChild(wrapper);

    // Initialize ECharts
    const canvas = wrapper.querySelector('[data-chart]');
    if (canvas && typeof echarts !== 'undefined') {
      const chart = echarts.init(canvas);
      const option = buildChartOption(normalizedSpec);
      chart.setOption(option);
      // Track observer alongside chart for proper cleanup
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(canvas);
      chart._resizeObserver = ro;
      chartInstances.push(chart);

      // Download handler
      wrapper.querySelector('[data-download]').addEventListener('click', () => {
        const url = chart.getDataURL({ type: 'png', pixelRatio: 2 });
        const a = document.createElement('a');
        a.href = url;
        a.download = (normalizedSpec.title || 'chart').replace(/[^a-z0-9]/gi, '_') + '.png';
        a.click();
      });
    }

    scrollToBottom();
  }

  function normalizeChartSpec(spec) {
    const cloned = JSON.parse(JSON.stringify(spec || {}));
    const normalized = {
      ...cloned,
      chart_type: cloned.chart_type || 'bar',
      title: cloned.title || 'Chart',
      x_axis: cloned.x_axis || {},
      y_axis: cloned.y_axis || {},
      series: Array.isArray(cloned.series) ? cloned.series : [],
    };

    let categories = Array.isArray(normalized.x_axis.categories)
      ? normalized.x_axis.categories.map(v => String(v ?? ''))
      : [];

    const maxSeriesLen = normalized.series.reduce((m, s) => Math.max(m, Array.isArray(s.data) ? s.data.length : 0), 0);
    if (!categories.length && maxSeriesLen > 0 && normalized.chart_type !== 'gauge') {
      categories = Array.from({ length: maxSeriesLen }, (_, i) => `Item ${i + 1}`);
    }

    normalized.x_axis.categories = categories;
    const targetLen = categories.length || maxSeriesLen;

    normalized.series = normalized.series.map((s, index) => {
      const source = Array.isArray(s.data) ? s.data : [];
      const data = [];
      for (let i = 0; i < (targetLen || source.length); i++) {
        const raw = source[i];
        if (raw == null || raw === '') {
          data.push(null);
        } else if (Array.isArray(raw)) {
          data.push(raw);
        } else {
          const n = Number(raw);
          data.push(Number.isNaN(n) ? null : n);
        }
      }
      return {
        ...s,
        name: s.name || `Series ${index + 1}`,
        data,
      };
    }).filter(s => s.data.some(v => v != null));

    return normalized;
  }

  function buildChartOption(spec) {
    const type = spec.chart_type || 'bar';
    const categories = (spec.x_axis?.categories || []).map(formatPeriod);
    const hasLegend = spec.series.length > 1 || type === 'pie';
    const hasMany = categories.length > 15;
    const isDark = document.body.classList.contains('theme-dark');
    const axisText = isDark ? '#cbd5e1' : '#64748b';
    const splitLine = isDark ? '#263449' : '#f0f0f0';
    const tooltipBg = isDark ? 'rgba(16,26,47,0.96)' : 'rgba(255,255,255,0.96)';
    const tooltipBorder = isDark ? '#334155' : '#e2e8f0';
    const tooltipText = isDark ? '#e5e7eb' : '#1a1a2e';

    const option = {
      color: PALETTE,
      backgroundColor: 'transparent',
      grid: {
        top: hasLegend ? 36 : 20,
        right: 20,
        bottom: hasMany && type !== 'pie' && type !== 'gauge' && type !== 'heatmap' ? 60 : (hasLegend ? 40 : 24),
        left: 52,
        containLabel: true,
      },
      tooltip: {
        trigger: type === 'pie' || type === 'heatmap' ? 'item' : 'axis',
        axisPointer: { type: 'line', lineStyle: { color: axisText, width: 1 } },
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        textStyle: { color: tooltipText, fontSize: 12 },
        confine: true,
        extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 8px;',
        formatter: type === 'pie' || type === 'heatmap' ? undefined : function (params) {
          if (!Array.isArray(params)) params = [params];
          let html = `<div style="font-weight:600;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #f0f0f0">${esc(params[0].axisValueLabel || '')}</div>`;
          params.forEach(p => {
            const val = formatNumber(p.value, spec.y_axis?.format);
            html += `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
              ${p.marker}<span style="flex:1">${esc(p.seriesName)}</span><strong style="margin-left:8px">${val}</strong>
            </div>`;
          });
          return html;
        },
      },
      legend: {
        top: 4,
        textStyle: { fontSize: 11, color: axisText },
        itemGap: 16,
        itemWidth: 14,
        itemHeight: 10,
        show: hasLegend,
      },
      toolbox: {
        show: true,
        right: 4,
        top: 4,
        iconStyle: { borderColor: axisText },
        emphasis: { iconStyle: { borderColor: '#4f46e5' } },
        feature: {
          saveAsImage: { show: true, pixelRatio: 2, title: 'Save' },
          restore: { show: true, title: 'Reset' },
        },
        itemSize: 13,
      },
    };

    // DataZoom for charts with many categories
    if (hasMany && type !== 'pie' && type !== 'gauge' && type !== 'heatmap' && type !== 'horizontal_bar') {
      option.dataZoom = [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', start: 0, end: 100, height: 18, bottom: 8, borderColor: isDark ? '#334155' : '#e2e8f0', fillerColor: 'rgba(79,70,229,0.08)', handleStyle: { color: '#4f46e5' } },
      ];
      option.grid.bottom = 50;
    }

    // Axes (non-pie/gauge/heatmap)
    if (type !== 'pie' && type !== 'gauge' && type !== 'heatmap') {
      const isHorizontal = type === 'horizontal_bar';
      const catAxis = {
        type: 'category',
        data: categories,
        axisLabel: {
          fontSize: 10, color: axisText,
          rotate: categories.length > 8 ? (categories.length > 20 ? 60 : 35) : 0,
          interval: categories.length > 40 ? Math.floor(categories.length / 20) : 0,
        },
        axisLine: { lineStyle: { color: isDark ? '#334155' : '#e2e8f0' } },
        axisTick: { show: false },
      };
      const valAxis = {
        type: 'value',
        name: spec.y_axis?.label || '',
        nameTextStyle: { fontSize: 10, color: axisText, padding: [0, 0, 0, -10] },
        axisLabel: {
          fontSize: 10, color: axisText,
          formatter: v => formatNumber(v, spec.y_axis?.format),
        },
        splitLine: { lineStyle: { color: splitLine, type: 'dashed' } },
        axisLine: { show: false },
        axisTick: { show: false },
        min: spec.y_axis?.min,
        max: spec.y_axis?.max,
      };

      option.xAxis = isHorizontal ? valAxis : catAxis;
      option.yAxis = isHorizontal ? catAxis : valAxis;
      if (isHorizontal) option.grid.left = 90;
    }

    // ── Heatmap ──
    if (type === 'heatmap') {
      const yCategories = spec.series.map(s => s.name);
      const heatData = [];
      let minVal = Infinity, maxVal = -Infinity;
      spec.series.forEach((s, yi) => {
        s.data.forEach((v, xi) => {
          if (v != null) {
            heatData.push([xi, yi, v]);
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
        });
      });

      option.xAxis = {
        type: 'category', data: categories,
        splitArea: { show: true },
        axisLabel: { fontSize: 10, color: axisText, rotate: categories.length > 8 ? 35 : 0 },
      };
      option.yAxis = {
        type: 'category', data: yCategories,
        splitArea: { show: true },
        axisLabel: { fontSize: 10, color: axisText },
      };
      option.visualMap = {
        min: minVal === Infinity ? 0 : minVal,
        max: maxVal === -Infinity ? 100 : maxVal,
        calculable: true,
        orient: 'horizontal',
        left: 'center', bottom: 4,
        inRange: { color: ['#e0f2fe', '#7dd3fc', '#0ea5e9', '#0369a1', '#0c4a6e'] },
        textStyle: { fontSize: 10, color: axisText },
        itemHeight: 12,
      };
      option.series = [{
        type: 'heatmap',
        data: heatData,
        label: { show: heatData.length < 80, fontSize: 10, color: '#333' },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.2)' } },
      }];
      option.grid.left = 90;
      option.grid.bottom = 60;
      delete option.legend;
      return option;
    }

    // ── Gauge ──
    if (type === 'gauge' && spec.series[0]) {
      const val = spec.series[0].data[0];
      const maxVal = spec.y_axis?.max || 100;
      const pct = val / maxVal;
      option.series = [{
        type: 'gauge',
        data: [{ value: val, name: spec.series[0].name }],
        radius: '88%',
        center: ['50%', '55%'],
        startAngle: 220,
        endAngle: -40,
        min: spec.y_axis?.min || 0,
        max: maxVal,
        progress: { show: true, width: 14, roundCap: true },
        detail: {
          fontSize: 28, fontWeight: 700, offsetCenter: [0, '55%'],
          formatter: v => formatNumber(v, spec.y_axis?.format),
          color: pct < 0.3 ? '#10b981' : pct < 0.7 ? '#f59e0b' : '#ef4444',
        },
        axisLine: { lineStyle: { width: 14, color: [[0.3,'#10b981'],[0.7,'#f59e0b'],[1,'#ef4444']] }, roundCap: true },
        pointer: { width: 5, length: '55%', itemStyle: { color: '#334155' } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { fontSize: 10, color: axisText, distance: -28 },
        title: { offsetCenter: [0, '78%'], fontSize: 12, color: axisText, fontWeight: 500 },
        anchor: { show: true, size: 16, itemStyle: { borderWidth: 4, borderColor: isDark ? '#334155' : '#e2e8f0' } },
      }];
      delete option.xAxis;
      delete option.yAxis;
      delete option.grid;
      delete option.dataZoom;
      return option;
    }

    // ── Standard series ──
    option.series = spec.series.map((s, i) => {
      const seriesType = s.type_override || mapChartType(type);
      const base = {
        name: s.name,
        data: s.data,
        type: seriesType,
        color: s.color,
      };

      if (seriesType === 'bar') {
        base.barMaxWidth = 40;
        base.barMinWidth = 2;
        base.itemStyle = { borderRadius: [3, 3, 0, 0] };
        if (s.stack_group) base.stack = s.stack_group;
        if (type === 'horizontal_bar') base.itemStyle.borderRadius = [0, 3, 3, 0];
        if (s.data.length <= 12) {
          base.label = {
            show: true,
            position: type === 'horizontal_bar' ? 'right' : 'top',
            fontSize: 10, color: axisText,
            formatter: p => formatNumber(p.value, spec.y_axis?.format),
          };
        }
      }

      if (seriesType === 'line') {
        base.smooth = false;
        base.lineStyle = { width: 2.5 };
        base.symbolSize = s.data.length < 20 ? 6 : 0;
        base.showSymbol = s.data.length < 20;
        if (type === 'area') {
          base.areaStyle = {
            opacity: 0.16,
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: (s.color || PALETTE[i % PALETTE.length]) + '66' },
              { offset: 1, color: (s.color || PALETTE[i % PALETTE.length]) + '08' },
            ]),
          };
        }
        // Highlight latest point
        if (s.data.length > 2 && s.data.length < 30) {
          base.emphasis = { focus: 'series' };
        }
      }

      if (seriesType === 'pie') {
        let data = s.data.map((v, idx) => ({ value: v, name: categories[idx] || `Item ${idx+1}` }));
        if (data.length > 7) {
          data.sort((a, b) => b.value - a.value);
          const top6 = data.slice(0, 6);
          const rest = data.slice(6).reduce((sum, d) => sum + d.value, 0);
          data = [...top6, { value: rest, name: 'Other' }];
        }
        base.data = data;
        base.radius = ['42%', '72%'];
        base.center = ['50%', '50%'];
        base.padAngle = 2;
        base.itemStyle = { borderRadius: 4 };
        base.label = {
          show: true, fontSize: 11,
          formatter: p => `${p.name}\n${formatNumber(p.value, spec.y_axis?.format)} (${p.percent.toFixed(1)}%)`,
          lineHeight: 16,
        };
        base.labelLine = { length: 12, length2: 8 };
        base.emphasis = { itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,0.2)' }, scaleSize: 6 };
      }

      if (seriesType === 'scatter') {
        base.symbolSize = 10;
        base.emphasis = { focus: 'series', itemStyle: { shadowBlur: 8 } };
      }

      if ((seriesType === 'line' || seriesType === 'bar') && s.data.length > 2 && s.data.length <= 80) {
        base.markPoint = {
          symbolSize: 28,
          itemStyle: { color: '#1f2937' },
          label: { color: '#fff', fontSize: 10, formatter: p => formatNumber(p.value, spec.y_axis?.format) },
          data: [{ type: 'max', name: 'Max' }, { type: 'min', name: 'Min' }],
        };
      }

      // Annotations as markLine
      if (i === 0 && spec.annotations?.length) {
        base.markLine = {
          silent: true,
          symbol: 'none',
          data: spec.annotations.map(a => ({
            yAxis: a.value,
            label: {
              formatter: a.label || '',
              position: 'insideEndTop',
              fontSize: 10,
              backgroundColor: 'rgba(255,255,255,0.9)',
              padding: [2, 6],
              borderRadius: 3,
            },
            lineStyle: {
              color: a.color || SEMANTIC[a.type] || '#8E8E93',
              type: a.line_style === 'solid' ? 'solid' : 'dashed',
              width: 1.5,
            },
          })),
        };
      }

      return base;
    });

    return option;
  }

  function mapChartType(type) {
    const map = { line:'line', bar:'bar', horizontal_bar:'bar', pie:'pie', stacked_bar:'bar', area:'line', scatter:'scatter', gauge:'gauge' };
    return map[type] || 'bar';
  }

  function buildDataTable(spec) {
    const cats = (spec.x_axis?.categories || []).map(formatPeriod);
    let html = '<div class="data-table-wrapper"><table class="data-table"><thead><tr><th></th>';
    spec.series.forEach(s => { html += `<th>${esc(s.name)}</th>`; });
    html += '</tr></thead><tbody>';
    cats.forEach((cat, i) => {
      html += `<tr><td><strong>${esc(cat)}</strong></td>`;
      spec.series.forEach(s => {
        const v = s.data[i];
        html += `<td>${v != null ? formatNumber(v, spec.y_axis?.format) : '-'}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  // ── Period Formatting ────────────────────────────────────────────────────
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function formatPeriod(p) {
    if (!p || typeof p !== 'string') return String(p ?? '');
    if (/^\d{6}$/.test(p)) return `${MONTHS[parseInt(p.slice(4,6))-1]} ${p.slice(0,4)}`;
    if (/^\d{4}Q\d$/.test(p)) return `Q${p[5]} ${p.slice(0,4)}`;
    if (/^\d{4}S\d$/.test(p)) return `H${p[5]} ${p.slice(0,4)}`;
    if (/^\d{4}W\d+$/.test(p)) return `W${p.split('W')[1]} ${p.slice(0,4)}`;
    if (/^\d{8}$/.test(p)) return `${p.slice(6,8)} ${MONTHS[parseInt(p.slice(4,6))-1]} ${p.slice(0,4)}`;
    if (/^\d{4}BiW\d+$/.test(p)) return `BiW${p.split('BiW')[1]} ${p.slice(0,4)}`;
    return p;
  }

  // ── Number Formatting ───────────────────────────────────────────────────
  function formatNumber(v, format) {
    if (v == null) return '-';
    const n = Number(v);
    if (isNaN(n)) return String(v);
    if (format === 'percent') return n.toFixed(1) + '%';
    if (format === 'thousands') return (n / 1000).toFixed(1) + 'K';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'K';
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toFixed(1);
  }

  // ── Markdown Rendering ──────────────────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';

    // First, extract and process tables from the raw text BEFORE escaping
    const tablePlaceholders = [];
    text = text.replace(/(^|\n)(\|.+\|[ ]*\n\|[ :|-]+\|[ ]*\n(?:\|.+\|[ ]*\n?)*)/gm, (match, prefix, table) => {
      const rows = table.trim().split('\n').filter(r => r.trim());
      if (rows.length < 2) return match;

      // Parse alignment row
      const alignRow = rows[1].split('|').filter(c => c.trim() !== '');
      const aligns = alignRow.map(c => {
        c = c.trim();
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });

      // Parse header
      const headerCells = rows[0].split('|').filter(c => c.trim() !== '').map(c => esc(c.trim()));

      // Parse body rows (skip header + alignment row)
      const bodyRows = rows.slice(2).map(row =>
        row.split('|').filter(c => c.trim() !== '').map(c => c.trim())
      );

      let html = '<div class="md-table-wrapper"><table class="md-table"><thead><tr>';
      headerCells.forEach((cell, i) => {
        const align = aligns[i] || 'left';
        html += `<th style="text-align:${align}">${renderInline(cell)}</th>`;
      });
      html += '</tr></thead><tbody>';
      bodyRows.forEach(cells => {
        html += '<tr>';
        cells.forEach((cell, i) => {
          const align = aligns[i] || 'left';
          html += `<td style="text-align:${align}">${renderInline(esc(cell))}</td>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';

      const placeholder = `__TABLE_${tablePlaceholders.length}__`;
      tablePlaceholders.push(html);
      return prefix + placeholder;
    });

    let h = esc(text);

    // Code blocks
    h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);

    // Inline code
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    h = h.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // Headers (with or without space after #, and # for h1)
    h = h.replace(/^####\s*(.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^###\s*(.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^##\s*(.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');
    // Safety net: remove any orphaned heading markers on their own line (no content after)
    h = h.replace(/^#{1,4}\s*$/gm, '');

    // Bullet lists
    h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
    h = h.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, '<ul>$1</ul>');
    h = h.replace(/<\/ul>\s*<ul>/g, '');

    // Numbered lists
    h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Horizontal rule
    h = h.replace(/^---$/gm, '<hr>');

    // URLs (block javascript: and data: URIs for safety)
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      if (/^\s*(javascript|data|vbscript):/i.test(href)) return text;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    h = h.replace(/(^|[^"=])(https?:\/\/[^\s<)"]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    // Paragraphs
    h = h.replace(/\n\n/g, '</p><p>');
    h = '<p>' + h + '</p>';

    // Clean up: unwrap block-level elements from paragraphs
    h = h.replace(/<p>\s*<\/p>/g, '');
    h = h.replace(/<p>(<h[234]>)/g, '$1');
    h = h.replace(/(<\/h[234]>)<\/p>/g, '$1');
    h = h.replace(/<p>(<ul>)/g, '$1');
    h = h.replace(/(<\/ul>)<\/p>/g, '$1');
    h = h.replace(/<p>(<pre>)/g, '$1');
    h = h.replace(/(<\/pre>)<\/p>/g, '$1');
    h = h.replace(/<p>(<hr>)/g, '$1');
    h = h.replace(/(<hr>)<\/p>/g, '$1');

    // Restore table placeholders (unwrap from <p> if needed)
    tablePlaceholders.forEach((tableHtml, i) => {
      const placeholder = `__TABLE_${i}__`;
      // Remove wrapping <p>...</p> around the placeholder
      h = h.replace(new RegExp(`<p>[^<]*${placeholder}[^<]*</p>`, 'g'), tableHtml);
      h = h.replace(new RegExp(placeholder, 'g'), tableHtml);
    });

    return h;
  }

  /** Render bold/italic/code inside already-escaped text (for table cells) */
  function renderInline(h) {
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    return h;
  }

  // ── Utilities ────────────────────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesArea.scrollTop = messagesArea.scrollHeight;
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  init();
})();
