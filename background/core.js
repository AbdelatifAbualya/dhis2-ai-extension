/*
 * Pure helpers shared by the background service worker and its Node tests.
 *
 * Keep this module browser-API free. The service worker loads it with
 * importScripts(), while the test suite loads the same implementation through
 * CommonJS. This gives the highest-risk parsing and state decisions a stable,
 * dependency-free test seam without turning the extension into a build project.
 */
(function exposeDhis2AiCore(root, factory) {
  'use strict';

  const api = Object.freeze(factory());
  root.Dhis2AiCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
  const DHIS_UID_SHAPE_RE = /^[A-Za-z][A-Za-z0-9]{10}$/;
  const CONTEXT_IDENTITY_KEYS = Object.freeze([
    'appType',
    'programId',
    'orgUnitId',
    'datasetId',
    'visualizationId',
    'mapId',
    'eventId',
  ]);

  function isLocalProviderUrl(rawUrl) {
    if (!rawUrl) return false;
    let url;
    try { url = new URL(rawUrl); } catch { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.local');
  }

  function isValidProviderUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
    let url;
    try { url = new URL(rawUrl.trim()); } catch { return false; }
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  function getChatCompletionsUrl(baseUrl, fallbackBaseUrl) {
    let url = String(baseUrl || fallbackBaseUrl || '').replace(/\/+$/, '');
    if (url.endsWith('/chat/completions')) return url;
    if (/generativelanguage\.googleapis\.com\/?$/.test(url) || url.endsWith('googleapis.com')) {
      return url + '/v1beta/openai/chat/completions';
    }
    return url + '/chat/completions';
  }

  function sanitizeHeaderValue(value) {
    if (value == null) return null;
    const cleaned = String(value).replace(/[^\x20-\x7E]/g, '').trim();
    if (!cleaned) return null;
    return cleaned.length > 4096 ? cleaned.slice(0, 4096) : cleaned;
  }

  // Lowercase only. Intent matching sometimes relies on punctuation such as
  // "sub-", so this must remain distinct from normalizeSearchText().
  function normalizePlainText(value) {
    return String(value ?? '').toLowerCase();
  }

  // Normalize prose for token matching. Do not use this for literal substring
  // rules whose punctuation is meaningful.
  function normalizeSearchText(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function hasUidShape(value) {
    return DHIS_UID_SHAPE_RE.test(String(value ?? ''));
  }

  // Free text is untrusted: many English words have the same 11-character
  // shape as a DHIS2 UID. Require a digit or mixed case after the first letter.
  function isLikelyDhisUid(value) {
    const candidate = String(value ?? '');
    if (!hasUidShape(candidate)) return false;
    if (/\d/.test(candidate)) return true;
    const rest = candidate.slice(1);
    return /[A-Z]/.test(rest) && /[a-z]/.test(rest);
  }

  function firstLikelyUid(text) {
    const matches = String(text ?? '').match(/\b[A-Za-z][A-Za-z0-9]{10}\b/g) || [];
    return matches.find(isLikelyDhisUid) || null;
  }

  function safelyDecodeURIComponent(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  /**
   * Extract a DHIS2 UID from a trusted resource URL or untrusted free text.
   *
   * Structural URL positions accept the full DHIS2 UID shape. Free-text
   * fallback uses isLikelyDhisUid() and never scans inside a parsed URL.
   */
  function extractDhis2IdFromInput(input, resourcePath, queryKeys = []) {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    if (isLikelyDhisUid(raw)) return raw;

    let parsedUrl = null;
    try { parsedUrl = new URL(raw); } catch {}

    if (parsedUrl) {
      const hash = parsedUrl.hash || '';
      const hashRoute = hash.split('?')[0] || '';
      if (hashRoute.startsWith('#/')) {
        const firstSegment = safelyDecodeURIComponent(hashRoute.slice(2)).split('/')[0];
        if (hasUidShape(firstSegment)) return firstSegment;
      }

      if (hash.includes('?')) {
        const hashParams = new URLSearchParams(hash.split('?')[1]);
        for (const key of queryKeys) {
          const value = hashParams.get(key);
          if (hasUidShape(value)) return value;
        }
      }

      for (const key of queryKeys) {
        const value = parsedUrl.searchParams.get(key);
        if (hasUidShape(value)) return value;
      }

      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      const resourceIndex = pathParts.findIndex(part => part === resourcePath);
      if (resourceIndex !== -1 && pathParts[resourceIndex + 1]) {
        const value = safelyDecodeURIComponent(pathParts[resourceIndex + 1]).replace(/\.json$/i, '');
        if (hasUidShape(value)) return value;
      }

      // A parsed URL with no recognized resource ID is not free text. Never
      // scan its hostname/path for coincidental 11-character tokens.
      return null;
    }

    return firstLikelyUid(raw);
  }

  function extractDhis2IdFromText(text, resourcePath, queryKeys = []) {
    const raw = String(text ?? '');
    if (!raw) return null;

    const urls = raw.match(/https?:\/\/\S+/gi) || [];
    for (const urlToken of urls) {
      // Prose and Markdown commonly wrap URLs in punctuation. Strip only
      // trailing delimiters so a valid UID at the end of a route still parses.
      const url = urlToken.replace(/[)\]}>.,;!?]+$/g, '');
      const fromUrl = extractDhis2IdFromInput(url, resourcePath, queryKeys);
      if (fromUrl) return fromUrl;
    }

    const withoutUrls = raw.replace(/https?:\/\/\S+/gi, ' ');
    return firstLikelyUid(withoutUrls);
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',') + '}';
  }

  function contextIdentityChanged(previous, next, keys = CONTEXT_IDENTITY_KEYS) {
    const before = previous || {};
    const after = next || {};
    return keys.some(key => (before[key] ?? null) !== (after[key] ?? null));
  }

  return {
    CONTEXT_IDENTITY_KEYS,
    contextIdentityChanged,
    extractDhis2IdFromInput,
    extractDhis2IdFromText,
    getChatCompletionsUrl,
    hasUidShape,
    isLikelyDhisUid,
    isLocalProviderUrl,
    isValidProviderUrl,
    normalizePlainText,
    normalizeSearchText,
    sanitizeHeaderValue,
    stableStringify,
  };
});
