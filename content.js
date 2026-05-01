(() => {
  'use strict';

  const url = window.location.href;
  if (!url.includes('/dhis-web-') && !url.includes('/apps/') && !url.includes('/api/')) return;

  let lastNotifiedUrl = '';
  let lastDetectedStageId = '';
  let contextAlive = true;
  const timerHandles = [];

  // Chrome MV3: when the extension is reloaded / updated / disabled, the page-side
  // content script keeps running (with its setInterval timers and history hooks),
  // but `chrome.runtime` gets orphaned. The next sendMessage call throws synchronously
  // with "Extension context invalidated.", and a Promise .catch() doesn't see it
  // because the throw beats the Promise creation. We have to (a) probe chrome.runtime.id
  // (becomes undefined the moment the bridge is severed), (b) try/catch around the call,
  // and (c) stop our own timers once we know the context is dead so the page stops
  // emitting console errors forever.
  function teardown() {
    if (!contextAlive) return;
    contextAlive = false;
    for (const id of timerHandles) clearInterval(id);
    timerHandles.length = 0;
  }

  function safeSendMessage(message) {
    if (!contextAlive) return;
    if (!chrome.runtime?.id) { teardown(); return; }
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          if (String(err?.message || err).includes('Extension context invalidated')) teardown();
        });
      }
    } catch (err) {
      if (String(err?.message || err).includes('Extension context invalidated')) teardown();
    }
  }

  function notifyBackground() {
    const currentUrl = window.location.href;
    // Only notify if the URL actually changed (debounce duplicate notifications)
    if (currentUrl === lastNotifiedUrl) return;
    lastNotifiedUrl = currentUrl;
    safeSendMessage({
      type: 'DHIS2_CONTEXT_UPDATE',
      payload: { url: currentUrl }
    });
  }

  notifyBackground();
  window.addEventListener('hashchange', () => setTimeout(notifyBackground, 300));
  window.addEventListener('popstate', () => setTimeout(notifyBackground, 300));

  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    setTimeout(notifyBackground, 300);
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    setTimeout(notifyBackground, 300);
  };

  // Also poll for URL changes every 2 seconds as a fallback
  // (some SPAs change the URL without triggering standard events)
  let lastPolledUrl = window.location.href;
  timerHandles.push(setInterval(() => {
    if (!contextAlive) return;
    const current = window.location.href;
    if (current !== lastPolledUrl) {
      lastPolledUrl = current;
      notifyBackground();
    }
  }, 2000));

  // ── Active Stage Detection for Capture / Tracker Capture ─────────────
  // When the user is in the enrollment dashboard and selects a stage tab/widget,
  // the URL may not always include stageId (depends on DHIS2 version).
  // This observer detects the active stage from DOM indicators and sends
  // a lightweight DHIS2_STAGE_DETECTED message to the background script.

  const DHIS2_UID_RE = /\b([A-Za-z][A-Za-z0-9]{10})\b/;

  function isCapturePage() {
    const href = window.location.href;
    return href.includes('/apps/capture') || href.includes('/dhis-web-capture')
      || href.includes('/apps/tracker-capture') || href.includes('/dhis-web-tracker-capture');
  }

  function getStageIdFromUrl() {
    const hash = window.location.hash || '';
    const match = hash.match(/[?&]stageId=([A-Za-z][A-Za-z0-9]{10})/);
    return match ? match[1] : null;
  }

  /**
   * Scan the DOM for the active/expanded stage widget in DHIS2 Capture.
   * Returns the detected stageId or null.
   *
   * Targets multiple DHIS2 Capture patterns:
   * - v41+: data-test="widget-enrollment-event-new-event-{stageId}" or
   *         data-test="widget-enrollment-event-{stageId}"
   * - Expanded widgets with visible event content
   * - Tracker Capture: active stage tabs with data attributes
   */
  function detectStageFromDom() {
    // Pattern 1: DHIS2 Capture v41+ stage widget data-test attributes
    // These widgets use data-test attributes containing stage UIDs
    const stageWidgets = document.querySelectorAll(
      '[data-test*="widget-enrollment-event"]'
    );
    for (const widget of stageWidgets) {
      const dt = widget.getAttribute('data-test') || '';
      // Extract UID from the data-test value
      const uidMatch = dt.match(DHIS2_UID_RE);
      if (!uidMatch) continue;
      // Check if this widget is expanded (has visible content beyond just header)
      // Expanded widgets typically have table rows, event cards, or "new event" buttons visible
      const hasContent = widget.querySelector('table, [data-test*="event"], [data-test*="new-event"], button');
      const rect = widget.getBoundingClientRect();
      if (hasContent && rect.height > 100) {
        return uidMatch[1];
      }
    }

    // Pattern 2: Active tab in Tracker Capture (older app)
    const activeTabs = document.querySelectorAll(
      '.stage-tab.active, .nav-tabs .active[data-stage], [data-test="stage-tab"][aria-selected="true"]'
    );
    for (const tab of activeTabs) {
      const stageAttr = tab.getAttribute('data-stage') || tab.getAttribute('data-test') || '';
      const uidMatch = stageAttr.match(DHIS2_UID_RE);
      if (uidMatch) return uidMatch[1];
    }

    // Pattern 3: Generic — look for visible stage content areas with UIDs in data-test
    const stageContent = document.querySelectorAll(
      '[data-test*="stage-content"], [data-test*="Stage"]'
    );
    for (const el of stageContent) {
      const dt = el.getAttribute('data-test') || '';
      const uidMatch = dt.match(DHIS2_UID_RE);
      if (uidMatch && el.offsetParent !== null) {
        return uidMatch[1];
      }
    }

    return null;
  }

  function checkActiveStage() {
    if (!isCapturePage()) return;

    // URL-based stageId always wins
    const urlStageId = getStageIdFromUrl();
    if (urlStageId) {
      if (urlStageId !== lastDetectedStageId) {
        lastDetectedStageId = urlStageId;
        safeSendMessage({
          type: 'DHIS2_STAGE_DETECTED',
          payload: { stageId: urlStageId, source: 'url' }
        });
      }
      return;
    }

    // DOM-based fallback
    const domStageId = detectStageFromDom();
    if (domStageId && domStageId !== lastDetectedStageId) {
      lastDetectedStageId = domStageId;
      safeSendMessage({
        type: 'DHIS2_STAGE_DETECTED',
        payload: { stageId: domStageId, source: 'dom' }
      });
    }
  }

  // Run stage detection every 3 seconds on Capture pages
  // (lightweight — no-op on non-Capture pages)
  timerHandles.push(setInterval(() => {
    if (!contextAlive) return;
    checkActiveStage();
  }, 3000));
  // Also run once on load after a short delay (DOM needs time to render)
  setTimeout(() => { if (contextAlive) checkActiveStage(); }, 1500);
})();
