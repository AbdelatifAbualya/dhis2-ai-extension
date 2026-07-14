// ── manage_custom_translations: experimental DHIS2 2.43 "custom-translations" datastore feature ──
//
// VERIFIED on DHIS2 2.43 (play stable-2-43-0-1): the new Capture app fetches, at startup:
//   1. GET /api/dataStore/custom-translations/controller   → { "<appSlug>": ["<locale>", ...] }
//   2. GET /api/dataStore/custom-translations/<slug>__<locale>  (when the active UI locale is
//      registered for that app) → { "<source string>": "<replacement>", ... }
// Both requests were observed returning 200 from the Capture app, and the key template
// `${slug}__${locale}` (slug lowercased) was confirmed in the app bundle. At render time the
// app swaps each matching source string for its replacement.
//
// The replacement can be a DIFFERENT language (true translation) or the SAME language (a plain
// string rewrite, e.g. "Report data" → "Submit report" under locale "en"). The feature treats
// it as a literal source→target map; this tool supports both uses identically.
//
// IMPORTANT: an app/locale pair that is NOT listed in the `controller` key is never loaded by
// the app, so set/remove always keep the controller registry and the per-locale key in sync.
//
// DataStore keys are not metadata objects, so the standard ensureBackupOrBail/manage_backups
// machinery (which restores via /api/metadata) cannot roll them back. Instead set/remove return
// the pre-write state inline (previous_value / previous_controller) for manual recovery.

const CUSTOM_TRANSLATIONS_NS = 'custom-translations';
const CUSTOM_TRANSLATIONS_CONTROLLER_KEY = 'controller';
const CUSTOM_TRANSLATIONS_MIN_API = 43;

// Refuse on servers older than 2.43 — the apps simply don't read this namespace there.
function customTranslationsVersionGate() {
  const v = Number(dhis2.apiVersion);
  if (Number.isFinite(v) && v >= CUSTOM_TRANSLATIONS_MIN_API) return null;
  return {
    _error: `Refused: custom translations require DHIS2 2.${CUSTOM_TRANSLATIONS_MIN_API}+. This instance reports API version "${dhis2.apiVersion || '?'}" (${dhis2.systemInfo?.version || 'unknown'}).`,
    _hint: 'The custom-translations datastore feature is only read by DHIS2 apps on 2.43 and later. On older servers, writing these keys has no visible effect — do not attempt it.',
  };
}

function normalizeAppSlug(app) {
  return String(app == null ? '' : app).trim().toLowerCase();
}
// Locale casing is significant (e.g. pt_BR, uz_UZ_Cyrl) — only trim, never lowercase.
function normalizeLocale(locale) {
  return String(locale == null ? '' : locale).trim();
}
function customTranslationKey(slug, locale) {
  return `${slug}__${locale}`;
}
function ctPath(key) {
  return `dataStore/${encodeURIComponent(CUSTOM_TRANSLATIONS_NS)}/${encodeURIComponent(key)}`;
}
function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Read the controller registry. Returns { exists, value } (value is {} when missing) or { _error }.
async function ctFetchController() {
  const resp = await safeDhis2Fetch(ctPath(CUSTOM_TRANSLATIONS_CONTROLLER_KEY));
  if (resp?._status === 404) return { exists: false, value: {} };
  if (resp?._error) return { _error: `Could not read the controller registry: ${resp._error}` };
  return { exists: true, value: isPlainObject(resp) ? resp : {} };
}

// Upsert any custom-translations key: POST to create, fall back to PUT on 409 (already exists).
async function ctUpsertKey(key, value) {
  let resp = await safeDhis2Fetch(ctPath(key), { method: 'POST', body: value });
  if (resp?._status === 409) {
    resp = await safeDhis2Fetch(ctPath(key), { method: 'PUT', body: value });
  }
  if (resp?._error) return { _error: `Could not write key "${key}": ${resp._error}` };
  return { ok: true };
}

async function ctWriteController(value) {
  return await ctUpsertKey(CUSTOM_TRANSLATIONS_CONTROLLER_KEY, value);
}

async function listCustomTranslations() {
  const keysResp = await safeDhis2Fetch(`dataStore/${encodeURIComponent(CUSTOM_TRANSLATIONS_NS)}`);
  if (keysResp?._status === 404) {
    return {
      success: true, namespace: CUSTOM_TRANSLATIONS_NS, exists: false,
      registered: {}, translation_keys: [],
      _note: 'The custom-translations namespace does not exist yet. Use action="set" to create the first translation (it also creates the controller registry).',
    };
  }
  if (keysResp?._error) return { _error: `Could not list custom-translations keys: ${keysResp._error}` };
  const keys = Array.isArray(keysResp) ? keysResp : [];
  const controller = await ctFetchController();
  if (controller._error) return controller;
  const translationKeys = keys
    .filter(k => k !== CUSTOM_TRANSLATIONS_CONTROLLER_KEY)
    .map(k => {
      const idx = k.indexOf('__');
      return idx > 0
        ? { key: k, app: k.slice(0, idx), locale: k.slice(idx + 2) }
        : { key: k, app: null, locale: null, _note: 'Key does not follow the <slug>__<locale> format.' };
    });
  return {
    success: true,
    namespace: CUSTOM_TRANSLATIONS_NS,
    exists: true,
    registered: controller.value,
    translation_keys: translationKeys,
    key_count: keys.length,
  };
}

async function getCustomTranslations(args) {
  const slug = normalizeAppSlug(args.app);
  const locale = normalizeLocale(args.locale);
  const controller = await ctFetchController();
  if (controller._error) return controller;
  if (!slug || !locale) {
    return {
      success: true, namespace: CUSTOM_TRANSLATIONS_NS,
      registered: controller.value,
      _note: 'Pass both app and locale to read a specific translation map.',
    };
  }
  const key = customTranslationKey(slug, locale);
  const registeredLocales = Array.isArray(controller.value[slug]) ? controller.value[slug] : [];
  const isRegistered = registeredLocales.includes(locale);
  const resp = await safeDhis2Fetch(ctPath(key));
  if (resp?._status === 404) {
    return {
      success: true, app: slug, locale, key, exists: false, registered: isRegistered, translations: {},
      _hint: isRegistered
        ? 'The controller lists this app/locale but the translation key is missing — the app has nothing to load. Use action="set" to add strings.'
        : 'No translations stored for this app/locale yet.',
    };
  }
  if (resp?._error) return { _error: `Could not read ${key}: ${resp._error}` };
  const translations = isPlainObject(resp) ? resp : {};
  return {
    success: true, app: slug, locale, key, exists: true,
    registered: isRegistered,
    entry_count: Object.keys(translations).length,
    translations,
    _hint: isRegistered
      ? undefined
      : `WARNING: "${slug}" + "${locale}" is NOT in the controller registry, so the app will NOT load these translations. Run action="set" (which registers automatically) to fix it.`,
  };
}

async function setCustomTranslations(args) {
  const slug = normalizeAppSlug(args.app);
  const locale = normalizeLocale(args.locale);
  if (!slug) return { _error: 'app is required for set (the app slug, e.g. "capture").' };
  if (!locale) return { _error: 'locale is required for set (e.g. "ar" to translate, or "en" to rewrite English strings in place).' };
  const translations = args.translations;
  if (!isPlainObject(translations)) {
    return { _error: 'translations must be a JSON object mapping each exact source string to its replacement, e.g. {"Report data":"الإبلاغ عن البيانات"}.' };
  }
  const entries = Object.entries(translations);
  if (!entries.length) return { _error: 'translations is empty — provide at least one source→replacement pair.' };
  const badValues = entries.filter(([, v]) => typeof v !== 'string');
  if (badValues.length) {
    return { _error: `All translation values must be strings. Offending source string(s): ${badValues.slice(0, 5).map(e => JSON.stringify(e[0])).join(', ')}.` };
  }

  const key = customTranslationKey(slug, locale);

  // Read existing map (for merge + restore snapshot).
  const existingResp = await safeDhis2Fetch(ctPath(key));
  const keyExisted = existingResp?._status !== 404;
  if (existingResp?._error && existingResp?._status !== 404) {
    return { _error: `Could not read the existing ${key}: ${existingResp._error}` };
  }
  const existing = (keyExisted && isPlainObject(existingResp)) ? existingResp : {};
  const replace = args.replace === true;
  const finalMap = replace ? { ...translations } : { ...existing, ...translations };

  // Controller registry: ensure slug + locale are registered.
  const controller = await ctFetchController();
  if (controller._error) return controller;
  const previousController = JSON.parse(JSON.stringify(controller.value || {}));
  const reg = controller.value || {};
  const locales = Array.isArray(reg[slug]) ? reg[slug].slice() : [];
  const controllerNeedsUpdate = !Array.isArray(reg[slug]) || !locales.includes(locale);
  if (!locales.includes(locale)) locales.push(locale);
  reg[slug] = locales;

  // Write the translation key first, then the controller (so a registered pair always has a key).
  const w1 = await ctUpsertKey(key, finalMap);
  if (w1._error) return w1;
  if (controllerNeedsUpdate) {
    const w2 = await ctWriteController(reg);
    if (w2._error) {
      return {
        _error: `Translations saved to ${key}, but updating the controller registry failed: ${w2._error}`,
        _hint: 'Without the controller entry the app will NOT load these translations. Retry action="set", or set the controller key manually.',
        previous_value: keyExisted ? existing : null,
      };
    }
  }

  const isRewrite = /^en\b/i.test(locale) || locale.toLowerCase() === 'en';
  return {
    success: true,
    namespace: CUSTOM_TRANSLATIONS_NS,
    app: slug,
    locale,
    key,
    mode: replace ? 'replace' : 'merge',
    entries_written: entries.length,
    total_entries: Object.keys(finalMap).length,
    key_existed: keyExisted,
    controller_updated: controllerNeedsUpdate,
    registered_locales: locales,
    previous_value: keyExisted ? existing : null,
    previous_controller: previousController,
    _hints: [
      `Reload the "${slug}" app with the UI locale set to "${locale}" to see the strings change.`,
      isRewrite
        ? 'Same-language rewrite: each value replaces its English source string verbatim.'
        : 'Translation: each English source string renders as its translated value.',
      'Each source string must match the on-screen text EXACTLY (capitalisation, punctuation, whitespace) or it will not be swapped.',
    ],
  };
}

async function removeCustomTranslations(args) {
  const slug = normalizeAppSlug(args.app);
  const locale = normalizeLocale(args.locale);
  if (!slug || !locale) return { _error: 'app and locale are required for remove.' };
  const key = customTranslationKey(slug, locale);
  const keysToRemove = Array.isArray(args.keys) ? args.keys.filter(k => typeof k === 'string') : null;

  const existingResp = await safeDhis2Fetch(ctPath(key));
  if (existingResp?._status === 404) {
    return { success: true, app: slug, locale, key, removed: false, _note: 'Nothing to remove — that translation key does not exist.' };
  }
  if (existingResp?._error) return { _error: `Could not read ${key}: ${existingResp._error}` };
  const existing = isPlainObject(existingResp) ? existingResp : {};

  // Partial removal: drop only the named source strings, keeping the key + registration —
  // unless that would empty the map, in which case fall through to a full delete.
  if (keysToRemove && keysToRemove.length) {
    const remaining = { ...existing };
    let removedCount = 0;
    for (const k of keysToRemove) { if (k in remaining) { delete remaining[k]; removedCount++; } }
    if (Object.keys(remaining).length > 0) {
      const w = await ctUpsertKey(key, remaining);
      if (w._error) return w;
      return {
        success: true, app: slug, locale, key,
        removed_entries: removedCount,
        remaining_entries: Object.keys(remaining).length,
        previous_value: existing,
      };
    }
  }

  // Full removal: delete the key and de-register the locale from the controller.
  const del = await safeDhis2Fetch(ctPath(key), { method: 'DELETE' });
  if (del?._error && del?._status !== 404) return { _error: `Could not delete ${key}: ${del._error}` };

  const controller = await ctFetchController();
  if (controller._error) return controller;
  const previousController = JSON.parse(JSON.stringify(controller.value || {}));
  const reg = controller.value || {};
  let controllerUpdated = false;
  if (Array.isArray(reg[slug]) && reg[slug].includes(locale)) {
    reg[slug] = reg[slug].filter(l => l !== locale);
    if (reg[slug].length === 0) delete reg[slug];
    controllerUpdated = true;
    const w = await ctWriteController(reg);
    if (w._error) return { _error: `Key deleted but de-registering it from the controller failed: ${w._error}`, previous_value: existing };
  }

  return {
    success: true, app: slug, locale, key, removed: true,
    controller_updated: controllerUpdated,
    previous_value: existing,
    previous_controller: previousController,
    _hint: 'Reload the app to confirm the strings reverted to their defaults.',
  };
}

async function executeManageCustomTranslations(args) {
  const action = args?.action;
  if (!action) {
    return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, set, remove.' };
  }
  const gate = customTranslationsVersionGate();
  if (gate) return gate;

  if (action === 'list') return await listCustomTranslations();
  if (action === 'get') return await getCustomTranslations(args);
  if (action === 'set') {
    const wa = requireWriteAuth('manage_custom_translations', 'set', { app: args.app, locale: args.locale });
    if (wa) return wa;
    return await setCustomTranslations(args);
  }
  if (action === 'remove') {
    const wa = requireWriteAuth('manage_custom_translations', 'remove', { app: args.app, locale: args.locale });
    if (wa) return wa;
    return await removeCustomTranslations(args);
  }
  return { _error: `Unknown manage_custom_translations action: ${action}`, _hint: 'One of: list, get, set, remove.' };
}

// ── manage_growth_chart_plugin: WHO Capture Growth Chart plugin setup ──
//
// VERIFIED on DHIS2 2.43 (play stable-2-43-0-1) against the dev-otta plugin
// (https://github.com/dev-otta/dhis2-who-growth-chart). The plugin renders WHO growth
// charts on a tracker enrollment dashboard in the new Capture app. It needs:
//   1. The app installed (App Hub "Capture Growth Chart", key capture-growth-chart).
//   2. A dataStore key — namespace "captureGrowthChart", key "config" — mapping the
//      program's metadata to the plugin's expected roles:
//        metadata.attributes:  dateOfBirth, gender, firstName, lastName, femaleOptionCode, maleOptionCode
//        metadata.dataElements: weight, height, headCircumference
//        metadata.programStageForGrowthChart: { "<programId>": "<programStageId>" }
//        settings: usePercentiles, customReferences, weightInGrams, defaultIndicator (wfa|hcfa|lhfa|wflh)
//   3. The plugin widget ADDED to the enrollment dashboard (owned by Capture / the Tracker
//      Plugin Configurator — an internal dataStore/capture layout this tool does NOT touch).
//
// Install verified: POST /api/appHub/{versionId} → 201; afterwards /api/apps lists
// capture-growth-chart with pluginLaunchUrl …/api/apps/capture-growth-chart/plugin.html.
// Config write verified: POST dataStore/captureGrowthChart/config → 201. A full program +
// stage + 3 measurement DEs + enrolled child with 3 measurements was created and accepted.

const GROWTH_CHART_NS = 'captureGrowthChart';
const GROWTH_CHART_KEY = 'config';
const GROWTH_CHART_APP_KEY = 'capture-growth-chart';
const GROWTH_CHART_APPHUB_NAME = 'Capture Growth Chart';
const GROWTH_CHART_INDICATORS = new Set(['wfa', 'hcfa', 'lhfa', 'wflh']);

function gcPath(key) {
  return `dataStore/${encodeURIComponent(GROWTH_CHART_NS)}/${encodeURIComponent(key)}`;
}

// Read captureGrowthChart/config. Returns { exists, value } or { _error }.
async function gcReadConfig() {
  const resp = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY));
  if (resp?._status === 404) return { exists: false, value: null };
  if (resp?._error) return { _error: `Could not read ${GROWTH_CHART_NS}/${GROWTH_CHART_KEY}: ${resp._error}` };
  return { exists: true, value: isPlainObject(resp) ? resp : null };
}

async function gcWriteConfig(value) {
  let resp = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY), { method: 'POST', body: value });
  if (resp?._status === 409) {
    resp = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY), { method: 'PUT', body: value });
  }
  if (resp?._error) return { _error: `Could not write ${GROWTH_CHART_NS}/${GROWTH_CHART_KEY}: ${resp._error}` };
  return { ok: true };
}

// Is the plugin app installed? Returns { installed, pluginLaunchUrl }.
async function gcAppStatus() {
  const apps = await safeDhis2Fetch('apps.json');
  if (apps?._error || !Array.isArray(apps)) return { installed: null, _note: 'Could not read installed app list.' };
  const app = apps.find(a => a.key === GROWTH_CHART_APP_KEY || /capture\s*growth\s*chart/i.test(a.name || ''));
  if (!app) return { installed: false };
  return {
    installed: true,
    app_key: app.key,
    plugin_launch_url: app.pluginLaunchUrl || `${dhis2.baseUrl}/api/apps/${app.key}/plugin.html`,
    version: app.version,
  };
}

function gcServerMinorVersion() {
  const n = Number(dhis2.apiVersion);
  return Number.isFinite(n) ? n : null;
}

// Install the plugin from the App Hub. Idempotent.
async function gcInstall() {
  const before = await gcAppStatus();
  if (before.installed) {
    return { success: true, already_installed: true, app_key: before.app_key, plugin_launch_url: before.plugin_launch_url, version: before.version };
  }
  const search = await safeDhis2Fetch(`appHub/v2/apps?query=${encodeURIComponent(GROWTH_CHART_APPHUB_NAME)}`);
  if (search?._error) return { _error: `Could not query the App Hub: ${search._error}`, _hint: 'The server may have no App Hub access. Install the "Capture Growth Chart" app manually via App Management.' };
  const results = search?.result || [];
  const app = results.find(a => /capture\s*growth\s*chart/i.test(a.name || '')) || results[0];
  if (!app) return { _error: 'Could not find "Capture Growth Chart" in the App Hub.', _hint: 'Install it manually via App Management, then re-run with action="configure".' };
  const serverMinor = gcServerMinorVersion();
  // versions are newest-first; pick the first compatible with this server.
  const versions = Array.isArray(app.versions) ? app.versions : [];
  const minorOf = (v) => { const m = String(v || '').match(/^\s*\d+\.(\d+)/); return m ? Number(m[1]) : null; };
  const compatible = versions.find(v => {
    if (serverMinor == null) return true;
    const min = minorOf(v.minDhisVersion);
    const max = minorOf(v.maxDhisVersion);
    return (min == null || serverMinor >= min) && (max == null || serverMinor <= max);
  }) || versions[0];
  if (!compatible?.id) return { _error: 'The App Hub returned no installable version for Capture Growth Chart.' };
  const install = await safeDhis2Fetch(`appHub/${encodeURIComponent(compatible.id)}`, { method: 'POST' });
  if (install?._error) return { _error: `App Hub install failed: ${install._error}`, _hint: 'You may lack the authority to install apps. Install "Capture Growth Chart" via App Management instead.' };
  const after = await gcAppStatus();
  return {
    success: true,
    installed_version: compatible.version,
    app_key: after.app_key || GROWTH_CHART_APP_KEY,
    plugin_launch_url: after.plugin_launch_url || `${dhis2.baseUrl}/api/apps/${GROWTH_CHART_APP_KEY}/plugin.html`,
    _note: after.installed ? 'Installed and confirmed in the app list.' : 'Install POST accepted; the app may take a moment to appear.',
  };
}

// Build the dashboard-attach guidance block (the part this tool does NOT auto-write).
function gcDashboardAttachBlock(pluginUrl, programId) {
  return {
    plugin_source_url: pluginUrl || `${dhis2.baseUrl}/api/apps/${GROWTH_CHART_APP_KEY}/plugin.html`,
    note: 'The plugin is configured but must be ADDED to the enrollment dashboard to become visible. This tool does not modify the Capture dashboard layout (dataStore/capture) to avoid corrupting the Capture cache.',
    steps: [
      'Easiest: open the "Tracker Plugin Configurator" app, pick this program, and add the Capture Growth Chart plugin to the enrollment dashboard.',
      `Or in Capture: open an enrollment for program ${programId || '<program>'}, use the enrollment dashboard "Edit"/"Add plugin" option, and paste the plugin source URL above.`,
    ],
  };
}

// Fetch a program with the attributes + stage data elements needed for detection.
async function gcFetchProgram(programId) {
  return await safeDhis2Fetch(
    `programs/${programId}?fields=id,displayName,programType,` +
    `programTrackedEntityAttributes[mandatory,trackedEntityAttribute[id,displayName,valueType,optionSet[id,options[code,displayName]]]],` +
    `programStages[id,displayName,programStageDataElements[dataElement[id,displayName,valueType]]]`
  );
}

function gcMatch(list, getName, patterns, extra) {
  for (const re of patterns) {
    const m = list.find(item => re.test(getName(item)) && (!extra || extra(item)));
    if (m) return m;
  }
  return null;
}

async function growthChartConfigure(args) {
  const programId = args.program_id;
  if (!programId) return { _error: 'program_id is required for configure.' };
  const prog = await gcFetchProgram(programId);
  if (prog?._error) return { _error: `Could not load program ${programId}: ${prog._error}`, _hint: 'Pass a valid tracker program UID.' };
  if (prog.programType !== 'WITH_REGISTRATION') {
    return { _error: `Program "${prog.displayName}" is not a tracker (WITH_REGISTRATION) program. The growth chart plugin only works on tracker programs.` };
  }

  const teas = (prog.programTrackedEntityAttributes || []).map(p => p.trackedEntityAttribute).filter(Boolean);
  const teaName = t => t.displayName || '';
  const ov = args.attribute_ids || {};
  const byId = (id) => teas.find(t => t.id === id);

  // ── Attribute detection (explicit override wins) ──
  const dobTea = (ov.dateOfBirth && byId(ov.dateOfBirth))
    || gcMatch(teas, teaName, [/date\s*of\s*birth/i, /\bdob\b/i, /\bbirth\s*date\b/i, /\bbirth\b/i], t => t.valueType === 'DATE');
  const genderTea = (ov.gender && byId(ov.gender))
    || gcMatch(teas, teaName, [/\bgender\b/i, /\bsex\b/i], t => !!t.optionSet);
  const firstNameTea = (ov.firstName && byId(ov.firstName))
    || gcMatch(teas, teaName, [/first\s*name/i, /given\s*name/i]);
  const lastNameTea = (ov.lastName && byId(ov.lastName))
    || gcMatch(teas, teaName, [/last\s*name/i, /surname/i, /family\s*name/i]);

  // ── Stage + data-element detection ──
  const stages = prog.programStages || [];
  let stage = args.program_stage_id ? stages.find(s => s.id === args.program_stage_id) : null;
  if (args.program_stage_id && !stage) {
    return { _error: `Program stage ${args.program_stage_id} is not part of program ${programId}.` };
  }
  const deOv = args.data_element_ids || {};
  const detectInStage = (s) => {
    const des = (s.programStageDataElements || []).map(p => p.dataElement).filter(Boolean);
    const dn = d => d.displayName || '';
    const weight = (deOv.weight && des.find(d => d.id === deOv.weight)) || gcMatch(des, dn, [/\bweight\b/i, /\bwt\b/i]);
    const height = (deOv.height && des.find(d => d.id === deOv.height)) || gcMatch(des, dn, [/\bheight\b/i, /\blength\b/i, /\bstature\b/i]);
    const headCircumference = (deOv.headCircumference && des.find(d => d.id === deOv.headCircumference)) || gcMatch(des, dn, [/head\s*circ/i, /circumference/i, /\bhc\b/i]);
    return { weight, height, headCircumference, count: [weight, height, headCircumference].filter(Boolean).length };
  };
  let de;
  if (stage) {
    de = detectInStage(stage);
  } else {
    // pick the stage that contains the most of the three measurements
    let best = null;
    for (const s of stages) {
      const d = detectInStage(s);
      if (!best || d.count > best.de.count) best = { stage: s, de: d };
    }
    if (best) { stage = best.stage; de = best.de; }
  }
  if (!stage) return { _error: `Program "${prog.displayName}" has no program stages.` };

  // ── Gender option codes ──
  const genderOptions = genderTea?.optionSet?.options || [];
  let femaleCode = args.female_option_code
    || (genderOptions.find(o => /female/i.test(o.code) || /female/i.test(o.displayName)) || {}).code;
  let maleCode = args.male_option_code
    || (genderOptions.find(o => (/male/i.test(o.code) || /male/i.test(o.displayName)) && !/female/i.test(o.code) && !/female/i.test(o.displayName)) || {}).code;

  // ── Validate hard requirements ──
  const missing = [];
  if (!dobTea) missing.push('a Date-of-birth (DATE) tracked-entity attribute');
  if (!genderTea) missing.push('a Gender/sex attribute with an option set');
  if (genderTea && (!femaleCode || !maleCode)) missing.push('female/male option codes on the gender option set (pass female_option_code / male_option_code)');
  if (!de || !de.weight) missing.push('a Weight data element on the stage');
  if (!de || !de.height) missing.push('a Height/Length data element on the stage');
  if (!de || !de.headCircumference) missing.push('a Head-circumference data element on the stage');
  if (missing.length) {
    return {
      _error: `Program "${prog.displayName}" is missing required growth-chart metadata: ${missing.join('; ')}.`,
      _hint: 'The plugin will not render unless all three data elements (weight, height, head circumference) and the date-of-birth + gender attributes exist. Pass explicit ids via attribute_ids / data_element_ids, or run action="scaffold_program" to create a ready-to-use program.',
      detected: {
        dateOfBirth: dobTea ? { id: dobTea.id, name: dobTea.displayName } : null,
        gender: genderTea ? { id: genderTea.id, name: genderTea.displayName, femaleCode, maleCode } : null,
        stage: stage ? { id: stage.id, name: stage.displayName } : null,
        weight: de?.weight ? { id: de.weight.id, name: de.weight.displayName } : null,
        height: de?.height ? { id: de.height.id, name: de.height.displayName } : null,
        headCircumference: de?.headCircumference ? { id: de.headCircumference.id, name: de.headCircumference.displayName } : null,
      },
    };
  }

  // weightInGrams: explicit setting wins, else infer from the weight DE name.
  const weightName = de.weight.displayName || '';
  const inferGrams = /\(\s*g\s*\)|gram/i.test(weightName) && !/\(\s*kg\s*\)|kilogram/i.test(weightName);
  const settingsIn = isPlainObject(args.settings) ? args.settings : {};
  if (settingsIn.defaultIndicator && !GROWTH_CHART_INDICATORS.has(settingsIn.defaultIndicator)) {
    return { _error: `Invalid defaultIndicator "${settingsIn.defaultIndicator}". One of: ${[...GROWTH_CHART_INDICATORS].join(', ')}.` };
  }

  // ── Merge into existing config (preserve other programs + settings) ──
  const cfgRead = await gcReadConfig();
  if (cfgRead._error) return cfgRead;
  const existing = cfgRead.value || {};
  const existingMeta = isPlainObject(existing.metadata) ? existing.metadata : {};
  const existingStages = isPlainObject(existingMeta.programStageForGrowthChart) ? existingMeta.programStageForGrowthChart : {};
  const existingSettings = isPlainObject(existing.settings) ? existing.settings : {};

  const config = {
    ...existing,
    metadata: {
      ...existingMeta,
      attributes: {
        dateOfBirth: dobTea.id,
        gender: genderTea.id,
        firstName: firstNameTea ? firstNameTea.id : (existingMeta.attributes?.firstName || ''),
        lastName: lastNameTea ? lastNameTea.id : (existingMeta.attributes?.lastName || ''),
        femaleOptionCode: femaleCode,
        maleOptionCode: maleCode,
      },
      dataElements: {
        weight: de.weight.id,
        height: de.height.id,
        headCircumference: de.headCircumference.id,
      },
      programStageForGrowthChart: { ...existingStages, [programId]: stage.id },
    },
    settings: {
      usePercentiles: false,
      customReferences: false,
      weightInGrams: inferGrams,
      defaultIndicator: 'wfa',
      ...existingSettings,
      ...settingsIn,
    },
  };
  if (settingsIn.weightInGrams === undefined && existingSettings.weightInGrams === undefined) {
    config.settings.weightInGrams = inferGrams;
  }

  const wrote = await gcWriteConfig(config);
  if (wrote._error) return wrote;

  const appStatus = await gcAppStatus();
  const hints = [];
  if (appStatus.installed === false) hints.push('The Capture Growth Chart app is NOT installed yet — run action="install" (or install it via App Management) or the dashboard widget cannot load.');
  if (!firstNameTea || !lastNameTea) hints.push('First/last name attributes were not found; they are optional (used for printed charts) so configuration still proceeded.');

  return {
    success: true,
    program: { id: prog.id, name: prog.displayName },
    stage: { id: stage.id, name: stage.displayName },
    resolved: {
      attributes: config.metadata.attributes,
      dataElements: config.metadata.dataElements,
    },
    settings: config.settings,
    config_key: `${GROWTH_CHART_NS}/${GROWTH_CHART_KEY}`,
    plugin_installed: appStatus.installed,
    dashboard_attach: gcDashboardAttachBlock(appStatus.plugin_launch_url, programId),
    _hints: hints.length ? hints : undefined,
  };
}

async function growthChartScaffoldProgram(args) {
  const ouId = args.org_unit_id;
  if (!ouId) return { _error: 'org_unit_id is required for scaffold_program (the org unit the new program is assigned to).' };
  const ouCheck = await safeDhis2Fetch(`organisationUnits/${ouId}?fields=id,displayName`);
  if (ouCheck?._error) return { _error: `Org unit ${ouId} not found: ${ouCheck._error}` };
  const progName = (args.program_name && String(args.program_name).trim()) || 'Growth Monitoring';

  // default categoryCombo
  const ccResp = await safeDhis2Fetch('categoryCombos?fields=id&filter=isDefault:eq:true&paging=false');
  const defaultCC = ccResp?.categoryCombos?.[0]?.id || 'bjDvmb4bfuf';

  // Person TET — reuse if present, else create.
  const tetResp = await safeDhis2Fetch('trackedEntityTypes?fields=id,displayName&paging=false');
  let personTetId = (tetResp?.trackedEntityTypes || []).find(t => /person/i.test(t.displayName || ''))?.id;
  const newObjs = { trackedEntityTypes: [], trackedEntityAttributes: [], optionSets: [], options: [], dataElements: [], programs: [], programStages: [] };
  if (!personTetId) {
    personTetId = generateDhis2Uid();
    newObjs.trackedEntityTypes.push({ id: personTetId, name: `Person (${progName})`, sharing: { public: 'rwrw----' } });
  }

  // Reuse standard demo attributes by exact name when present, else create.
  const wantTeas = [
    { role: 'firstName', name: 'First name', valueType: 'TEXT' },
    { role: 'lastName', name: 'Last name', valueType: 'TEXT' },
    { role: 'gender', name: 'Gender', valueType: 'TEXT', withOptionSet: true },
    { role: 'dateOfBirth', name: 'Date of birth', valueType: 'DATE' },
  ];
  const teaResp = await safeDhis2Fetch(
    `trackedEntityAttributes?fields=id,displayName,valueType,optionSet[id,options[code,displayName]]&paging=false&filter=displayName:in:[${wantTeas.map(t => t.name).join(',')}]`
  );
  // Probe failure ≠ "none exist" — creating blindly would duplicate the demo TEAs.
  if (teaResp?._error) {
    return { _error: `Could not check for existing attributes (${teaResp._error}). Aborting BEFORE creating anything to avoid duplicates. Nothing was changed — verify connectivity and retry.` };
  }
  const foundTeas = teaResp?.trackedEntityAttributes || [];
  const teaIds = {};
  let optionSetId = null, femaleCode = 'Female', maleCode = 'Male';
  for (const want of wantTeas) {
    const hit = foundTeas.find(t => (t.displayName || '').toLowerCase() === want.name.toLowerCase() && t.valueType === want.valueType);
    if (hit) {
      teaIds[want.role] = hit.id;
      if (want.role === 'gender' && hit.optionSet?.options?.length) {
        femaleCode = (hit.optionSet.options.find(o => /female/i.test(o.code) || /female/i.test(o.displayName)) || {}).code || femaleCode;
        maleCode = (hit.optionSet.options.find(o => (/male/i.test(o.code) || /male/i.test(o.displayName)) && !/female/i.test(o.code) && !/female/i.test(o.displayName)) || {}).code || maleCode;
      }
      continue;
    }
    const id = generateDhis2Uid();
    teaIds[want.role] = id;
    const tea = { id, name: `${progName}: ${want.name}`, shortName: `${want.name}`.slice(0, 50), valueType: want.valueType, aggregationType: 'NONE', sharing: { public: 'rwrw----' } };
    if (want.withOptionSet) {
      optionSetId = generateDhis2Uid();
      const femaleId = generateDhis2Uid(), maleId = generateDhis2Uid();
      newObjs.optionSets.push({ id: optionSetId, name: `${progName}: Sex`, valueType: 'TEXT', options: [{ id: maleId }, { id: femaleId }] });
      newObjs.options.push({ id: maleId, name: 'Male', code: 'Male', optionSet: { id: optionSetId }, sortOrder: 1 });
      newObjs.options.push({ id: femaleId, name: 'Female', code: 'Female', optionSet: { id: optionSetId }, sortOrder: 2 });
      tea.optionSet = { id: optionSetId };
      femaleCode = 'Female'; maleCode = 'Male';
    }
    newObjs.trackedEntityAttributes.push(tea);
  }

  // Three fresh measurement data elements (names prefixed to avoid collisions).
  const deDefs = [
    { role: 'weight', label: 'Weight (kg)' },
    { role: 'height', label: 'Height (cm)' },
    { role: 'headCircumference', label: 'Head circumference (cm)' },
  ];
  const deIds = {};
  for (const d of deDefs) {
    const id = generateDhis2Uid();
    deIds[d.role] = id;
    newObjs.dataElements.push({ id, name: `${progName}: ${d.label}`, shortName: `${d.label}`.slice(0, 50), valueType: 'NUMBER', domainType: 'TRACKER', aggregationType: 'AVERAGE', categoryCombo: { id: defaultCC }, sharing: { public: 'rw------' } });
  }

  const programId = generateDhis2Uid();
  const stageId = generateDhis2Uid();
  newObjs.programs.push({
    id: programId, name: progName, shortName: progName.slice(0, 50), programType: 'WITH_REGISTRATION',
    trackedEntityType: { id: personTetId }, categoryCombo: { id: defaultCC }, sharing: { public: 'rwrw----' },
    organisationUnits: [{ id: ouId }],
    programTrackedEntityAttributes: [
      { trackedEntityAttribute: { id: teaIds.firstName }, displayInList: true, searchable: true },
      { trackedEntityAttribute: { id: teaIds.lastName }, displayInList: true, searchable: true },
      { trackedEntityAttribute: { id: teaIds.gender }, mandatory: true },
      { trackedEntityAttribute: { id: teaIds.dateOfBirth }, mandatory: true },
    ],
    programStages: [{ id: stageId }],
  });
  newObjs.programStages.push({
    id: stageId, name: 'Growth measurements', program: { id: programId }, repeatable: true, sharing: { public: 'rwrw----' },
    programStageDataElements: [
      { dataElement: { id: deIds.weight } },
      { dataElement: { id: deIds.height } },
      { dataElement: { id: deIds.headCircumference } },
    ],
  });

  // Strip empty buckets so the importer doesn't choke.
  const payload = {};
  for (const [k, v] of Object.entries(newObjs)) if (v.length) payload[k] = v;

  const imp = await safeDhis2Fetch('metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=ALL', { method: 'POST', body: payload });
  const resp = imp?.response || imp;
  if (resp?.status === 'ERROR' || imp?._error) {
    const errs = (resp?.typeReports || []).flatMap(t => (t.objectReports || []).flatMap(o => (o.errorReports || []).map(e => `${(t.klass || '').split('.').pop()}: ${e.message}`)));
    return { _error: `Could not create the growth-monitoring program: ${imp?._error || 'import failed'}`, import_errors: errs.slice(0, 8) };
  }

  return {
    success: true,
    created_program: { id: programId, name: progName, stage_id: stageId },
    org_unit: { id: ouId, name: ouCheck.displayName },
    attributes: teaIds,
    data_elements: deIds,
    gender_codes: { femaleCode, maleCode },
    import_stats: resp?.stats,
    _next: `Now run action="configure" with program_id="${programId}" to write captureGrowthChart/config. Then run action="install" if the plugin app isn't installed.`,
  };
}

async function growthChartRemove(args) {
  const programId = args.program_id;
  const cfgRead = await gcReadConfig();
  if (cfgRead._error) return cfgRead;
  if (!cfgRead.exists) return { success: true, removed: false, _note: 'No captureGrowthChart/config key exists.' };

  if (!programId) {
    if (args.confirm_delete_all !== true) {
      return { _error: 'remove without program_id deletes the ENTIRE captureGrowthChart/config. Re-run with confirm_delete_all:true to proceed, or pass program_id to remove just one program.' };
    }
    const del = await safeDhis2Fetch(gcPath(GROWTH_CHART_KEY), { method: 'DELETE' });
    if (del?._error && del?._status !== 404) return { _error: `Could not delete config: ${del._error}` };
    return { success: true, removed_all: true, previous_value: cfgRead.value };
  }

  const cfg = cfgRead.value || {};
  const map = cfg.metadata?.programStageForGrowthChart || {};
  if (!(programId in map)) {
    return { success: true, removed: false, _note: `Program ${programId} is not in the growth-chart config.`, configured_programs: Object.keys(map) };
  }
  const previous = JSON.parse(JSON.stringify(cfg));
  delete map[programId];
  cfg.metadata.programStageForGrowthChart = map;
  const wrote = await gcWriteConfig(cfg);
  if (wrote._error) return wrote;
  return { success: true, removed_program: programId, remaining_programs: Object.keys(map), previous_value: previous };
}

async function growthChartStatus() {
  const app = await gcAppStatus();
  const cfgRead = await gcReadConfig();
  if (cfgRead._error) return cfgRead;
  const cfg = cfgRead.value;
  const programMap = cfg?.metadata?.programStageForGrowthChart || {};
  const programIds = Object.keys(programMap);
  let programs = [];
  if (programIds.length) {
    const resp = await safeDhis2Fetch(`programs?fields=id,displayName&filter=id:in:[${programIds.join(',')}]&paging=false`);
    const names = Object.fromEntries((resp?.programs || []).map(p => [p.id, p.displayName]));
    programs = programIds.map(id => ({ id, name: names[id] || '(unknown)', stage_id: programMap[id] }));
  }
  return {
    success: true,
    plugin_installed: app.installed,
    plugin_launch_url: app.plugin_launch_url || null,
    config_exists: cfgRead.exists,
    configured_programs: programs,
    settings: cfg?.settings || null,
    attributes: cfg?.metadata?.attributes || null,
    data_elements: cfg?.metadata?.dataElements || null,
    _hint: app.installed === false
      ? 'Plugin app not installed — run action="install".'
      : (!cfgRead.exists ? 'No config yet — run action="configure" with a program_id (or scaffold_program first).' : undefined),
  };
}

async function executeManageGrowthChartPlugin(args) {
  const action = args?.action;
  if (!action) return { _error: 'Missing required parameter: action', _hint: 'One of: status, install, scaffold_program, configure, remove.' };
  if (action === 'status') return await growthChartStatus();
  if (action === 'install') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'install', {});
    if (gate) return gate;
    return await gcInstall();
  }
  if (action === 'scaffold_program') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'scaffold_program', { org_unit_id: args.org_unit_id });
    if (gate) return gate;
    return await growthChartScaffoldProgram(args);
  }
  if (action === 'configure') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'configure', { program_id: args.program_id });
    if (gate) return gate;
    return await growthChartConfigure(args);
  }
  if (action === 'remove') {
    const gate = requireWriteAuth('manage_growth_chart_plugin', 'remove', { program_id: args.program_id });
    if (gate) return gate;
    return await growthChartRemove(args);
  }
  return { _error: `Unknown manage_growth_chart_plugin action: ${action}`, _hint: 'One of: status, install, scaffold_program, configure, remove.' };
}

async function postMetadataPayload(payload, dryRunOnly) {
  // Helper: extract errors from DHIS2 import response typeReports
  function extractErrors(resp) {
    const typeReports = resp?.typeReports || resp?.response?.typeReports || [];
    const errors = [];
    for (const tr of typeReports) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) {
          errors.push(`${tr.klass?.split('.')?.pop() || 'Object'}: ${er.message}`);
        }
      }
    }
    return errors;
  }

  // Detect shortName conflicts in DHIS2 validation/import errors and
  // auto-suffix the offending object so the next retry succeeds. Handles
  // both the typed validation form ("Property `shortName` with value `X`")
  // and the raw Postgres form ("Key (shortname)=(X) already exists"). Returns
  // true when at least one object was patched in-place. The caller can then
  // re-POST without bothering the user.
  function tryAutofixShortNameConflicts(errorMessages) {
    if (!Array.isArray(errorMessages) || !errorMessages.length) return false;
    const conflictValues = new Set();
    for (const msg of errorMessages) {
      const text = String(msg || '');
      // "Property `shortName` with value `Patient Name` already exists"
      let m = text.match(/Property\s+`?shortName`?\s+with value\s+`([^`]+)`/i);
      if (m) { conflictValues.add(m[1]); continue; }
      // "Key (shortname)=(Patient Name) already exists"
      m = text.match(/\(shortname\)=\(([^)]+)\)/i);
      if (m) { conflictValues.add(m[1]); continue; }
      // Some DHIS2 versions use plain quotes
      m = text.match(/shortName\s+["']([^"']+)["']\s+(?:already|is)/i);
      if (m) { conflictValues.add(m[1]); continue; }
    }
    if (conflictValues.size === 0) return false;

    let patched = false;
    const objectArrays = [
      'dataElements', 'trackedEntityAttributes', 'programIndicators',
      'programs', 'programStages', 'optionSets', 'options', 'indicators',
    ];
    for (const key of objectArrays) {
      const arr = payload[key];
      if (!Array.isArray(arr)) continue;
      for (const obj of arr) {
        if (obj && obj.shortName && conflictValues.has(obj.shortName)) {
          const base = obj.shortName.slice(0, 45).replace(/\s+$/, '');
          obj.shortName = `${base} ${generateDhis2Uid().slice(-4)}`;
          patched = true;
        }
      }
    }
    return patched;
  }

  // ── NAME-conflict self-healing ──────────────────────────────────────────────
  // DHIS2 name uniqueness errors carry BOTH UIDs:
  //   "Property `name` with value `Sex` on object Sex [kzqq7s1sirO]
  //    (TrackedEntityAttribute) already exists on object WCffUc0Cp2j"
  // For classes where same-name means same-thing (TEA, DE, option set, TET,
  // category objects) the ONLY correct move is to REUSE the existing object:
  // drop our would-be duplicate from the payload and rewrite every reference
  // from our pre-generated UID to the existing one, then retry. Never let the
  // model "fix" this by inventing a name variant — that creates near-duplicate
  // metadata. For classes whose name is unique but instance-specific
  // (ProgramStage, ProgramIndicator) reuse would hijack another program's
  // object, so those get a rename-with-suffix instead (mirrors the pre-probe
  // convention). The duplicate object is REMOVED, not imported as an update —
  // importing it would overwrite the existing object's fields (optionSet,
  // description, unique flag, …) with our minimal stub.
  const REUSE_ON_NAME_CONFLICT = new Set([
    'TrackedEntityAttribute', 'DataElement', 'OptionSet', 'TrackedEntityType',
    'CategoryOption', 'Category', 'CategoryCombo',
  ]);
  const RENAME_ON_NAME_CONFLICT = new Set(['ProgramStage', 'ProgramIndicator']);
  const nameConflictRemaps = [];  // [{klass, name, from, to}] — deduped → reused existing UID
  const nameConflictRenames = []; // [{klass, from, to, id}]  — renamed to dodge unique name
  function remapUidInPayload(fromUid, toUid) {
    const walk = (node) => {
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          if (node[k] === fromUid) node[k] = toUid;
          else walk(node[k]);
        }
      }
    };
    walk(payload);
  }
  function tryAutofixNameConflicts(errorMessages) {
    if (!Array.isArray(errorMessages) || !errorMessages.length) return false;
    let patched = false;
    for (const msg of errorMessages) {
      const m = String(msg || '').match(
        /Property\s+`name`\s+with value\s+`([^`]*)`\s+on object .*?\[([A-Za-z][A-Za-z0-9]{10})\]\s+\((\w+)\)\s+already exists on object\s+([A-Za-z][A-Za-z0-9]{10})/i
      );
      if (!m) continue;
      const [, dupName, newUid, klass, existingUid] = m;
      if (newUid === existingUid) continue;
      if (REUSE_ON_NAME_CONFLICT.has(klass)) {
        for (const key of Object.keys(payload)) {
          if (Array.isArray(payload[key])) payload[key] = payload[key].filter(o => !(o && o.id === newUid));
        }
        remapUidInPayload(newUid, existingUid);
        nameConflictRemaps.push({ klass, name: dupName, from: newUid, to: existingUid });
        patched = true;
      } else if (RENAME_ON_NAME_CONFLICT.has(klass)) {
        for (const key of Object.keys(payload)) {
          if (!Array.isArray(payload[key])) continue;
          for (const o of payload[key]) {
            if (o && o.id === newUid && o.name) {
              const renamed = `${String(o.name).slice(0, 225).replace(/\s+$/, '')} ${generateDhis2Uid().slice(-4)}`;
              nameConflictRenames.push({ klass, from: o.name, to: renamed, id: newUid });
              o.name = renamed;
              patched = true;
            }
          }
        }
      }
    }
    return patched;
  }
  // Recovery summary attached to every return so callers (and the model) see
  // that duplicates were auto-reused, and can sync their name→ID maps.
  const recoveryInfo = () => ({
    ...(nameConflictRemaps.length ? {
      _name_conflict_remaps: nameConflictRemaps,
      _recovery_note: `Auto-reused ${nameConflictRemaps.length} object(s) that ALREADY EXISTED on the server by name instead of creating duplicates: ${nameConflictRemaps.map(r => `${r.klass} "${r.name}" → ${r.to}`).join(', ')}.`,
    } : {}),
    ...(nameConflictRenames.length ? { _name_conflict_renames: nameConflictRenames } : {}),
  });

  // Helper: check if response indicates failure (HTTP error OR status=ERROR)
  function isResponseError(resp) {
    if (!resp) return 'Empty response from DHIS2';
    if (resp._error) return resp._error;
    const status = resp?.status || resp?.response?.status;
    if (status === 'ERROR') {
      const msg = resp?.message || resp?.response?.message || 'Unknown error';
      return `DHIS2 import status ERROR: ${msg}`;
    }
    return null;
  }

  // Dry-run validation
  let validateResp = await safeDhis2Fetch('metadata?importMode=VALIDATE&atomicMode=ALL', {
    method: 'POST',
    body: payload,
  });

  // Check for HTTP-level or status-level errors
  let validateError = isResponseError(validateResp);
  if (validateError) {
    // Extract detailed errors from the response body (e.g., 409 responses contain typeReports)
    const detailedErrors = validateResp._body ? extractErrors(validateResp._body) : [];
    const allErrors = detailedErrors.length > 0 ? detailedErrors : [validateError];
    // Defense-in-depth: auto-fix shortName + name conflicts and revalidate once.
    const fixedShort = tryAutofixShortNameConflicts(allErrors);
    const fixedName = tryAutofixNameConflicts(allErrors);
    if (fixedShort || fixedName) {
      validateResp = await safeDhis2Fetch('metadata?importMode=VALIDATE&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      validateError = isResponseError(validateResp);
    }
    if (validateError) {
      const detailedErrors2 = validateResp._body ? extractErrors(validateResp._body) : [];
      const errorMsg = detailedErrors2.length > 0
        ? `Validation failed with ${detailedErrors2.length} error(s): ${detailedErrors2.slice(0, 5).join('; ')}`
        : `Validation failed: ${validateError}`;
      return { success: false, _error: errorMsg, phase: 'validation', errors: detailedErrors2.length > 0 ? detailedErrors2 : [validateError], ...recoveryInfo() };
    }
  }

  let stats = validateResp?.stats || validateResp?.response?.stats || {};
  let errors = extractErrors(validateResp);

  if (errors.length > 0) {
    // Auto-fix shortName + name conflicts and revalidate once before failing.
    const fixedShort = tryAutofixShortNameConflicts(errors);
    const fixedName = tryAutofixNameConflicts(errors);
    if (fixedShort || fixedName) {
      validateResp = await safeDhis2Fetch('metadata?importMode=VALIDATE&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      stats = validateResp?.stats || validateResp?.response?.stats || {};
      errors = extractErrors(validateResp);
    }
    if (errors.length > 0) {
      return { success: false, _error: `Validation failed with ${errors.length} error(s): ${errors[0]}`, phase: 'validation', errors, stats, ...recoveryInfo() };
    }
  }

  if (dryRunOnly) {
    return { success: true, phase: 'dry_run', message: 'Validation passed. No import performed (dry_run_only=true).', stats, ...recoveryInfo() };
  }

  // Actual import
  let importResp = await safeDhis2Fetch('metadata?importMode=COMMIT&atomicMode=ALL', {
    method: 'POST',
    body: payload,
  });

  // Check for HTTP-level or status-level errors
  let importError = isResponseError(importResp);
  if (importError) {
    const detailedImportErrors = importResp._body ? extractErrors(importResp._body) : [];
    const allImportErrors = detailedImportErrors.length > 0 ? detailedImportErrors : [importError];
    // Defense-in-depth for the rare race-condition shortName/name conflict that
    // slipped past pre-probe (another import committed between our probe
    // and our COMMIT). Auto-suffix / auto-reuse and retry once.
    const fixedShort = tryAutofixShortNameConflicts(allImportErrors);
    const fixedName = tryAutofixNameConflicts(allImportErrors);
    if (fixedShort || fixedName) {
      importResp = await safeDhis2Fetch('metadata?importMode=COMMIT&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      importError = isResponseError(importResp);
    }
    if (importError) {
      const detailedImportErrors2 = importResp._body ? extractErrors(importResp._body) : [];
      const importErrMsg = detailedImportErrors2.length > 0
        ? `Import failed with ${detailedImportErrors2.length} error(s): ${detailedImportErrors2.slice(0, 5).join('; ')}`
        : `Import failed: ${importError}`;
      return { success: false, _error: importErrMsg, phase: 'import', errors: detailedImportErrors2.length > 0 ? detailedImportErrors2 : [importError], ...recoveryInfo() };
    }
  }

  let importStats = importResp?.stats || importResp?.response?.stats || {};
  let importErrors = extractErrors(importResp);

  if (importErrors.length > 0) {
    const fixedShort = tryAutofixShortNameConflicts(importErrors);
    const fixedName = tryAutofixNameConflicts(importErrors);
    if (fixedShort || fixedName) {
      importResp = await safeDhis2Fetch('metadata?importMode=COMMIT&atomicMode=ALL', {
        method: 'POST',
        body: payload,
      });
      importStats = importResp?.stats || importResp?.response?.stats || {};
      importErrors = extractErrors(importResp);
    }
    if (importErrors.length > 0) {
      return { success: false, _error: `Import failed with ${importErrors.length} error(s): ${importErrors[0]}`, phase: 'import', errors: importErrors, stats: importStats, ...recoveryInfo() };
    }
  }

  // Final sanity check: ensure something was actually created/updated
  const created = importStats.created || 0;
  const updated = importStats.updated || 0;
  if (created === 0 && updated === 0 && (importStats.ignored || 0) > 0) {
    return { success: false, _error: `Import completed but all ${importStats.ignored} objects were ignored. Check for duplicate names or missing references.`, phase: 'import', stats: importStats, ...recoveryInfo() };
  }

  return { success: true, phase: 'import', stats: importStats, ...recoveryInfo() };
}

// ── create_program input pre-validation (client-side, ZERO API calls) ────────
// The atomic /metadata import rejects the WHOLE program if any object is missing
// a required `name`/`value_type`, coming back as "Validation failed with N
// error(s): TrackedEntityAttribute: Missing required property `name`; …" — and
// NOTHING is created. Weak models routinely emit such payloads (empty
// placeholders, or a truncated giant call), and the raw 304 avalanche burned the
// HTTP-error budget (an empty `name` even 500s the dedup `ilike:` probe) and fed
// the circuit breaker until the tool was disabled and the turn dead-looped
// (real 2026-07-14 session). This pass runs BEFORE any network call and:
//   • auto-heals cosmetic gaps — a rule with no name gets a generated one, an
//     inline option set with no name inherits its field's name;
//   • collects the gaps DHIS2 would reject and cannot be safely inferred (a
//     data element / attribute with no name, a new one with no value_type, an
//     option set with no options) into ONE precise, cheap error;
//   • flags a payload that is mostly-empty as truncated, steering the model to
//     re-send the COMPLETE call rather than guess at 150 nameless objects.
// The returned error carries `_scope:'incomplete_call'` + `_no_disable:true` so
// the agent loop treats it as "your input was incomplete, resend it" — it never
// counts toward disabling create_metadata (a well-formed retry must stay open).
function validateAndHealProgramInput(args) {
  const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
  const issues = [];               // hard, un-inferable gaps → block (cheaply)
  const heals = [];                // cosmetic gaps auto-filled → note only
  let nameRequiredTotal = 0;       // denominator for the truncation heuristic
  let nameMissingCount = 0;

  const attrs = Array.isArray(args.program_attributes) ? args.program_attributes : [];
  attrs.forEach((a, i) => {
    if (!a || typeof a !== 'object') { issues.push(`program_attributes[${i}] is not an object`); return; }
    if (nonEmpty(a.id)) return;    // reusing an existing TEA by UID — name/type not required
    nameRequiredTotal++;
    if (!nonEmpty(a.name)) { nameMissingCount++; issues.push(`program_attributes[${i}] is missing a name`); return; }
    if (!nonEmpty(a.value_type)) issues.push(`attribute "${a.name}" is missing value_type (e.g. TEXT, NUMBER, DATE, BOOLEAN)`);
    if (a.option_set && typeof a.option_set === 'object') {
      if (!nonEmpty(a.option_set.name)) { a.option_set.name = a.name; heals.push(`named the option set for attribute "${a.name}"`); }
      if (!Array.isArray(a.option_set.options) || !a.option_set.options.filter(nonEmpty).length) issues.push(`option set for attribute "${a.name}" has no options`);
    }
  });

  const stages = Array.isArray(args.stages) ? args.stages : [];
  stages.forEach((s, si) => {
    if (!s || typeof s !== 'object') { issues.push(`stages[${si}] is not an object`); return; }
    nameRequiredTotal++;
    const sName = nonEmpty(s.name) ? s.name : `stages[${si}]`;
    if (!nonEmpty(s.name)) { nameMissingCount++; issues.push(`stages[${si}] is missing a name`); }
    const des = Array.isArray(s.data_elements) ? s.data_elements : [];
    des.forEach((d, di) => {
      if (!d || typeof d !== 'object') { issues.push(`stage "${sName}" data_elements[${di}] is not an object`); return; }
      nameRequiredTotal++;
      if (!nonEmpty(d.name)) { nameMissingCount++; issues.push(`stage "${sName}" data_elements[${di}] is missing a name`); return; }
      if (!nonEmpty(d.value_type)) issues.push(`data element "${d.name}" (stage "${sName}") is missing value_type (e.g. TEXT, NUMBER, DATE, BOOLEAN)`);
      if (d.option_set && typeof d.option_set === 'object') {
        if (!nonEmpty(d.option_set.name)) { d.option_set.name = d.name; heals.push(`named the option set for data element "${d.name}"`); }
        if (!Array.isArray(d.option_set.options) || !d.option_set.options.filter(nonEmpty).length) issues.push(`option set for data element "${d.name}" has no options`);
      }
    });
  });

  // Rules: a missing name is cosmetic (a rule's identity is its condition +
  // actions) — generate one so it never bounces the import. A rule with no
  // condition or no actions is left for the existing skip-and-report path.
  const rules = Array.isArray(args.program_rules) ? args.program_rules : [];
  const usedRuleNames = new Set(rules.filter(r => r && nonEmpty(r.name)).map(r => r.name.trim().toLowerCase()));
  const rulePrefix = (nonEmpty(args.program_short_name) ? args.program_short_name.trim() : (args.program_name || 'Program').trim());
  rules.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    if (nonEmpty(r.name)) return;
    let base = '';
    const act = Array.isArray(r.actions) && r.actions[0] ? r.actions[0] : null;
    const target = act && (act.data_element_name || act.tracked_entity_attribute_name || act.program_stage_name);
    if (act && nonEmpty(act.type)) base = `${rulePrefix} ${act.type}${nonEmpty(target) ? ' ' + target : ''}`;
    let candidate = nonEmpty(base) ? base : `${rulePrefix} rule ${i + 1}`;
    let n = candidate;
    let k = 2;
    while (usedRuleNames.has(n.trim().toLowerCase())) { n = `${candidate} ${k++}`; }
    r.name = n.substring(0, 230);
    usedRuleNames.add(r.name.trim().toLowerCase());
    heals.push(`auto-named an unnamed program rule → "${r.name}"`);
  });

  if (!issues.length) return { heals };

  // Mostly-empty payload → almost always a truncated/garbled giant call. Say so
  // plainly instead of dumping 150 near-identical "missing name" lines.
  const truncated = nameRequiredTotal >= 4 && (nameMissingCount / nameRequiredTotal) >= 0.25 || nameMissingCount >= 8;
  const shown = issues.slice(0, 12);
  const more = issues.length - shown.length;
  const error = truncated
    ? `create_program input looks incomplete/truncated — ${nameMissingCount} of ${nameRequiredTotal} objects that need a name are missing one (e.g. ${shown.slice(0, 3).join('; ')}${issues.length > 3 ? '; …' : ''}). NOTHING was created.`
    : `create_program input is missing ${issues.length} required field(s): ${shown.join('; ')}${more > 0 ? `; …and ${more} more` : ''}. NOTHING was created.`;
  return {
    heals,
    error: {
      success: false,
      nothing_created: true,
      phase: 'input_validation',
      _error: error,
      _hint: truncated
        ? 'Your create_program arguments arrived incomplete — likely the tool-call JSON was truncated. Re-send the COMPLETE create_program call with every attribute/stage/data element carrying its name and value_type. This is a client-side check: NO API call was made, nothing was created, and this does NOT count against the tool — a well-formed retry is expected.'
        : 'Add the missing name/value_type/options field(s) listed above (each object needs a non-empty name; every NEW data element/attribute needs a value_type; every inline option set needs options), then re-issue the WHOLE create_program call. This was caught client-side with NO API call — nothing was created and the tool remains fully available for your corrected retry.',
      _scope: 'incomplete_call',
      _no_disable: true,
    },
  };
}

async function createFullProgram(args, defaultCatComboId, contextOrgUnitId) {
  if (!args.program_name) return { _error: 'Missing program_name for create_program' };

  // Pre-validate + heal the payload BEFORE any network call: turns the atomic
  // "Missing required property `name`" 304 avalanche into one cheap, precise,
  // non-disabling error (see validateAndHealProgramInput).
  {
    const pre = validateAndHealProgramInput(args);
    if (pre.error) return pre.error;
    if (pre.heals && pre.heals.length) args._input_heals = pre.heals;
  }

  // Default program_type to WITH_REGISTRATION (tracker) if not specified
  const programType = args.program_type || 'WITH_REGISTRATION';
  const isTracker = programType === 'WITH_REGISTRATION';

  // ── Program name collision resolution ───────────────────────────────────────
  // DHIS2 enforces UNIQUE on Program.name. If a program with the requested name
  // already exists, fail fast with a clear, actionable error rather than letting
  // the DB throw "duplicate key value violates unique constraint".
  //
  // Re-sync against the active tab BEFORE the probe — without this, dhis2.baseUrl
  // can lag behind the user's actual server (cross-server tab switch, fresh tab
  // open) and the probe hits the prior instance, returning that server's UID
  // and producing the "already exists" false-positive across instances.
  await ensureConnected();
  const probeServer = dhis2.baseUrl;
  const progProbe = await safeDhis2Fetch(
    `programs?filter=name:eq:${encodeURIComponent(args.program_name)}&fields=id,name,programType&pageSize=1`
  );
  if (progProbe?.programs?.length) {
    const existing = progProbe.programs[0];

    // Idempotent replay: if this exact program was created earlier in THIS turn
    // (LLM retried the same tool call after a successful run), return the prior
    // success summary instead of an "already exists" error. Without this guard
    // the user sees a confusing "Failed: already exists on play.im.dhis2..."
    // even though the program was created seconds earlier by the same chain.
    // Real cross-server / pre-existing collisions still error: their id is NOT
    // in dhis2.recentCreations.
    const recent = lookupRecentCreation('program', args.program_name);
    if (recent && recent.id === existing.id) {
      return {
        success: true,
        phase: 'idempotent_replay',
        stats: { created: 0, updated: 0, ignored: 1, total: 1 },
        summary: recent.summary || { program: { id: existing.id, name: args.program_name, type: existing.programType } },
        _idempotent_replay: true,
        _idempotent_message: `Program "${args.program_name}" was already successfully created earlier in this same turn (id: ${existing.id} on ${probeServer}). Returning the previous success summary — do NOT call create_program again for this name; continue with follow-up steps or answer the user.`,
        _origin_server: probeServer,
      };
    }

    return {
      _error: `A program named "${args.program_name}" already exists on ${probeServer} (id: ${existing.id}, type: ${existing.programType}). If you expected this server to be empty, confirm the active DHIS2 tab points to the intended instance and retry. Otherwise pick a different program_name, or modify the existing one via manage_metadata / manage_program_rules / add_data_elements_to_stage against id=${existing.id}.`,
      _hint: 'This is NOT the program you just created in this turn — the id does not match anything in the per-turn creation registry. The program is pre-existing on this server. To proceed: (a) pick a different program_name, or (b) call manage_metadata / add_data_elements_to_stage / manage_program_rules against the existing program id, or (c) confirm with the user that the active DHIS2 tab points to the intended server.',
      _scope: 'program_name_collision_preexisting',
      existing_program_id: existing.id,
      _origin_server: probeServer,
    };
  }

  // Resolve tracked entity type for tracker programs. `tracked_entity_type_id`
  // is documented as a UID, but the model sometimes passes a NAME instead
  // (e.g. "Person"), or even a hallucinated UID-shaped token — either one,
  // written straight into trackedEntityType.id, makes DHIS2 bounce the WHOLE
  // atomic import with "Invalid reference [Person] (TrackedEntityType)". So we
  // VERIFY the reference resolves to a real TET on this server before it ever
  // reaches the payload, and fail fast (listing what IS available) if not.
  //
  // We fetch the full TET list once and match in JS rather than using a
  // server-side `filter=name:eq:` — that filter is case-sensitive, exact, and
  // only matches the raw `name` (not the translated `displayName`), so it
  // silently misses "person"/"Person "/instances where the type's name differs
  // from its displayName. In-memory matching is case-insensitive, checks both
  // name and displayName, and degrades from exact → contains → Person-fallback.
  let tetId = null;
  if (isTracker) {
    const rawTet = args.tracked_entity_type_id;
    const tetList = await safeDhis2Fetch('trackedEntityTypes?fields=id,name,displayName&paging=false');
    if (tetList?._error) {
      return { _error: `Could not load TrackedEntityTypes to resolve trackedEntityType: ${tetList._error}` };
    }
    const allTets = tetList?.trackedEntityTypes || [];
    const norm = (s) => String(s || '').trim().toLowerCase();

    if (rawTet && hasUidShape(rawTet)) {
      // UID-shaped → accept only if it actually exists (a hallucinated UID
      // finds no match and falls through, instead of reaching the server as an
      // invalid reference).
      const hit = allTets.find(t => t.id === rawTet);
      if (hit) tetId = hit.id;
    }
    if (!tetId && rawTet && !hasUidShape(rawTet)) {
      // Treat as a NAME — case-insensitive exact match on name/displayName,
      // then a contains match ("Person (client)" etc.).
      const want = norm(rawTet);
      const exact = allTets.find(t => norm(t.name) === want || norm(t.displayName) === want);
      const partial = exact || allTets.find(t => norm(t.name).includes(want) || norm(t.displayName).includes(want));
      if (partial) tetId = partial.id;
    }
    if (!tetId && (!rawTet || /person/i.test(String(rawTet)))) {
      // Omitted, or an unresolved "Person"-ish request → default to any Person
      // type on the instance (matches the historical omitted-default behavior).
      const person = allTets.find(t => /person/i.test(t.name || '') || /person/i.test(t.displayName || ''));
      if (person) tetId = person.id;
    }
    if (!tetId) {
      const available = allTets.map(t => `${t.displayName || t.name} (${t.id})`).join(', ') || '(none exist on this server)';
      return {
        _error: `Could not resolve a TrackedEntityType${rawTet ? ` for tracked_entity_type_id="${rawTet}"` : ''} on this server.`,
        _hint: `Do NOT guess a UID. Available TrackedEntityTypes: ${available}. Pass tracked_entity_type_id as one of those UIDs (or its exact name), or omit it to use a Person type. If none exist, create one first.`,
        _available_tracked_entity_types: allTets.map(t => ({ id: t.id, name: t.displayName || t.name })),
      };
    }
  }

  // Resolve org units — order of precedence:
  //   1. assign_all_org_units flag → fetch every OU in the instance (all levels)
  //   2. explicit org_unit_ids
  //   3. context org unit
  //   4. root OU fallback
  let orgUnitIds = [];
  if (args.assign_all_org_units) {
    // Fetch all org units in one server-side call with paging=false.
    // This is the correct way to "assign all OUs at all levels" — the model should
    // never paginate OUs manually through search_metadata/dhis2_query.
    const allOuResp = await safeDhis2Fetch('organisationUnits?fields=id&paging=false');
    if (allOuResp?._error) return { _error: `Failed to fetch all org units: ${allOuResp._error}` };
    orgUnitIds = (allOuResp?.organisationUnits || []).map(o => o.id);
    if (!orgUnitIds.length) return { _error: 'assign_all_org_units=true but server returned 0 org units.' };
  } else if (args.org_unit_ids?.length) {
    orgUnitIds = args.org_unit_ids;
  } else if (contextOrgUnitId) {
    orgUnitIds = [contextOrgUnitId];
  } else {
    const rootOuResp = await safeDhis2Fetch('organisationUnits?filter=level:eq:1&fields=id&pageSize=1');
    const rootId = rootOuResp?.organisationUnits?.[0]?.id;
    if (rootId) {
      orgUnitIds = [rootId];
    } else {
      return { _error: 'No org_unit_ids provided, no org unit in context, and could not find root org unit. Provide org_unit_ids explicitly or set assign_all_org_units=true.' };
    }
  }

  // Resolve sharing — build the sharing block that will be attached to the program
  // (and optionally to stages / DEs / option sets). Shape matches the new sharing
  // format DHIS2 expects on metadata POST: { public, external, users, userGroups }.
  // Sharing ALWAYS gets built — even when the model passes no sharing argument.
  // DHIS2's server default for new programs is metadata-only ("rw------"),
  // which means NOBODY (not even the creating admin) has data write access:
  // every enrollment/event import bounces with E1091/E1095/E1096 and Capture's
  // Save silently fails. Verified live on play 2.42.5.1 (2026-07-01): a program
  // created without a sharing block was born unusable for data entry. Default
  // to public "rwrw----" on the program + stages (the two data-shareable
  // classes) so tracker data entry works out of the box — same convention
  // manage_datasets has always used.
  const sharingInput = args.sharing || {};
  let sharingBlock = null;
  {
    // Normalize: any model-supplied access string is coerced to a canonical
    // 8-char [rw-] form here. Without this, "r--------" (9 chars) leaks into
    // program.publicAccess and DHIS2 rejects the entire atomic import.
    const defaultAccess = normalizeAccessString(sharingInput.public_access, 'rwrw----');
    const users = {};
    const userGroups = {};
    let ownerUid = null;

    if (sharingInput.include_current_user) {
      // Resolve current user once — matches the user record behind the admin session.
      const meResp = await safeDhis2Fetch('me?fields=id,username,displayName');
      if (meResp?.id) {
        users[meResp.id] = { id: meResp.id, access: 'rwrw----' };
        ownerUid = meResp.id;
      }
    }
    for (const uid of (sharingInput.user_ids || [])) {
      users[uid] = { id: uid, access: 'rwrw----' };
    }
    for (const gid of (sharingInput.user_group_ids || [])) {
      userGroups[gid] = { id: gid, access: 'rwrw----' };
    }

    sharingBlock = {
      public: defaultAccess,
      external: false,
      users,
      userGroups,
    };
    if (ownerUid) sharingBlock.owner = ownerUid;
  }
  const applySharingToChildren = !sharingInput || sharingInput.apply_to_children !== false;

  // Collect all inline option sets and data elements across stages
  const allOptions = [];
  const allOptionSets = [];
  const allDataElements = [];
  const allTrackedEntityAttributes = [];
  const optionSetUidMap = {}; // name → uid
  const optionSetOptionsByName = {}; // option set name → [{id, name, code}] as BUILT locally
  const optionSetNameByDeName = {}; // data element name → its inline option set name (for HIDEOPTION)
  const deUidMap = {}; // name → uid
  const teaUidMap = {}; // name → uid
  // Per-class shortName dedupe — DHIS2 enforces shortName uniqueness within
  // each metadata class. Two DEs with names sharing their first 50 chars
  // would otherwise collide and abort the atomic import. clampShortName
  // auto-suffixes a 4-char UID shard when a duplicate is detected.
  const seenDEShortNames = new Set();
  const seenTEAShortNames = new Set();

  const stages = args.stages || [];

  for (const stage of stages) {
    for (const de of (stage.data_elements || [])) {
      // Build inline option set if specified
      if (de.option_set && de.option_set.name && de.option_set.options?.length) {
        if (!optionSetUidMap[de.option_set.name]) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
          allOptions.push(...options);
          allOptionSets.push(optionSet);
          optionSetUidMap[de.option_set.name] = osUid;
          optionSetOptionsByName[de.option_set.name] = options.map(o => ({ id: o.id, name: o.name, code: o.code }));
        }
        optionSetNameByDeName[de.name] = de.option_set.name;
      }
      // Build data element (skip duplicates by name)
      if (!deUidMap[de.name]) {
        const { elem, uid } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames);
        allDataElements.push(elem);
        deUidMap[de.name] = uid;
      }
    }
  }

  // Collect tracked entity attributes for tracker programs
  const explicitTeaIds = []; // [{id, name}] — reused-by-UID entries, verified against the server below
  if (isTracker && args.program_attributes?.length) {
    for (const attr of args.program_attributes) {
      // Explicit reuse by UID: the attribute already exists on the server —
      // reference it as-is, create NOTHING for it.
      if (attr.id && /^[A-Za-z][A-Za-z0-9]{10}$/.test(attr.id)) {
        teaUidMap[attr.name || attr.id] = attr.id;
        explicitTeaIds.push({ id: attr.id, name: attr.name || attr.id });
        continue;
      }
      // Handle inline option set for attribute
      if (attr.option_set && attr.option_set.name && attr.option_set.options?.length) {
        if (!optionSetUidMap[attr.option_set.name]) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(attr.option_set, attr.value_type);
          allOptions.push(...options);
          allOptionSets.push(optionSet);
          optionSetUidMap[attr.option_set.name] = osUid;
          optionSetOptionsByName[attr.option_set.name] = options.map(o => ({ name: o.name, code: o.code }));
        }
      }
      // Build TEA (skip duplicates by name)
      if (!teaUidMap[attr.name]) {
        const teaUid = generateDhis2Uid();
        const tea = {
          id: teaUid,
          name: attr.name,
          shortName: clampShortName(attr.short_name, attr.name, seenTEAShortNames, 'Attribute'),
          // Explicit value_type wins; otherwise infer from the name (e.g. DOB →
          // DATE, "Age" → INTEGER) instead of silently defaulting numerics/dates
          // to TEXT. Option-set attributes stay TEXT.
          valueType: attr.value_type || (attr.option_set ? 'TEXT' : inferValueType(attr.name, 'TEXT')),
          aggregationType: 'NONE',
        };
        if (attr.option_set && optionSetUidMap[attr.option_set.name]) {
          tea.optionSet = { id: optionSetUidMap[attr.option_set.name] };
        }
        allTrackedEntityAttributes.push(tea);
        teaUidMap[attr.name] = teaUid;
      }
    }
  }

  // ── Duplicate checking: reuse existing objects by name to avoid 409 conflicts ──
  //
  // Perf note: every probe below was previously serial. For a typical program
  // (1 OS, 5 DEs, 3 TEAs, 2 stages) that was ~7 sequential round-trips before
  // we even reached validation. The restructure below is purely about
  // wall-clock — same probes, same dedup logic, but:
  //   • Step 1 (OS dedup) is one batched query instead of one-per-OS.
  //   • Steps 3 / 4 / 5 (options / DE / TEA name dedup) are independent of
  //     each other once Step 1 is done, so their batched queries fan out in
  //     parallel.
  // Capability is identical; latency drops from N RTTs to 2.

  // 1. Check option sets by name — one batched query, then remap & flag.
  const reusedOptionSetNames = new Set(); // sets that already exist server-side — their REAL option codes may differ from our locally derived ones
  if (allOptionSets.length > 0) {
    const osNames = allOptionSets.map(o => o.name);
    const osBatches = [];
    for (let i = 0; i < osNames.length; i += 50) osBatches.push(osNames.slice(i, i + 50));
    const osResponses = await Promise.all(osBatches.map(batch => {
      const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
      return safeDhis2Fetch(`optionSets?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
    }));
    // Fail LOUD on probe errors — see the DE/TEA probe block below for why.
    const osProbeFailures = osResponses.filter(r => r?._error).map(r => `optionSets name probe: ${r._error}`);
    if (osProbeFailures.length) {
      return {
        success: false,
        nothing_created: true,
        phase: 'pre_check',
        _error: `Aborted BEFORE creating anything: could not check the server for existing option sets (${osProbeFailures.join('; ')})`,
        errors: osProbeFailures,
        _hint: 'The duplicate-check query against DHIS2 failed, so existing option sets could not be detected and creating blindly would duplicate them. Nothing was imported. Verify connectivity/permissions and retry the SAME create_program call.',
      };
    }
    for (const resp of osResponses) {
      for (const ex of (resp?.optionSets || [])) {
        const os = allOptionSets.find(o => o.name === ex.name);
        if (os && !os._skip) {
          const oldId = os.id;
          optionSetUidMap[os.name] = ex.id;
          os._skip = true;
          reusedOptionSetNames.add(os.name);
          for (const de of allDataElements) { if (de.optionSet?.id === oldId) de.optionSet.id = ex.id; }
          for (const tea of allTrackedEntityAttributes) { if (tea.optionSet?.id === oldId) tea.optionSet.id = ex.id; }
        }
      }
    }
  }
  const filteredOptionSets = allOptionSets.filter(os => !os._skip);

  // 2. Skip options belonging to skipped option sets (they already exist in DHIS2)
  const skippedOptionIds = new Set();
  for (const os of allOptionSets) {
    if (os._skip && os.options) {
      for (const ref of os.options) skippedOptionIds.add(ref.id);
    }
  }
  let finalOptions = allOptions.filter(opt => !skippedOptionIds.has(opt.id));

  // 3 + 4. Run DE / TEA name probes in parallel — they have no ordering
  // dependency on each other, only on Step 1 above.
  //
  // ⚠️ Options are deliberately NOT deduplicated against the server by name.
  // A DHIS2 Option belongs to exactly ONE optionSet (options.optionsetid FK).
  // The old "reuse an existing option with the same name" logic rewired a NEW
  // option set to reference options owned by OTHER option sets ("None",
  // "Negative", "Live birth", …) and the metadata import silently RE-PARENTED
  // them — ripping the option out of its original set and corrupting unrelated
  // metadata with no backup. Verified live on play 2.42.5.1 (2026-07-01): a new
  // set referencing an existing "None"/"Mild" stole both options from the set
  // that owned them. Same-name options across different sets are normal and
  // correct in DHIS2 — every new set must get ITS OWN option rows.
  const deBatches = [];
  if (allDataElements.length > 0) {
    const deNames = allDataElements.map(d => d.name);
    for (let i = 0; i < deNames.length; i += 50) deBatches.push(deNames.slice(i, i + 50));
  }
  const teaBatches = [];
  if (allTrackedEntityAttributes.length > 0) {
    const teaNames = allTrackedEntityAttributes.map(t => t.name);
    for (let i = 0; i < teaNames.length; i += 50) teaBatches.push(teaNames.slice(i, i + 50));
  }

  const [deResponses, teaResponses, explicitTeaResp] = await Promise.all([
    Promise.all(deBatches.map(batch => {
      const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
      return safeDhis2Fetch(`dataElements?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
    })),
    Promise.all(teaBatches.map(batch => {
      const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
      return safeDhis2Fetch(`trackedEntityAttributes?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
    })),
    explicitTeaIds.length
      ? safeDhis2Fetch(`trackedEntityAttributes?filter=id:in:[${explicitTeaIds.map(t => t.id).join(',')}]&fields=id,name&paging=false`)
      : Promise.resolve(null),
  ]);

  // ── Dedup probes MUST succeed before we import ─────────────────────────────
  // If a probe errored (network, auth, a strict proxy rejecting the URL, …) we
  // know NOTHING about what already exists — proceeding would blindly create
  // duplicates of objects that may already be there, and the atomic import
  // would bounce with confusing "already exists" errors (or worse, near-
  // duplicates would be created). Verified live 2026-07-10 on a Tomcat-fronted
  // 2.42: silent probe 400s caused create_program to recreate the existing
  // "Full name"/"DoB"/"Sex" TEAs three times in a row. Fail LOUD instead.
  {
    const probeFailures = [];
    for (const r of deResponses) if (r?._error) probeFailures.push(`dataElements name probe: ${r._error}`);
    for (const r of teaResponses) if (r?._error) probeFailures.push(`trackedEntityAttributes name probe: ${r._error}`);
    if (explicitTeaResp?._error) probeFailures.push(`trackedEntityAttributes id probe: ${explicitTeaResp._error}`);
    if (probeFailures.length) {
      return {
        success: false,
        nothing_created: true,
        phase: 'pre_check',
        _error: `Aborted BEFORE creating anything: could not check the server for existing objects (${probeFailures.length} probe failure(s)): ${probeFailures.join('; ')}`,
        errors: probeFailures,
        _hint: 'The duplicate-check queries against DHIS2 failed, so existing data elements / tracked entity attributes could not be detected. Creating blindly would duplicate metadata that may already exist. Nothing was imported. Verify connectivity/permissions to the DHIS2 instance and retry the SAME create_program call.',
      };
    }
    // Explicit reuse-by-UID entries must point at REAL attributes.
    if (explicitTeaIds.length) {
      const foundIds = new Set((explicitTeaResp?.trackedEntityAttributes || []).map(t => t.id));
      const phantom = explicitTeaIds.filter(t => !foundIds.has(t.id));
      if (phantom.length) {
        return {
          success: false,
          nothing_created: true,
          phase: 'pre_check',
          _error: `Aborted BEFORE creating anything: program_attributes reference ${phantom.length} trackedEntityAttribute UID(s) that do not exist on this server: ${phantom.map(t => `${t.name} [${t.id}]`).join(', ')}.`,
          _hint: 'Only pass id for a TEA you have VERIFIED on this instance (via search_metadata or an "already exists on object <UID>" server error). To create a new attribute instead, drop the id and pass name + value_type.',
        };
      }
    }
  }

  // Apply DE dedup
  for (const resp of deResponses) {
    for (const ex of (resp?.dataElements || [])) {
      const de = allDataElements.find(d => d.name === ex.name && !d._skip);
      if (de) { deUidMap[de.name] = ex.id; de._skip = true; }
    }
  }

  // Apply TEA dedup
  for (const resp of teaResponses) {
    for (const ex of (resp?.trackedEntityAttributes || [])) {
      const tea = allTrackedEntityAttributes.find(t => t.name === ex.name && !t._skip);
      if (tea) { teaUidMap[tea.name] = ex.id; tea._skip = true; }
    }
  }

  // Second pass: case-insensitive reuse for names the exact-match probe missed
  // ("DOB" requested vs existing "DoB"). DHIS2's unique-name constraint is
  // case-SENSITIVE, so a case variant imports "successfully" as a silent
  // near-duplicate — exactly what reuse-by-name exists to prevent (observed
  // 2026-07-10: the first Child-health attempt would have created "DOB"
  // alongside the instance's existing "DoB"). ilike = case-insensitive
  // contains; we only accept full-string case-insensitive equality. Probe
  // errors here are non-fatal — the exact probes above already proved
  // connectivity, and a residual duplicate is still caught by the
  // name-conflict self-healing in postMetadataPayload.
  {
    const ciReuse = async (obj, resource, key, uidMap) => {
      const resp = await safeDhis2Fetch(`${resource}?filter=name:ilike:${encodeURIComponent(obj.name)}&fields=id,name&pageSize=10`);
      if (resp?._error) return;
      const hit = (resp?.[key] || []).find(x => String(x.name || '').toLowerCase() === String(obj.name).toLowerCase());
      if (hit) { uidMap[obj.name] = hit.id; obj._skip = true; }
    };
    await Promise.all([
      ...allDataElements.filter(d => !d._skip).map(d => ciReuse(d, 'dataElements', 'dataElements', deUidMap)),
      ...allTrackedEntityAttributes.filter(t => !t._skip).map(t => ciReuse(t, 'trackedEntityAttributes', 'trackedEntityAttributes', teaUidMap)),
    ]);
  }
  const filteredDataElements = allDataElements.filter(de => !de._skip);
  const filteredTEAs = allTrackedEntityAttributes.filter(tea => !tea._skip);

  // ── Server-side shortName collision resolution ──────────────────────────────
  // DHIS2 has a UNIQUE Postgres constraint on shortName for DataElement,
  // TrackedEntityAttribute, ProgramIndicator, and Program. Even after
  // per-payload dedupe via clampShortName, a freshly built shortName can still
  // collide with a value that already exists in the instance — same name
  // pattern from a prior program, a sample tracker, or another tenant's
  // metadata. Probe for ALL three classes (DE, TEA, Program) in one parallel
  // block — the program shortName lives in a tiny ref object so we don't need
  // to wait for the full program object to be built first.
  const programShortNameRef = {
    id: '__program_pending__',
    shortName: clampShortName(args.program_short_name, args.program_name, null, 'Program'),
  };
  await Promise.all([
    disambiguateShortNamesAgainstServer(filteredDataElements, 'dataElements', 'dataElements'),
    disambiguateShortNamesAgainstServer(filteredTEAs, 'trackedEntityAttributes', 'trackedEntityAttributes'),
    disambiguateShortNamesAgainstServer([programShortNameRef], 'programs', 'programs'),
  ]);

  // ── Stage name collision resolution ─────────────────────────────────────────
  // DHIS2 enforces GLOBAL uniqueness on ProgramStage.name at the DB level, so
  // generic names like "Test" or "Results" routinely collide with leftovers
  // from earlier attempts and the metadata import fails with a raw Postgres
  // "duplicate key value violates unique constraint" 409. Pre-probe each
  // requested stage name and, on conflict, auto-suffix with the program's
  // short name (or a 4-char UID shard if that also collides). The user still
  // sees the original intent; we only disambiguate what DHIS2 requires to be
  // globally unique.
  const programShortForSuffix = (args.program_short_name || args.program_name || '').trim();
  // Per-stage probe chain (original → with program-short suffix → UID shard)
  // is preserved exactly — only the *across-stage* loop is parallelized so a
  // 5-stage program no longer pays 5×RTT for stage probes.
  const resolvedStageNames = await Promise.all(stages.map(async (stage) => {
    let candidate = stage.name;
    let probe = await safeDhis2Fetch(
      `programStages?filter=name:eq:${encodeURIComponent(candidate)}&fields=id&pageSize=1`
    );
    if (probe?.programStages?.length && programShortForSuffix) {
      candidate = `${stage.name} - ${programShortForSuffix}`.substring(0, 230);
      probe = await safeDhis2Fetch(
        `programStages?filter=name:eq:${encodeURIComponent(candidate)}&fields=id&pageSize=1`
      );
    }
    if (probe?.programStages?.length) {
      // Final fallback: short UID suffix — guaranteed unique.
      candidate = `${stage.name} ${generateDhis2Uid().slice(-4)}`.substring(0, 230);
    }
    return candidate;
  }));

  // Build program
  const programUid = generateDhis2Uid();
  const stageObjects = [];
  const allProgramStageSections = []; // top-level collection — DHIS2 rejects sections nested inside the stage
  const stageUids = [];
  const stageRenames = []; // summary for caller: [{original, final}] when renamed

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const stageUid = generateDhis2Uid();
    stageUids.push(stageUid);
    const finalStageName = resolvedStageNames[i];
    if (finalStageName !== stage.name) stageRenames.push({ original: stage.name, final: finalStageName });

    const psdes = (stage.data_elements || []).map((de, j) => ({
      dataElement: { id: deUidMap[de.name] },
      compulsory: de.compulsory || false,
      sortOrder: j + 1,
    }));

    // Optional visual sections: group a subset of this stage's data elements.
    // DHIS2 renders a stage as sections when programStageSections exist; each
    // section's dataElements must already be programStageDataElements of the
    // stage (they are, by construction). UIDs are pre-generated so the atomic
    // import wires the references. Unknown/empty sections are skipped, not sent.
    const psSections = [];
    for (let k = 0; k < (stage.sections || []).length; k++) {
      const sec = stage.sections[k];
      const deRefs = (sec && (sec.data_elements || sec.dataElements) || [])
        .map(n => deUidMap[typeof n === 'string' ? n : (n && n.name)])
        .filter(Boolean)
        .map(id => ({ id }));
      if (!sec || !sec.name || !deRefs.length) continue;
      psSections.push({
        id: generateDhis2Uid(),
        name: sec.name,
        sortOrder: k + 1,
        programStage: { id: stageUid },
        dataElements: deRefs,
      });
    }

    const stageObj = {
      id: stageUid,
      name: finalStageName,
      program: { id: programUid },
      sortOrder: i + 1,
      repeatable: stage.repeatable || false,
      programStageDataElements: psdes,
    };
    if (psSections.length) {
      for (const s of psSections) allProgramStageSections.push(s);
      stageObj.programStageSections = psSections.map(s => ({ id: s.id })); // stage refs sections by id
    }
    if (sharingBlock && applySharingToChildren) {
      stageObj.sharing = sharingBlock;
      stageObj.publicAccess = sharingBlock.public;
    }
    stageObjects.push(stageObj);
  }

  // Apply sharing to data elements, option sets, TEAs — these classes have
  // dataShareable=false in the DHIS2 schema, so the data-access bits must be
  // zeroed out. Program + stages keep the full block above.
  if (sharingBlock && applySharingToChildren) {
    const metaOnly = toMetadataOnlySharing(sharingBlock);
    for (const de of filteredDataElements) {
      de.sharing = metaOnly;
      de.publicAccess = metaOnly.public;
    }
    for (const os of filteredOptionSets) {
      os.sharing = metaOnly;
      os.publicAccess = metaOnly.public;
    }
    for (const tea of filteredTEAs) {
      tea.sharing = metaOnly;
      tea.publicAccess = metaOnly.public;
    }
  }

  const program = {
    id: programUid,
    name: args.program_name,
    // shortName was already probed-and-suffixed above in the parallel block.
    shortName: programShortNameRef.shortName,
    programType: programType,
    organisationUnits: orgUnitIds.map(id => ({ id })),
    programStages: stageUids.map(id => ({ id })),
  };
  if (isTracker && tetId) {
    program.trackedEntityType = { id: tetId };
  }
  if (sharingBlock) {
    program.sharing = sharingBlock;
    program.publicAccess = sharingBlock.public;
  }

  // Add tracked entity attributes to program
  if (Object.keys(teaUidMap).length > 0 && args.program_attributes?.length) {
    program.programTrackedEntityAttributes = args.program_attributes.map((attr, i) => ({
      trackedEntityAttribute: { id: teaUidMap[attr.name || attr.id] },
      mandatory: attr.mandatory || false,
      searchable: attr.searchable || false,
      displayInList: attr.display_in_list !== false, // default true
      sortOrder: i + 1,
    }));
  }

  // Build program rules if provided — uses separate top-level programRuleActions array
  const allProgramRuleVariables = [];
  const allProgramRuleActions = [];
  const allProgramRules = [];
  const prvCreated = {}; // track created variables by name
  let ruleConditionAdvisories = [];
  let ruleConditionRewrites = [];
  let ruleTokenRewrites = [];
  let ruleAutoGuards = [];
  // Rules that could not be built (unresolved variable/stage/section refs) are
  // SKIPPED — the rest of the program still imports — and reported here so the
  // model can heal them via manage_program_rules against the created program.
  // Rationale: one bad token in one rule must NOT nuke a whole 3-stage program
  // (verified failure: a deterministic model then retries the identical create
  // forever, creating nothing — the TB program loop, 2026-07-12).
  const skippedRules = [];
  const ruleActionFixes = []; // invalid/aliased action types adjusted client-side so the import can't 409 on a bad enum

  // Rules that survive the per-rule condition lint. A rule with a known-broken
  // boolean pattern is SKIPPED (recorded) rather than aborting the whole import,
  // so one bad condition can't sink an entire program (and can't trap a
  // deterministic model in an identical-retry loop).
  let buildableRules = args.program_rules || [];
  if (args.program_rules?.length) {
    // Pre-flight: lint conditions for known-broken boolean patterns → skip failers.
    buildableRules = [];
    for (const rule of args.program_rules) {
      const err = lintProgramRuleCondition(rule.condition, rule.name);
      if (err) {
        skippedRules.push({ rule: rule.name, reason: 'condition_lint', detail: err });
      } else {
        buildableRules.push(rule);
      }
    }

    // Pre-flight: visibility semantics — hide+mandate contradictions, show/hide
    // twin rules, inverted "Show X" rules. These import fine and break only in
    // front of the data-entry user. Unlike the per-rule checks above, this one
    // is about combinations of rules (which rule to drop is ambiguous), so it
    // stays a hard error — but the loop's circuit breaker now bounds any retry
    // storm it might trigger.
    const semanticErrors = lintRuleVisibilitySemantics(buildableRules);
    if (semanticErrors.length) {
      return {
        success: false,
        _error: `Program rule semantics lint failed (${semanticErrors.length}): ${semanticErrors.join(' | ')}`,
        phase: 'lint',
        errors: semanticErrors,
        _hint: 'Rewrite the flagged rules as ONE hide rule per target (condition = the HIDE case) and retry the whole create_program. Do not work around this by re-wording rule names.',
      };
    }

    // deName → its inline option set name (needed so option-set PRVs resolve
    // option CODES, and so condition/ASSIGN literals can be name→code mapped).
    const deOptionSetName = {};
    for (const stage of stages) {
      for (const de of (stage.data_elements || [])) {
        if (de.option_set?.name) deOptionSetName[de.name] = de.option_set.name;
      }
    }
    const teaOptionSetName = {};
    for (const attr of (args.program_attributes || [])) {
      if (attr.option_set?.name) teaOptionSetName[attr.name] = attr.option_set.name;
    }

    // Stage references inside rule actions: stage IDs are generated CLIENT-SIDE
    // in this very call, so the model cannot know them — HIDEPROGRAMSTAGE /
    // CREATEEVENT actions reference stages by NAME instead (program_stage_name,
    // or a name passed in program_stage_id). Verified failure mode on play
    // 2.40.12 (2026-07-06): an id-less HIDEPROGRAMSTAGE bounced the whole atomic
    // import with "ProgramRuleAction: ProgramStage cannot be null".
    const stageNameToUid = {};
    for (let si = 0; si < stages.length; si++) {
      stageNameToUid[String(stages[si].name || '').trim().toLowerCase()] = stageUids[si];
      stageNameToUid[String(resolvedStageNames[si] || '').trim().toLowerCase()] = stageUids[si];
    }
    const resolveStageRefForAction = (act) => {
      const ref = act.program_stage_name || act.program_stage_id;
      if (!ref) return null;
      const byName = stageNameToUid[String(ref).trim().toLowerCase()];
      if (byName) return byName;
      if (stageUids.includes(ref)) return ref;
      if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(String(ref))) return ref; // plausible pre-existing UID — pass through
      return undefined; // unresolvable
    };

    // PRV builders keyed by PRV NAME so a token-named variable (e.g. muac →
    // DE "MUAC in cm") and an exact-sanitized-name variable never collide.
    const pushDePrv = (prvName, deName) => {
      if (prvCreated[prvName]) return;
      const prvUid = generateDhis2Uid();
      let sourceStageId = null;
      for (let si = 0; si < stages.length; si++) {
        if ((stages[si].data_elements || []).some(d => d.name === deName)) {
          sourceStageId = stageUids[si]; break;
        }
      }
      allProgramRuleVariables.push({
        id: prvUid,
        name: prvName,
        program: { id: programUid },
        dataElement: { id: deUidMap[deName] },
        programRuleVariableSourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
        // Option-set DEs MUST resolve the option CODE, matching the code
        // literals the conditions compare against. useCodeForOptionSet=false
        // makes #{var} yield the option NAME → every `== 'CODE'` comparison
        // silently never fires (root cause of the MCH "hidden fields never
        // show" bug, play 2.40.12, 2026-07-07).
        ...(deOptionSetName[deName] ? { useCodeForOptionSet: true } : {}),
        ...(sourceStageId ? { programStage: { id: sourceStageId } } : {}),
      });
      prvCreated[prvName] = prvUid;
    };
    const pushTeaPrv = (prvName, teaName) => {
      if (prvCreated[prvName]) return;
      const prvUid = generateDhis2Uid();
      const teaObj = allTrackedEntityAttributes.find(t => t.name === teaName);
      allProgramRuleVariables.push({
        id: prvUid,
        name: prvName,
        program: { id: programUid },
        trackedEntityAttribute: { id: teaUidMap[teaName] },
        programRuleVariableSourceType: 'TEI_ATTRIBUTE',
        useCodeForOptionSet: !!teaObj?.optionSet,
      });
      prvCreated[prvName] = prvUid;
    };

    const deNamesAll = Object.keys(deUidMap);
    const teaNamesAll = Object.keys(teaUidMap);
    const autoGuardedConditions = [];
    for (const rule of buildableRules) {
      // Bare `#{x} < n` fires on EMPTY fields (empty coerces to 0) — wrap with
      // d2:hasValue so warnings/hides don't trigger on a blank form.
      {
        const g = autoGuardNumericComparisons(rule.condition);
        if (g.guarded.length) {
          rule.condition = g.condition;
          autoGuardedConditions.push({ rule: rule.name, guarded_variables: g.guarded });
        }
      }
      // Resolve every #{}/A{} token in condition + action data to a DE/TEA
      // (exact sanitized name, then unique prefix; display-name tokens are
      // auto-rewritten to the canonical sanitized form). The PRV is created
      // under the TOKEN name so the expression resolves exactly as written.
      //
      // On ANY unresolved token or unbuildable action, the rule is SKIPPED
      // (recorded in skippedRules) instead of aborting the whole import. To keep
      // a skipped rule from leaving orphan PRVs/actions behind, everything for
      // this rule is built into LOCAL scratch first and only committed to the
      // shared arrays once the whole rule is known to be valid.
      const { bindings, unresolved, rewrites } = resolveRuleTokenBindings(rule, deNamesAll, teaNamesAll);
      if (unresolved.length) {
        skippedRules.push({
          rule: rule.name,
          reason: 'unresolved_variable',
          unresolved,
          detail: `references variable(s) with no matching data element or attribute in this program: ${unresolved.join(', ')}`,
        });
        continue;
      }

      // Build program rule + separate actions (top-level programRuleActions array)
      const prUid = generateDhis2Uid();
      const pendingActions = [];
      let ruleSkip = null;

      for (const act of (rule.actions || [])) {
        // Guard the action type FIRST: an invalid enum (e.g. model-invented
        // COMPLETEENROLLMENT) 409s the whole atomic import at deserialization,
        // before validation — so it must never reach the server. Aliases map to
        // the closest real action; anything unknown is dropped, not sent.
        const norm = normalizeRuleActionType(act.type, act.content);
        if (norm.skip) {
          ruleActionFixes.push({ rule: rule.name, action_type: act.type, outcome: 'dropped', detail: norm.note });
          continue;
        }
        if (norm.note) ruleActionFixes.push({ rule: rule.name, action_type: act.type, outcome: `translated to ${norm.type}`, detail: norm.note });
        const praUid = generateDhis2Uid();
        const pra = {
          id: praUid,
          programRuleActionType: norm.type,
          programRule: { id: prUid },
        };
        const actContent = act.content || norm.content;
        if (actContent) pra.content = actContent;
        if (act.data) pra.data = act.data;
        if (act.data_element_name && deUidMap[act.data_element_name]) {
          pra.dataElement = { id: deUidMap[act.data_element_name] };
        }
        if (act.tracked_entity_attribute_name && teaUidMap[act.tracked_entity_attribute_name]) {
          pra.trackedEntityAttribute = { id: teaUidMap[act.tracked_entity_attribute_name] };
        }
        const stageId = resolveStageRefForAction(act);
        if (stageId) pra.programStage = { id: stageId };
        if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };

        // HIDEOPTION needs the specific option's UID, or the atomic import 409s
        // with "Option cannot be null". Resolve it from the option set built for
        // the target data element IN THIS call (exact name, then code, then a
        // forgiving prefix/contains match). Unresolvable → skip the rule cleanly.
        if (norm.type === 'HIDEOPTION') {
          const optLabel = act.option_name || act.option_code || act.option || '';
          const osName = optionSetNameByDeName[act.data_element_name];
          const opts = osName ? optionSetOptionsByName[osName] : null;
          const want = String(optLabel).trim().toLowerCase();
          const opt = (opts && want) ? (
            opts.find(o => String(o.name).toLowerCase() === want) ||
            opts.find(o => String(o.code).toLowerCase() === want) ||
            opts.find(o => String(o.name).toLowerCase().startsWith(want)) ||
            opts.find(o => String(o.name).toLowerCase().includes(want))
          ) : null;
          if (!opt || !opt.id) {
            ruleSkip = {
              rule: rule.name,
              reason: 'unresolved_option',
              detail: `HIDEOPTION could not resolve option "${optLabel || '(none given)'}" on data element "${act.data_element_name || '(none)'}"${osName ? ` in option set "${osName}"` : ' — that data element has no inline option set in this call'}. Pass option_name (exact display name) or option_code; only options created in THIS call can be resolved here.`,
            };
            break;
          }
          pra.option = { id: opt.id };
        }

        // Stage-targeting actions that could not resolve would make the server
        // reject the whole atomic import ("ProgramRuleAction: ProgramStage
        // cannot be null") — skip the RULE rather than the whole program.
        if ((norm.type === 'HIDEPROGRAMSTAGE' || norm.type === 'CREATEEVENT') && !pra.programStage) {
          ruleSkip = {
            rule: rule.name,
            reason: 'unresolved_stage',
            detail: `${norm.type} action's target stage could not be resolved${act.program_stage_name || act.program_stage_id ? ` from "${act.program_stage_name || act.program_stage_id}"` : ' (no stage reference given)'}; valid stage names: ${stages.map(s => s.name).join(', ')}`,
          };
          break;
        }
        if (norm.type === 'HIDESECTION' && !pra.programStageSection) {
          ruleSkip = {
            rule: rule.name,
            reason: 'unresolved_section',
            detail: 'HIDESECTION needs a program_stage_section_id. Pass sections in the stage (create_program now builds them) and target the section by program_stage_section_id, or use HIDEFIELD per data element / HIDEPROGRAMSTAGE.',
          };
          break;
        }
        pendingActions.push(pra);
      }

      if (ruleSkip) { skippedRules.push(ruleSkip); continue; }
      // Every action was dropped as invalid — a rule with no actions is useless
      // and some servers reject it, so skip the whole rule (recorded above).
      if ((rule.actions || []).length && pendingActions.length === 0) {
        skippedRules.push({ rule: rule.name, reason: 'no_valid_actions', detail: 'all actions had invalid/unsupported types and were dropped.' });
        continue;
      }

      // ── Commit: the whole rule is valid, so publish its PRVs, actions, rule ──
      if (rewrites.length) ruleTokenRewrites.push({ rule: rule.name, rewrites });
      for (const b of bindings) {
        if (b.kind === 'de') pushDePrv(b.token, b.name); else pushTeaPrv(b.token, b.name);
      }
      // Action-target DEs/TEAs also get a PRV under their sanitized name
      // (pre-existing behavior — harmless and occasionally referenced later).
      for (const act of (rule.actions || [])) {
        if (act.data_element_name && deUidMap[act.data_element_name]) {
          pushDePrv(sanitizeVariableName(act.data_element_name), act.data_element_name);
        }
        if (act.tracked_entity_attribute_name && teaUidMap[act.tracked_entity_attribute_name]) {
          pushTeaPrv(sanitizeVariableName(act.tracked_entity_attribute_name), act.tracked_entity_attribute_name);
        }
      }
      for (const pra of pendingActions) allProgramRuleActions.push(pra);
      allProgramRules.push({
        id: prUid,
        name: rule.name,
        description: rule.description || '',
        program: { id: programUid },
        condition: rule.condition,
        programRuleActions: pendingActions.map(a => ({ id: a.id })), // ID refs only
      });
    }

    // ── Option NAME → CODE mapping in conditions and ASSIGN data ──
    // PRVs above resolve option CODES (useCodeForOptionSet=true), so literals
    // must be codes too. Locally built sets carry their derived codes; sets
    // REUSED from the server may have different codes → fetch those.
    {
      const deNameByUid = {};
      for (const [n, uid] of Object.entries(deUidMap)) deNameByUid[uid] = n;
      const teaNameByUid = {};
      for (const [n, uid] of Object.entries(teaUidMap)) teaNameByUid[uid] = n;

      const varToOsKey = new Map();
      for (const prv of allProgramRuleVariables) {
        let osName = null;
        if (prv.dataElement?.id) osName = deOptionSetName[deNameByUid[prv.dataElement.id]] || null;
        else if (prv.trackedEntityAttribute?.id) osName = teaOptionSetName[teaNameByUid[prv.trackedEntityAttribute.id]] || null;
        if (osName) varToOsKey.set(String(prv.name).toLowerCase(), osName);
      }
      const targetToOsKey = new Map();
      for (const pra of allProgramRuleActions) {
        const deId = pra.dataElement?.id;
        const teaId = pra.trackedEntityAttribute?.id;
        const osName = (deId && deOptionSetName[deNameByUid[deId]]) || (teaId && teaOptionSetName[teaNameByUid[teaId]]) || null;
        if (osName) targetToOsKey.set(deId || teaId, osName);
      }

      const neededOsNames = new Set([...varToOsKey.values(), ...targetToOsKey.values()]);
      const optionsByOsKey = new Map();
      const reusedToFetch = [];
      for (const osName of neededOsNames) {
        if (reusedOptionSetNames.has(osName)) reusedToFetch.push(osName);
        else if (optionSetOptionsByName[osName]) optionsByOsKey.set(osName, optionSetOptionsByName[osName]);
      }
      if (reusedToFetch.length) {
        const resps = await Promise.all(reusedToFetch.map(n =>
          safeDhis2Fetch(`optionSets/${optionSetUidMap[n]}?fields=id,options[name,code]`)));
        for (let i = 0; i < reusedToFetch.length; i++) {
          const o = resps[i];
          if (o && !o._error) optionsByOsKey.set(reusedToFetch[i], (o.options || []).map(x => ({ name: x.name, code: x.code })));
        }
      }

      const mapped = rewriteOptionLiteralsGeneric({
        rules: allProgramRules,
        actions: allProgramRuleActions,
        varToOsKey,
        targetToOsKey,
        optionsByOsKey,
      });
      ruleConditionAdvisories = mapped.advisories;
      ruleConditionRewrites = mapped.rewrites;
    }
    ruleAutoGuards = autoGuardedConditions;
  }

  // Build the atomic payload (Batch 1: options + optionSets + TEAs + DEs + program + stages)
  const payload = {};
  if (finalOptions.length) payload.options = finalOptions;
  if (filteredOptionSets.length) payload.optionSets = filteredOptionSets;
  if (filteredTEAs.length) payload.trackedEntityAttributes = filteredTEAs;
  if (filteredDataElements.length) payload.dataElements = filteredDataElements;
  payload.programs = [program];
  if (stageObjects.length) payload.programStages = stageObjects;
  if (allProgramStageSections.length) payload.programStageSections = allProgramStageSections;
  if (allProgramRuleVariables.length) payload.programRuleVariables = allProgramRuleVariables;
  if (allProgramRuleActions.length) payload.programRuleActions = allProgramRuleActions;
  if (allProgramRules.length) payload.programRules = allProgramRules;

  let result = await postMetadataPayload(payload, args.dry_run_only);

  // Defensive fallback — if DHIS2 still complains "Data sharing is not enabled for X"
  // for any klass we didn't know about (future-proofing for schema changes or custom
  // dataShareable=false types), downgrade every non-Program/non-ProgramStage object's
  // sharing to metadata-only and retry once. Program + ProgramStage keep the full
  // block since those ARE dataShareable.
  const dataSharingErrors = (result.errors || []).filter(e => /Data sharing is not enabled/i.test(e));
  if (!result.success && dataSharingErrors.length && sharingBlock) {
    const metaOnly = toMetadataOnlySharing(sharingBlock);
    for (const arr of [filteredOptionSets, filteredDataElements, filteredTEAs]) {
      for (const obj of arr) { obj.sharing = metaOnly; obj.publicAccess = metaOnly.public; }
    }
    const retryPayload = { ...payload };
    if (filteredOptionSets.length) retryPayload.optionSets = filteredOptionSets;
    if (filteredDataElements.length) retryPayload.dataElements = filteredDataElements;
    if (filteredTEAs.length) retryPayload.trackedEntityAttributes = filteredTEAs;
    const retry = await postMetadataPayload(retryPayload, args.dry_run_only);
    if (retry.success) {
      retry._recovered_from = `Retried after ${dataSharingErrors.length} "Data sharing not enabled" error(s); downgraded DE/OS/TEA sharing to metadata-only.`;
      result = retry;
    }
  }

  // If postMetadataPayload self-healed a name conflict by reusing an existing
  // object, our local name→ID maps still hold the discarded pre-generated UID.
  // Sync them so the summary / returned ID handles point at the REAL objects.
  if (result?._name_conflict_remaps?.length) {
    for (const r of result._name_conflict_remaps) {
      for (const map of [deUidMap, teaUidMap, optionSetUidMap]) {
        for (const [n, id] of Object.entries(map)) { if (id === r.from) map[n] = r.to; }
      }
    }
  }
  // Stage objects renamed by the name-conflict autofix live in payload.programStages
  // (same references as stageObjects) — mirror any rename into the summary names.
  if (result?._name_conflict_renames?.length) {
    for (let i = 0; i < stageObjects.length; i++) {
      if (stageObjects[i]?.name && stageObjects[i].name !== resolvedStageNames[i]) {
        stageRenames.push({ original: resolvedStageNames[i], final: stageObjects[i].name });
        resolvedStageNames[i] = stageObjects[i].name;
      }
    }
  }

  // Create program indicators as follow-up (they need stage UIDs from the created program)
  let indicatorResults = [];
  if (args.program_indicators?.length && result.success && !args.dry_run_only) {
    const piSharing = sharingBlock && applySharingToChildren ? toMetadataOnlySharing(sharingBlock) : null;
    const seenPIShortNames = new Set();
    const indicators = args.program_indicators.map(pi => {
      const piUid = generateDhis2Uid();
      const obj = {
        id: piUid,
        name: pi.name,
        shortName: clampShortName(pi.short_name, pi.name, seenPIShortNames, 'Indicator'),
        program: { id: programUid },
        analyticsType: pi.analytics_type || 'EVENT',
        aggregationType: pi.aggregation_type || 'COUNT',
        expression: pi.expression || 'V{event_count}',
        filter: pi.filter || '',
        description: pi.description || '',
        // Boundary target must match the analytics type — ENROLLMENT PIs with
        // EVENT_DATE boundaries over-count and break d2:count filters (see
        // _buildAndPostProgramIndicator for the verified failure mode).
        analyticsPeriodBoundaries: (pi.analytics_type === 'ENROLLMENT'
          ? [
            { boundaryTarget: 'ENROLLMENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
            { boundaryTarget: 'ENROLLMENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
          ]
          : [
            { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
            { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
          ]),
      };
      if (piSharing) { obj.sharing = piSharing; obj.publicAccess = piSharing.public; }
      return obj;
    });

    // ProgramIndicators also have a UNIQUE shortName constraint server-side.
    await disambiguateShortNamesAgainstServer(indicators, 'programIndicators', 'programIndicators');

    // NAME is globally unique too — probe in one batched query and auto-suffix
    // collisions with the program's short name (or a UID shard), mirroring the
    // stage-name convention. Without this, re-running a scenario whose PIs
    // already exist (even on another program) fails the whole follow-up POST.
    {
      const piNames = indicators.map(p => p.name);
      const nameBatches = [];
      for (let i = 0; i < piNames.length; i += 50) nameBatches.push(piNames.slice(i, i + 50));
      const probeResps = await Promise.all(nameBatches.map(batch => {
        const nameFilter = batch.map(n => encodeURIComponent(n)).join(',');
        return safeDhis2Fetch(`programIndicators?filter=name:in:[${nameFilter}]&fields=id,name&pageSize=50`);
      }));
      const taken = new Set();
      for (const resp of probeResps) for (const ex of (resp?.programIndicators || [])) taken.add(ex.name);
      if (taken.size) {
        const piRenames = [];
        for (const p of indicators) {
          if (!taken.has(p.name)) continue;
          let candidate = programShortForSuffix ? `${p.name} - ${programShortForSuffix}`.substring(0, 230) : '';
          if (!candidate || taken.has(candidate)) candidate = `${p.name} ${generateDhis2Uid().slice(-4)}`.substring(0, 230);
          piRenames.push({ original: p.name, final: candidate });
          p.name = candidate;
        }
        if (piRenames.length) result._indicator_renames = piRenames;
      }
    }

    const piPayload = { programIndicators: indicators };
    const piResult = await postMetadataPayload(piPayload, false);
    indicatorResults = indicators.map(pi => ({ id: pi.id, name: pi.name }));
    if (!piResult.success) {
      result._indicator_warning = `Program created but indicators failed: ${piResult._error || JSON.stringify(piResult)}`;
    }
  }

  // Build summary
  const summary = {
    program: { id: programUid, name: args.program_name, type: programType },
    stages: stages.map((s, i) => ({
      id: stageUids[i],
      name: resolvedStageNames[i],
      originalName: s.name,
      dataElements: (s.data_elements || []).length,
    })),
    stageRenames: stageRenames.length ? stageRenames : undefined,
    trackedEntityAttributes: Object.entries(teaUidMap).map(([name, id]) => ({ name, id })),
    dataElements: Object.entries(deUidMap).map(([name, id]) => ({ name, id })),
    optionSets: Object.entries(optionSetUidMap).map(([name, id]) => ({ name, id })),
    programRules: allProgramRules.map(r => ({ id: r.id, name: r.name })),
    programIndicators: indicatorResults,
    orgUnits: orgUnitIds,
    ...(ruleAutoGuards.length ? { auto_guarded_conditions: ruleAutoGuards } : {}),
    ...(ruleConditionRewrites.length ? { condition_option_rewrites: ruleConditionRewrites } : {}),
    ...(ruleConditionAdvisories.length ? { condition_option_advisories: ruleConditionAdvisories } : {}),
    ...(ruleTokenRewrites.length ? { rule_token_rewrites: ruleTokenRewrites } : {}),
    ...(skippedRules.length ? { skipped_rules: skippedRules } : {}),
    ...(ruleActionFixes.length ? { rule_action_fixes: ruleActionFixes } : {}),
  };

  // Record successful program create in the per-turn registry so a duplicate
  // call from the model in the same turn is detected as an idempotent replay
  // by the collision probe above instead of being reported as a hard failure.
  // Only record on a real successful import (not dry runs or failed imports).
  const importOk = result && (result.success === true) && result.phase === 'import';
  if (importOk) {
    recordRecentCreation('program', args.program_name, programUid, summary);
  }

  // Top-level ID handles for multi-step orchestration. The full detail stays in
  // `summary`, but the very next step of a "create program → add rules/indicators
  // → build a dashboard/map" chain needs the program + stage + DE UIDs without
  // digging into nested summary shapes. Mirror the top-level id exposure that
  // manage_program_indicators / manage_dashboards / manage_maps already provide,
  // so the model reliably reuses REAL UIDs (never invents them). name→id maps let
  // it target a stage/DE/attribute by the name it just asked for.
  const stage_ids = {};
  summary.stages.forEach((s) => { stage_ids[s.name] = s.id; });

  // On FAILURE, never expose the pre-generated ID handles: the import is atomic,
  // so NONE of those objects exist. Returning program_id alongside the error
  // caused the model to call add_program_rules against a phantom program (404
  // "Program OuyEAzGOp5i could not be found" — observed 2026-07-06 on the MCH
  // scenario after a validation failure).
  if (!result || result.success !== true) {
    const dupHint = (result?.errors || []).some(e => /already exists on object/i.test(String(e)))
      ? ' ⚠ For every "already exists on object <UID>" error: that object ALREADY EXISTS on the server — you MUST NOT recreate it, and you MUST NOT dodge the error by inventing a name variant (that creates near-duplicate metadata). Reuse it instead: for attributes pass { id: "<the existing UID from the error>" } in program_attributes; for data elements / option sets keep the EXACT existing name and the tool reuses them automatically.'
      : '';
    return {
      ...result,
      nothing_created: true,
      _hint: `${result?._hint ? result._hint + ' ' : ''}The import is ATOMIC and it failed — NOTHING was created (no program, stages, data elements, or rules exist on the server). Do NOT reuse any IDs from this attempt and do NOT call add_program_rules/add_stage for this program. Fix the reported error and re-issue the ENTIRE create_program call.${dupHint}`,
    };
  }

  // Skipped rules: the program IS created — surface them prominently so the
  // model heals them against the now-real program instead of retrying the whole
  // create (which, at temperature 0, would reproduce the identical failure).
  let skipInfo = {};
  if (skippedRules.length) {
    const teaHint = skippedRules.some(r => r.reason === 'unresolved_variable')
      ? ` Available attributes: ${Object.keys(teaUidMap).map(n => `A{${sanitizeVariableName(n)}}`).join(', ') || '(none)'}. Available data elements: ${Object.keys(deUidMap).map(n => `#{${sanitizeVariableName(n)}}`).join(', ') || '(none)'}.`
      : '';
    skipInfo = {
      _skipped_rules: skippedRules,
      _skipped_rules_warning: `The program was created successfully, but ${skippedRules.length} program rule(s) were SKIPPED because they could not be resolved: ${skippedRules.map(r => `"${r.rule}" (${r.detail})`).join('; ')}.`,
      _next_step: `Do NOT re-run create_program. To add the skipped rule(s), call manage_program_rules(action=create, program_id="${programUid}") for each one, referencing an EXISTING variable.${teaHint} If a needed attribute/data element genuinely does not exist, tell the user which one is missing and ask how to proceed. Then give the user a summary that lists what was created AND which rules still need to be added.`,
    };
  }

  return {
    ...result,
    ...skipInfo,
    ...(args._input_heals && args._input_heals.length ? { _input_heals: args._input_heals } : {}),
    program_id: programUid,
    stage_ids,
    data_element_ids: { ...deUidMap },
    tracked_entity_attribute_ids: { ...teaUidMap },
    option_set_ids: { ...optionSetUidMap },
    summary,
  };
}

async function addStageToProgram(args, defaultCatComboId) {
  if (!args.program_id) return { _error: 'Missing program_id for add_stage' };
  if (!args.stage) return { _error: 'Missing stage object for add_stage' };

  const stage = args.stage;

  // Get existing program to determine sort order
  const progResp = await safeDhis2Fetch(`programs/${args.program_id}?fields=id,programStages[id,sortOrder]`);
  if (progResp._error) return { _error: `Could not load program ${args.program_id}: ${progResp._error}` };
  const existingStageCount = progResp?.programStages?.length || 0;

  const allOptions = [];
  const allOptionSets = [];
  const allDataElements = [];
  const optionSetUidMap = {};
  const deUidMap = {};
  const seenDEShortNames = new Set();

  for (const de of (stage.data_elements || [])) {
    if (de.option_set && de.option_set.name && de.option_set.options?.length) {
      if (!optionSetUidMap[de.option_set.name]) {
        const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
        allOptions.push(...options);
        allOptionSets.push(optionSet);
        optionSetUidMap[de.option_set.name] = osUid;
      }
    }
    if (!deUidMap[de.name]) {
      const { elem, uid } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames);
      allDataElements.push(elem);
      deUidMap[de.name] = uid;
    }
  }

  // Pre-probe DHIS2 for shortName collisions on these new DEs.
  await disambiguateShortNamesAgainstServer(allDataElements, 'dataElements', 'dataElements');

  const stageUid = generateDhis2Uid();
  const psdes = (stage.data_elements || []).map((de, j) => ({
    dataElement: { id: deUidMap[de.name] },
    compulsory: de.compulsory || false,
    sortOrder: j + 1,
  }));

  const stageObj = {
    id: stageUid,
    name: stage.name,
    program: { id: args.program_id },
    sortOrder: existingStageCount + 1,
    repeatable: stage.repeatable || false,
    programStageDataElements: psdes,
  };

  const payload = {};
  if (allOptions.length) payload.options = allOptions;
  if (allOptionSets.length) payload.optionSets = allOptionSets;
  if (allDataElements.length) payload.dataElements = allDataElements;
  payload.programStages = [stageObj];

  const result = await postMetadataPayload(payload, args.dry_run_only);

  return {
    ...result,
    summary: {
      stage: { id: stageUid, name: stage.name, dataElements: (stage.data_elements || []).length },
      program_id: args.program_id,
      dataElements: Object.entries(deUidMap).map(([name, id]) => ({ name, id })),
      optionSets: Object.entries(optionSetUidMap).map(([name, id]) => ({ name, id })),
    },
  };
}

async function addDataElementsToExistingStage(args, defaultCatComboId) {
  if (!args.stage_id) return { _error: 'Missing stage_id for add_data_elements_to_stage' };
  const hasExistingIds = args.data_element_ids?.length > 0;
  const hasNewDEs = args.data_elements?.length > 0;
  if (!hasExistingIds && !hasNewDEs) {
    return { _error: 'Provide data_element_ids (existing DE IDs) or data_elements (new DE definitions) for add_data_elements_to_stage' };
  }

  // 1. Fetch the full current stage — we need name + program for a valid PUT
  const stageResp = await safeDhis2Fetch(
    `programStages/${args.stage_id}?fields=id,name,program[id],sortOrder,repeatable,programStageDataElements[id,dataElement[id],compulsory,allowProvidedElsewhere,sortOrder,displayInReports,allowFutureDate,renderOptionsAsRadio,skipSynchronization,skipAnalytics]`
  );
  if (stageResp._error) return { _error: `Could not load stage ${args.stage_id}: ${stageResp._error}` };
  if (!stageResp.name) return { _error: `Stage ${args.stage_id} is missing required 'name' field` };
  if (!stageResp.program?.id) return { _error: `Stage ${args.stage_id} has no associated program` };

  const existing = stageResp.programStageDataElements || [];
  const existingIds = new Set(existing.map(psde => psde.dataElement?.id).filter(Boolean));
  const maxSortOrder = existing.reduce((m, e) => Math.max(m, e.sortOrder || 0), 0);
  let sortCounter = maxSortOrder;

  // Preserve the existing elements as-is in the PUT body
  const updatedPsdes = existing.map(psde => ({
    id: psde.id,
    dataElement: { id: psde.dataElement.id },
    compulsory: psde.compulsory || false,
    allowProvidedElsewhere: psde.allowProvidedElsewhere || false,
    sortOrder: psde.sortOrder,
    displayInReports: psde.displayInReports || false,
    allowFutureDate: psde.allowFutureDate || false,
    renderOptionsAsRadio: psde.renderOptionsAsRadio || false,
    skipSynchronization: psde.skipSynchronization || false,
    skipAnalytics: psde.skipAnalytics || false,
  }));

  const addedElements = [];

  // 2. Create new DEs if requested, then queue them for the stage
  if (hasNewDEs) {
    const allOptions = [];
    const allOptionSets = [];
    const allNewDEs = [];
    const optionSetUidMap = {};
    const deUidMap = {};
    const seenDEShortNames = new Set();

    for (const de of args.data_elements) {
      if (de.option_set && de.option_set.name && de.option_set.options?.length) {
        if (!optionSetUidMap[de.option_set.name]) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
          allOptions.push(...options);
          allOptionSets.push(optionSet);
          optionSetUidMap[de.option_set.name] = osUid;
        }
      }
      const { elem, uid } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames);
      allNewDEs.push(elem);
      deUidMap[de.name] = uid;
    }

    // Pre-probe DHIS2 for shortName collisions on these new DEs.
    await disambiguateShortNamesAgainstServer(allNewDEs, 'dataElements', 'dataElements');

    // Import new DEs first via metadata endpoint
    const dePayload = {};
    if (allOptions.length) dePayload.options = allOptions;
    if (allOptionSets.length) dePayload.optionSets = allOptionSets;
    dePayload.dataElements = allNewDEs;
    const deResult = await postMetadataPayload(dePayload, args.dry_run_only);
    if (!deResult.success) return deResult;

    for (const de of args.data_elements) {
      const deId = deUidMap[de.name];
      if (!existingIds.has(deId)) {
        sortCounter++;
        updatedPsdes.push({
          dataElement: { id: deId },
          compulsory: de.compulsory || false,
          allowProvidedElsewhere: false,
          sortOrder: sortCounter,
          displayInReports: false,
          allowFutureDate: false,
          renderOptionsAsRadio: false,
          skipSynchronization: false,
          skipAnalytics: false,
        });
        addedElements.push({ id: deId, name: de.name });
      }
    }
  }

  // 3. Add existing DE IDs (skip duplicates already in the stage)
  if (hasExistingIds) {
    for (const deId of args.data_element_ids) {
      if (!existingIds.has(deId)) {
        sortCounter++;
        updatedPsdes.push({
          dataElement: { id: deId },
          compulsory: false,
          allowProvidedElsewhere: false,
          sortOrder: sortCounter,
          displayInReports: false,
          allowFutureDate: false,
          renderOptionsAsRadio: false,
          skipSynchronization: false,
          skipAnalytics: false,
        });
        addedElements.push({ id: deId });
      } else {
        addedElements.push({ id: deId, note: 'already_in_stage' });
      }
    }
  }

  if (args.dry_run_only) {
    return {
      success: true, phase: 'dry_run',
      message: 'Dry run: no changes made.',
      stage_id: args.stage_id, stage_name: stageResp.name,
      would_add: addedElements.filter(e => !e.note),
    };
  }

  // 4. PUT the complete stage back with name + program + full programStageDataElements
  // DHIS2 PUT on programStages requires 'name' and 'program' — sending only
  // programStageDataElements causes 409 "Missing required property name".
  const stageUpdate = {
    name: stageResp.name,
    program: { id: stageResp.program.id },
    sortOrder: stageResp.sortOrder,
    repeatable: stageResp.repeatable || false,
    programStageDataElements: updatedPsdes,
  };

  const putResp = await safeDhis2Fetch(`programStages/${args.stage_id}`, {
    method: 'PUT',
    body: stageUpdate,
  });
  if (putResp._error) return { _error: `Failed to update stage: ${putResp._error}` };

  // Surface any DHIS2 import-level errors from the PUT response
  const putStatus = putResp?.status || putResp?.response?.status;
  if (putStatus === 'ERROR') {
    const typeReports = putResp?.response?.typeReports || [];
    const errors = [];
    for (const tr of typeReports) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) errors.push(er.message);
      }
    }
    return { _error: `Stage update failed: ${putResp?.message || 'Unknown error'}`, errors };
  }

  return {
    success: true,
    stage_id: args.stage_id,
    stage_name: stageResp.name,
    added_elements: addedElements,
    total_elements: updatedPsdes.length,
  };
}

// ── manage_metadata: remove from stage, delete, check references ──────────
async function executeManageMetadata(args) {
  const action = args.action;

  // ── remove_from_stage: Remove data element(s) from a program stage ──
  if (action === 'remove_from_stage') {
    const _gate = requireWriteAuth('manage_metadata', 'remove_from_stage', { stage_id: args.stage_id });
    if (_gate) return _gate;
    if (!args.stage_id) return { _error: 'stage_id required for remove_from_stage' };
    if (!args.data_element_ids?.length) return { _error: 'data_element_ids (array of DE UIDs) required for remove_from_stage' };

    // Fetch the full current stage — we need name + program for a valid PUT
    const stageResp = await safeDhis2Fetch(
      `programStages/${args.stage_id}?fields=id,name,program[id],sortOrder,repeatable,programStageDataElements[id,dataElement[id,name],compulsory,allowProvidedElsewhere,sortOrder,displayInReports,allowFutureDate,renderOptionsAsRadio,skipSynchronization,skipAnalytics]`
    );
    if (stageResp._error) return { _error: `Could not load stage ${args.stage_id}: ${stageResp._error}` };
    if (!stageResp.name || !stageResp.program?.id) return { _error: `Stage ${args.stage_id} is missing required 'name' or program reference` };

    const removeSet = new Set(args.data_element_ids);
    const existing = stageResp.programStageDataElements || [];
    const removed = [];
    const kept = [];

    for (const psde of existing) {
      const deId = psde.dataElement?.id;
      if (removeSet.has(deId)) {
        removed.push({ id: deId, name: psde.dataElement?.name || deId });
      } else {
        kept.push({
          id: psde.id,
          dataElement: { id: deId },
          compulsory: psde.compulsory || false,
          allowProvidedElsewhere: psde.allowProvidedElsewhere || false,
          sortOrder: psde.sortOrder,
          displayInReports: psde.displayInReports || false,
          allowFutureDate: psde.allowFutureDate || false,
          renderOptionsAsRadio: psde.renderOptionsAsRadio || false,
          skipSynchronization: psde.skipSynchronization || false,
          skipAnalytics: psde.skipAnalytics || false,
        });
      }
    }

    if (removed.length === 0) {
      return {
        _error: `None of the specified data elements were found in stage "${stageResp.name}"`,
        stage_elements: existing.map(e => ({ id: e.dataElement?.id, name: e.dataElement?.name })),
      };
    }

    // Snapshot the stage BEFORE we mutate it.
    const backup = await ensureBackupOrBail(
      { operation: 'remove_from_stage', tool: 'manage_metadata', action: 'remove_from_stage', reason: `Removing ${removed.length} data element(s) from stage ${stageResp.name}` },
      [{ object_type: 'programStages', object_id: args.stage_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // PUT the complete stage back without the removed elements
    const stageUpdate = {
      name: stageResp.name,
      program: { id: stageResp.program.id },
      sortOrder: stageResp.sortOrder,
      repeatable: stageResp.repeatable || false,
      programStageDataElements: kept,
    };

    const putResp = await safeDhis2Fetch(`programStages/${args.stage_id}`, {
      method: 'PUT',
      body: stageUpdate,
    });
    if (putResp._error) return { _error: `Failed to update stage: ${putResp._error}`, backup: backup.block };

    // Check for import-level errors
    const putStatus = putResp?.status || putResp?.response?.status;
    if (putStatus === 'ERROR') {
      const errors = [];
      for (const tr of (putResp?.response?.typeReports || [])) {
        for (const or of (tr.objectReports || [])) {
          for (const er of (or.errorReports || [])) errors.push(er.message);
        }
      }
      return { _error: `Stage update failed: ${putResp?.message || 'Unknown error'}`, errors, backup: backup.block };
    }

    return {
      success: true,
      action: 'remove_from_stage',
      stage_id: args.stage_id,
      stage_name: stageResp.name,
      removed_elements: removed,
      remaining_elements: kept.length,
      backup: backup.block,
    };
  }

  // ── check_references: Inspect dependencies of a metadata object ──
  if (action === 'check_references') {
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for check_references' };
    return await checkMetadataReferences(args.object_type, args.object_id);
  }

  // ── delete: Delete a metadata object with smart reference checking ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_metadata', 'delete', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for delete' };

    // Verify the object exists first
    const objResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,name,displayName`);
    if (objResp._error) {
      if (objResp._status === 404) return { success: true, message: 'Object does not exist (already deleted or never existed).' };
      return { _error: `Could not verify object: ${objResp._error}` };
    }
    const objName = objResp.displayName || objResp.name || args.object_id;

    // Check references before attempting deletion
    const refsResult = await checkMetadataReferences(args.object_type, args.object_id);
    if (refsResult.has_references) {
      return {
        _error: `Cannot delete ${objName} (${args.object_type}/${args.object_id}) because it has active references that must be removed first.`,
        references: refsResult.references,
        _hint: buildDeletionHint(args.object_type, args.object_id, refsResult.references),
      };
    }

    // Programs own rules / rule variables / indicators that DHIS2 2.4x does
    // NOT reliably cascade — deleting a program that still has programRules or
    // PRVs 500s with "Transaction silently rolled back because it has been
    // marked as rollback-only" (verified live on 2.42, 2026-07-11; the same
    // delete succeeds once the dependents are removed first). Gather the
    // wholly-owned dependents so they are snapshotted WITH the program and
    // deleted child→parent before the program itself.
    const cascadePlan = [];
    if (args.object_type === 'programs') {
      const [piResp, ruleResp, prvResp] = await Promise.all([
        safeDhis2Fetch(`programIndicators?filter=program.id:eq:${args.object_id}&fields=id,name&pageSize=200`),
        safeDhis2Fetch(`programRules?filter=program.id:eq:${args.object_id}&fields=id,name&pageSize=200`),
        safeDhis2Fetch(`programRuleVariables?filter=program.id:eq:${args.object_id}&fields=id,name&pageSize=200`),
      ]);
      const add = (arr, type) => { for (const o of (arr || [])) if (o?.id) cascadePlan.push({ type, id: o.id, name: o.name }); };
      add(piResp.programIndicators, 'programIndicators');
      add(ruleResp.programRules, 'programRules');
      add(prvResp.programRuleVariables, 'programRuleVariables');
    }

    // Snapshot the object BEFORE attempting deletion. The reference-check
    // above filters most failure cases; if the delete still fails, the
    // backup is preserved so the user can inspect what would have been lost.
    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_metadata', action: 'delete', reason: `Deleting ${args.object_type}/${args.object_id} (${objName})` },
      [
        { object_type: args.object_type, object_id: args.object_id, role: 'primary' },
        ...cascadePlan.map(c => ({ object_type: c.type, object_id: c.id, role: 'cascade' })),
      ],
      args
    );
    if (!backup.ok) return backup.error;

    // Delete the program's owned dependents first (indicators, then rules —
    // whose actions cascade — then rule variables).
    const cascade_deleted = [];
    for (const type of ['programIndicators', 'programRules', 'programRuleVariables']) {
      const idsOfType = cascadePlan.filter(c => c.type === type).map(c => ({ id: c.id }));
      if (!idsOfType.length) continue;
      const r = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
        method: 'POST',
        body: { [type]: idsOfType },
      });
      if (r._error) {
        return {
          _error: `Deletion aborted: could not remove the program's ${type} first (${r._error}). The program itself was NOT deleted.`,
          cascade_deleted,
          backup: backup.block,
        };
      }
      cascade_deleted.push({ type, count: idsOfType.length });
    }

    // Attempt deletion via POST /api/metadata?importStrategy=DELETE
    const deletePayload = { [args.object_type]: [{ id: args.object_id }] };
    const delResp = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL', {
      method: 'POST',
      body: deletePayload,
    });

    if (delResp._error) {
      return { _error: `Deletion failed: ${delResp._error}`, backup: backup.block, ...(cascade_deleted.length ? { cascade_deleted } : {}) };
    }

    const stats = delResp?.response?.stats || delResp?.stats || {};
    const typeReports = delResp?.response?.typeReports || [];

    if (stats.deleted >= 1) {
      return {
        success: true,
        deleted: { type: args.object_type, id: args.object_id, name: objName },
        message: `Successfully deleted ${objName}.`,
        ...(cascade_deleted.length ? { cascade_deleted } : {}),
        backup: backup.block,
      };
    }

    const errorMessages = [];
    for (const tr of typeReports) {
      for (const or of (tr.objectReports || [])) {
        for (const er of (or.errorReports || [])) {
          errorMessages.push(er.message);
        }
      }
    }

    if (errorMessages.length > 0) {
      const hasEventData = errorMessages.some(e => /associated with another object.*Event/i.test(e));
      return {
        _error: `Cannot delete ${objName}: ${errorMessages.join('; ')}`,
        error_details: errorMessages,
        _hint: hasEventData
          ? `This data element has been used in submitted events — DHIS2 prevents deletion to preserve data integrity. Options:\n(a) Keep as unused metadata (recommended — preserves historical data)\n(b) Remove all event data values referencing this DE first, then retry deletion`
          : 'Resolve the reported conflicts above, then retry deletion.',
        backup: backup.block,
      };
    }

    return {
      _error: `Deletion of ${objName} was not applied. DHIS2 import stats: ${JSON.stringify(stats)}`,
      _hint: 'The object may have hidden dependencies. Check the DHIS2 server logs for details.',
      backup: backup.block,
    };
  }

  // ── update_program_org_units: set/add/remove program organisation units ──
  if (action === 'update_program_org_units') {
    const _gate = requireWriteAuth('manage_metadata', 'update_program_org_units', { program_id: args.program_id || args.object_id });
    if (_gate) return _gate;
    const programId = args.program_id || args.object_id;
    if (!programId) return { _error: 'program_id or object_id required for update_program_org_units' };
    if (!Array.isArray(args.org_unit_ids)) return { _error: 'org_unit_ids array required for update_program_org_units' };

    const mergeMode = ['replace', 'add', 'remove'].includes(args.merge_mode) ? args.merge_mode : 'replace';
    const requestedIds = [...new Set(args.org_unit_ids.filter(Boolean))];

    const progResp = await safeDhis2Fetch(
      `programs/${programId}?fields=id,displayName,name,shortName,programType,organisationUnits[id,displayName]`
    );
    if (progResp._error) return { _error: `Could not fetch program ${programId}: ${progResp._error}` };

    const currentOrgUnits = Array.isArray(progResp.organisationUnits) ? progResp.organisationUnits : [];
    const currentIds = currentOrgUnits.map(ou => ou.id).filter(Boolean);
    let nextIds;
    if (mergeMode === 'add') {
      nextIds = [...new Set([...currentIds, ...requestedIds])];
    } else if (mergeMode === 'remove') {
      const removeSet = new Set(requestedIds);
      nextIds = currentIds.filter(id => !removeSet.has(id));
    } else {
      nextIds = requestedIds;
    }

    const payload = {
      programs: [{
        id: progResp.id,
        name: progResp.name || progResp.displayName || progResp.id,
        shortName: progResp.shortName || progResp.name || progResp.displayName || progResp.id,
        programType: progResp.programType,
        organisationUnits: nextIds.map(id => ({ id })),
      }],
    };

    // Skip backup on a pure dry-run (nothing will be committed).
    let backup = { ok: true, block: null, skipped: false };
    if (!args.dry_run_only) {
      backup = await ensureBackupOrBail(
        { operation: 'update_program_org_units', tool: 'manage_metadata', action: 'update_program_org_units', reason: `merge_mode=${mergeMode} on ${requestedIds.length} OU(s)` },
        [{ object_type: 'programs', object_id: programId, role: 'primary' }],
        args
      );
      if (!backup.ok) return backup.error;
    }

    const result = await postMetadataPayload(payload, args.dry_run_only);
    if (!result.success) return { ...result, backup: backup.block };

    if (args.dry_run_only) {
      return {
        ...result,
        action: 'update_program_org_units',
        program_id: progResp.id,
        program_name: progResp.displayName || progResp.name || progResp.id,
        merge_mode: mergeMode,
        current_org_units: currentIds.length,
        requested_org_units: requestedIds.length,
        resulting_org_units: nextIds.length,
      };
    }

    const verifyResp = await safeDhis2Fetch(
      `programs/${programId}?fields=id,displayName,organisationUnits[id,displayName]`
    );
    if (verifyResp._error) {
      return {
        success: true,
        action: 'update_program_org_units',
        program_id: progResp.id,
        program_name: progResp.displayName || progResp.name || progResp.id,
        merge_mode: mergeMode,
        current_org_units: currentIds.length,
        resulting_org_units: nextIds.length,
        _warning: `Update committed, but verification fetch failed: ${verifyResp._error}`,
        backup: backup.block,
      };
    }

    const verifiedOrgUnits = Array.isArray(verifyResp.organisationUnits) ? verifyResp.organisationUnits : [];
    const verifiedMap = new Map(verifiedOrgUnits.map(ou => [ou.id, ou.displayName || ou.id]));
    const verifiedIds = verifiedOrgUnits.map(ou => ou.id).filter(Boolean);
    const currentSet = new Set(currentIds);
    const verifiedSet = new Set(verifiedIds);

    return {
      success: true,
      action: 'update_program_org_units',
      program_id: verifyResp.id,
      program_name: verifyResp.displayName || progResp.displayName || progResp.name || progResp.id,
      merge_mode: mergeMode,
      previous_org_units: currentIds.length,
      resulting_org_units: verifiedIds.length,
      added_org_units: verifiedIds
        .filter(id => !currentSet.has(id))
        .slice(0, 50)
        .map(id => ({ id, name: verifiedMap.get(id) || id })),
      removed_org_units: currentOrgUnits
        .filter(ou => !verifiedSet.has(ou.id))
        .slice(0, 50)
        .map(ou => ({ id: ou.id, name: ou.displayName || ou.id })),
      org_unit_sample: verifiedOrgUnits
        .slice(0, 20)
        .map(ou => ({ id: ou.id, name: ou.displayName || ou.id })),
      _note: 'Program organisationUnits control where the program is assigned/available in Capture and Tracker. This is separate from sharing/publicAccess.',
      backup: backup.block,
    };
  }

  // ── update_sharing: Update sharing/access settings via the DHIS2 sharing API ──
  if (action === 'update_sharing') {
    const _gate = requireWriteAuth('manage_metadata', 'update_sharing', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for update_sharing' };

    // Map plural API type names to singular form for the sharing endpoint
    const sharingTypeMap = {
      programs: 'program', dataSets: 'dataSet', dataElements: 'dataElement',
      indicators: 'indicator', optionSets: 'optionSet',
      trackedEntityAttributes: 'trackedEntityAttribute',
      programStages: 'programStage', categoryOptions: 'categoryOption',
      categories: 'category', categoryCombos: 'categoryCombo',
      dataElementGroups: 'dataElementGroup', indicatorGroups: 'indicatorGroup',
      dashboards: 'dashboard', visualizations: 'visualization',
      maps: 'map', eventReports: 'eventReport', eventCharts: 'eventChart',
      options: 'option',
    };
    const singularType = sharingTypeMap[args.object_type] || args.object_type;

    // 1. Fetch current sharing settings
    const currentResp = await safeDhis2Fetch(`sharing?type=${singularType}&id=${args.object_id}`);
    if (currentResp._error) return { _error: `Could not fetch current sharing for ${args.object_type}/${args.object_id}: ${currentResp._error}` };
    const obj = currentResp.object;
    if (!obj) return { _error: `No sharing object returned for ${args.object_type}/${args.object_id}` };

    const previousPublicAccess = obj.publicAccess;

    // Snapshot the object BEFORE we change sharing.
    const backup = await ensureBackupOrBail(
      { operation: 'update_sharing', tool: 'manage_metadata', action: 'update_sharing', reason: `Sharing update on ${args.object_type}/${args.object_id}` },
      [{ object_type: args.object_type, object_id: args.object_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // 2. Apply requested changes (merge with existing). Every access string is
    // pushed through normalizeAccessString so a malformed input ("r--------",
    // "rwx-----", "rwrw") never reaches DHIS2 — which rejects the whole PUT
    // with "Invalid access string" and leaves the object's prior sharing intact
    // but wedges any caller waiting on success.
    if (args.public_access !== undefined) {
      obj.publicAccess = normalizeAccessString(args.public_access, obj.publicAccess || 'rw------');
    }
    if (Array.isArray(args.user_group_accesses)) {
      obj.userGroupAccesses = args.user_group_accesses.map(e => ({
        ...e,
        access: normalizeAccessString(e.access, 'rw------'),
      }));
    }
    if (Array.isArray(args.user_accesses)) {
      obj.userAccesses = args.user_accesses.map(e => ({
        ...e,
        access: normalizeAccessString(e.access, 'rw------'),
      }));
    }

    // 3. PUT to the DHIS2 sharing API
    const putResp = await safeDhis2Fetch(`sharing?type=${singularType}&id=${args.object_id}`, {
      method: 'PUT',
      body: { object: obj },
    });
    if (putResp._error) return { _error: `Failed to update sharing: ${putResp._error}`, backup: backup.block };

    // 4. Verify the update
    const verifyResp = await safeDhis2Fetch(`sharing?type=${singularType}&id=${args.object_id}`);
    const verified = verifyResp.object || {};

    return {
      success: true,
      action: 'update_sharing',
      object_type: args.object_type,
      object_id: args.object_id,
      object_name: obj.displayName || obj.name || args.object_id,
      previous_public_access: previousPublicAccess,
      new_public_access: verified.publicAccess || obj.publicAccess,
      user_group_accesses: (verified.userGroupAccesses || obj.userGroupAccesses || []).length,
      user_accesses: (verified.userAccesses || obj.userAccesses || []).length,
      _access_key: 'Positions 1-2=metadata(rw), 3-4=data(rw). "rwrw----"=full, "rw------"=metadata only, "r-r-----"=read-only.',
      backup: backup.block,
    };
  }

  // ── add_program_attributes: attach TEAs (existing or new) to an existing program ──
  // This is the correct path for "add name/age as searchable attributes to program X".
  // The naive routes fail:
  //   - PATCH programs/{id} with application/json → 415 (DHIS2 requires application/json-patch+json)
  //   - POST programTrackedEntityAttributes              → 404 (not a real endpoint)
  //   - POST metadata with just programTrackedEntityAttributes → ignored / 409
  // Correct path: GET the full program, append new programTrackedEntityAttributes
  // entries, then PUT the full object back.
  if (action === 'add_program_attributes') {
    const _gate = requireWriteAuth('manage_metadata', 'add_program_attributes', { program_id: args.program_id || args.object_id });
    if (_gate) return _gate;
    const progId = args.program_id || args.object_id;
    if (!progId) return { _error: 'program_id (or object_id) is required for add_program_attributes' };
    const attrs = args.program_attributes || [];
    if (!attrs.length) return { _error: 'program_attributes must be a non-empty array for add_program_attributes' };

    // 1. Fetch the full program — we need the complete object back to PUT it.
    const progResp = await safeDhis2Fetch(
      `programs/${progId}?fields=:owner,programTrackedEntityAttributes[:owner,trackedEntityAttribute[id,name]]`
    );
    if (progResp?._error) return { _error: `Could not load program ${progId}: ${progResp._error}` };
    if (!progResp?.id) return { _error: `Program ${progId} not found.` };

    // Resolve default categoryCombo for any new TEAs (not strictly required on TEA but safe-guard).
    const catComboResp = await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id&pageSize=1');
    const defaultCatComboId = catComboResp?.categoryCombos?.[0]?.id || null;

    const existingPtas = progResp.programTrackedEntityAttributes || [];
    const existingTeaIds = new Set(existingPtas.map(p => p.trackedEntityAttribute?.id).filter(Boolean));
    const maxSort = existingPtas.reduce((m, p) => Math.max(m, p.sortOrder || 0), 0);
    let nextSort = maxSort;

    // 2. Resolve/create each requested TEA.
    const newlyCreatedTeas = [];
    const newlyCreatedOptions = [];
    const newlyCreatedOptionSets = [];
    const resolvedAttrs = []; // [{ teaId, cfg }]

    for (const a of attrs) {
      let teaId = a.id || null;

      if (!teaId && a.name) {
        const found = await safeDhis2Fetch(
          `trackedEntityAttributes?filter=name:eq:${encodeURIComponent(a.name)}&fields=id,name&pageSize=1`
        );
        // Probe failure ≠ "does not exist". Creating here would duplicate an
        // attribute we simply could not see — abort loudly instead.
        if (found?._error) {
          return { _error: `Could not check for an existing attribute named "${a.name}" (${found._error}). Aborting BEFORE creating anything to avoid duplicating an attribute that may already exist. Nothing was changed — verify connectivity and retry.` };
        }
        teaId = found?.trackedEntityAttributes?.[0]?.id || null;
      }

      if (!teaId) {
        // Create a new TEA. value_type is required; otherwise skip with clear error.
        if (!a.name || !a.value_type) {
          return { _error: `Cannot resolve or create attribute: provide id, or name + value_type. Got: ${JSON.stringify(a)}` };
        }
        const teaUid = generateDhis2Uid();
        const tea = {
          id: teaUid,
          name: a.name,
          shortName: clampShortName(a.short_name, a.name, null, 'Attribute'),
          valueType: a.value_type,
          aggregationType: 'NONE',
        };
        if (a.option_set?.name && a.option_set.options?.length) {
          const { optionSet, options, osUid } = buildOptionSetAndOptions(a.option_set);
          newlyCreatedOptions.push(...options);
          newlyCreatedOptionSets.push(optionSet);
          tea.optionSet = { id: osUid };
        }
        newlyCreatedTeas.push(tea);
        teaId = teaUid;
      }

      resolvedAttrs.push({ teaId, cfg: a });
    }

    // 3. If we created any new TEAs / option sets, import them first in one atomic POST.
    //    These are pure-create — no snapshot needed.
    if (newlyCreatedTeas.length || newlyCreatedOptionSets.length) {
      // Pre-probe DHIS2 for shortName collisions before committing.
      await disambiguateShortNamesAgainstServer(newlyCreatedTeas, 'trackedEntityAttributes', 'trackedEntityAttributes');
      const pre = {};
      if (newlyCreatedOptions.length) pre.options = newlyCreatedOptions;
      if (newlyCreatedOptionSets.length) pre.optionSets = newlyCreatedOptionSets;
      if (newlyCreatedTeas.length) pre.trackedEntityAttributes = newlyCreatedTeas;
      const preResult = await postMetadataPayload(pre, false);
      if (!preResult.success) {
        return { _error: `Failed to create prerequisite attributes/option sets: ${preResult._error || 'unknown'}`, phase: 'prerequisites', details: preResult };
      }
    }

    // Snapshot the program BEFORE we mutate its TEA list.
    const backup = await ensureBackupOrBail(
      { operation: 'add_program_attributes', tool: 'manage_metadata', action: 'add_program_attributes', reason: `Adding ${attrs.length} attribute(s) to program ${progResp.name || progId}` },
      [{ object_type: 'programs', object_id: progId, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    // 4. Append new programTrackedEntityAttributes entries.
    const updatedProgram = { ...progResp };
    const updatedPtas = [...existingPtas];
    const addedAttrs = [];
    for (const { teaId, cfg } of resolvedAttrs) {
      if (existingTeaIds.has(teaId)) {
        addedAttrs.push({ trackedEntityAttribute: teaId, skipped: 'already_on_program' });
        continue;
      }
      nextSort += 1;
      updatedPtas.push({
        trackedEntityAttribute: { id: teaId },
        mandatory: cfg.mandatory === true,
        searchable: cfg.searchable === true,
        displayInList: cfg.display_in_list !== false,
        sortOrder: nextSort,
      });
      addedAttrs.push({ trackedEntityAttribute: teaId, searchable: cfg.searchable === true, displayInList: cfg.display_in_list !== false });
    }
    updatedProgram.programTrackedEntityAttributes = updatedPtas;

    // 5. PUT the full program back. DHIS2 supports PUT /api/{ver}/programs/{id} with
    //    Content-Type: application/json — this is the correct update path (not PATCH).
    const putResp = await safeDhis2Fetch(`programs/${progId}`, {
      method: 'PUT',
      body: updatedProgram,
    });
    if (putResp?._error) {
      return { _error: `Failed to update program: ${putResp._error}`, phase: 'update_program', backup: backup.block };
    }

    // 6. Verify.
    const verifyResp = await safeDhis2Fetch(
      `programs/${progId}?fields=id,name,programTrackedEntityAttributes[trackedEntityAttribute[id,displayName],searchable,displayInList,mandatory,sortOrder]`
    );
    const verifiedPtas = verifyResp?.programTrackedEntityAttributes || [];

    return {
      success: true,
      action: 'add_program_attributes',
      program_id: progId,
      added: addedAttrs,
      created_trackedEntityAttributes: newlyCreatedTeas.map(t => ({ id: t.id, name: t.name, valueType: t.valueType })),
      created_option_sets: newlyCreatedOptionSets.map(o => ({ id: o.id, name: o.name })),
      program_attributes_after: verifiedPtas.map(p => ({
        id: p.trackedEntityAttribute?.id,
        name: p.trackedEntityAttribute?.displayName,
        searchable: p.searchable,
        displayInList: p.displayInList,
        mandatory: p.mandatory,
        sortOrder: p.sortOrder,
      })),
      backup: backup.block,
    };
  }

  // ── discover_icons: bulk verify icon keys before update_style ─────────────
  // DHIS2 has a fixed icon library. Models routinely fabricate plausible keys
  // ("tuberculosis_positive", "diabetes_positive") — update_style now refuses
  // unverified keys, so the model has to come through this action first. One
  // tool call burns N parallel /icons?search= queries (one per keyword) and
  // returns every match it found, plus a deduped flat key list. The keys are
  // also added to dhis2.knownIcons so the immediate update_style call passes
  // the verify-before-write gate without re-checking.
  if (action === 'discover_icons') {
    const rawKeywords = Array.isArray(args.keywords) ? args.keywords : [];
    const keywords = [...new Set(
      rawKeywords
        .map(k => String(k || '').trim().toLowerCase())
        .filter(k => k && k.length >= 3)
    )];
    if (!keywords.length) {
      return {
        _error: 'discover_icons requires keywords[] (an array of 4-8 short keyword roots).',
        _hint: 'DHIS2 icon search is prefix-on-keyword. Use SHORT roots: ["lung","respir","tb","medical","clinic"] not ["tuberculosis","respiratory"]. The latter return 0 because the trailing letters break prefix matching.',
      };
    }
    if (!(dhis2.knownIcons instanceof Set)) dhis2.knownIcons = new Set();

    // Run searches in parallel — single round-trip latency for all keywords.
    const searches = await Promise.all(keywords.map(async (kw) => {
      const r = await safeDhis2Fetch(`icons?search=${encodeURIComponent(kw)}&fields=key,keywords&pageSize=20`);
      const list = (r?.icons || []).map(i => ({ key: i.key, keywords: i.keywords || [] }));
      return { keyword: kw, matches: list };
    }));

    const byKeyword = {};
    const allKeysSet = new Set();
    for (const s of searches) {
      byKeyword[s.keyword] = s.matches;
      for (const m of s.matches) {
        allKeysSet.add(m.key);
        dhis2.knownIcons.add(m.key);
      }
    }

    const allKeys = [...allKeysSet];
    const noneMatched = allKeys.length === 0;

    return {
      success: true,
      action: 'discover_icons',
      keywords_tried: keywords,
      results: byKeyword,
      verified_keys: allKeys,
      total_unique_matches: allKeys.length,
      ...(noneMatched ? {
        _hint: 'No icons matched any of these keyword roots. DHIS2 search needs SHORTER prefixes — e.g. "preg" not "pregnan", "respir" not "respiratory". Try again with broader or shorter roots, OR fall back to generic terms ("medical","clinic","health","hospital","stethoscope","syringe","capsule") that almost always return matches. If still nothing, skip the icon and call update_style with only `color`.',
      } : {
        _next: 'Pick ONE key from verified_keys[] (or from results[<keyword>]) and call manage_metadata(action=update_style, object_type=..., object_id=..., icon=<exact key>, color=...). Do NOT modify the key — pass it verbatim.',
      }),
    };
  }

  // ── update_style: set display icon + color on any styled metadata object ──
  // DHIS2 PATCH requires application/json-patch+json (safeDhis2Fetch handles this now).
  // Icon must be a key already verified this turn (in dhis2.knownIcons) — the
  // verify-before-write gate prevents the failure mode where the model picks a
  // plausible-but-fabricated key, eats a 404, then has to retry. If the model
  // somehow sends an unverified key we still run the resolver, and on success
  // record the canonical key into knownIcons so the gate stays consistent.
  if (action === 'update_style') {
    const _gate = requireWriteAuth('manage_metadata', 'update_style', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for update_style' };
    if (args.icon == null && args.color == null) return { _error: 'Provide at least one of: icon, color.' };

    const stylableTypes = new Set([
      'programs', 'programStages', 'dataElements', 'optionSets',
      'trackedEntityAttributes', 'indicators', 'options',
    ]);
    if (!stylableTypes.has(args.object_type)) {
      return { _error: `object_type "${args.object_type}" does not expose a style field. Supported: ${[...stylableTypes].join(', ')}.` };
    }

    // Verify the object exists and capture current style.
    const objResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,displayName,name,style`);
    if (objResp._error) return { _error: `Could not load ${args.object_type}/${args.object_id}: ${objResp._error}` };
    if (!objResp.id) return { _error: `${args.object_type}/${args.object_id} not found.` };

    // Verify-before-write: icon MUST come from a discover_icons response in
    // this turn (or have surfaced organically through any other tool result
    // that exposes /icons or `style.icon` data). Block fabricated keys at
    // the gate — failed PATCH attempts on made-up keys ("tuberculosis_positive",
    // "diabetes_positive") were burning round trips and frustrating the user.
    let resolvedIcon = args.icon ? String(args.icon).trim() : undefined;
    let iconLookupNote = null;
    if (resolvedIcon) {
      if (!(dhis2.knownIcons instanceof Set)) dhis2.knownIcons = new Set();
      const isPreVerified = dhis2.knownIcons.has(resolvedIcon);

      if (!isPreVerified) {
        // Step 1: a model that supplies an unverified key MUST go through
        // discover_icons first. Refuse before doing any network work — even
        // the resolver call would be wasted bandwidth here.
        return {
          _error: `Icon "${resolvedIcon}" was not verified this turn. update_style refuses unverified icon keys.`,
          _hint: 'Call manage_metadata(action=discover_icons, keywords=["<short-root1>","<short-root2>",...]) FIRST to discover real DHIS2 icons relevant to this object. Then call update_style again with one of the keys returned in `verified_keys[]`. Use SHORT keyword roots: ["lung","respir","tb","medical","clinic"] for a TB program, not ["tuberculosis","respiratory"] (those return 0 because DHIS2 search is prefix-on-keyword). Common fabrications that DO NOT exist: tuberculosis_positive, diabetes_positive, vaccine_positive, pregnancy_positive (real key is pregnant_positive).',
          _scope: 'icon_not_verified',
          _attempted_icon: resolvedIcon,
          _verified_icons_this_turn: [...dhis2.knownIcons].slice(0, 30),
        };
      }

      // Pre-verified: still run the canonical-key check to defend against
      // typos in the verified-key copy. resolveDhis2IconKey() is cheap when
      // exact-key path hits.
      const resolution = await resolveDhis2IconKey(resolvedIcon);
      if (!resolution.ok) {
        // Should be unreachable (key was in knownIcons) but bail safely if
        // the icon was deleted between discover and update.
        return {
          _error: `Icon "${resolvedIcon}" was reported verified but no longer resolves on the server (${resolution.error}).`,
          _hint: 'Re-run manage_metadata(action=discover_icons,...) to get a current list and pick a still-existing key.',
          _scope: 'icon_disappeared',
        };
      }
      resolvedIcon = resolution.key;
      dhis2.knownIcons.add(resolvedIcon);
      if (resolution.note) iconLookupNote = resolution.note;
    }

    // Build the JSON Patch. If a style object already exists, use replace; otherwise add.
    const currentStyle = objResp.style || null;
    const newStyle = {
      ...(currentStyle || {}),
      ...(resolvedIcon !== undefined ? { icon: resolvedIcon } : {}),
      ...(args.color !== undefined ? { color: String(args.color) } : {}),
    };
    const patchOp = currentStyle ? 'replace' : 'add';
    const patchBody = [{ op: patchOp, path: '/style', value: newStyle }];

    // Snapshot the object BEFORE patching style.
    const backup = await ensureBackupOrBail(
      { operation: 'update_style', tool: 'manage_metadata', action: 'update_style', reason: `Style change on ${args.object_type}/${args.object_id} (icon=${resolvedIcon || '-'}, color=${args.color || '-'})` },
      [{ object_type: args.object_type, object_id: args.object_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const patchResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}`, {
      method: 'PATCH',
      body: patchBody,
    });
    if (patchResp?._error) return { _error: `Failed to update style: ${patchResp._error}`, _hint: iconLookupNote, backup: backup.block };

    // Verify
    const verifyResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,displayName,style`);
    return {
      success: true,
      action: 'update_style',
      object_type: args.object_type,
      object_id: args.object_id,
      object_name: verifyResp?.displayName || objResp.displayName || objResp.name || args.object_id,
      previous_style: currentStyle,
      new_style: verifyResp?.style || newStyle,
      ...(iconLookupNote ? { icon_resolution: iconLookupNote } : {}),
      backup: backup.block,
    };
  }

  // ── convert_value_type: flip valueType on a DE/TEA/optionSet and cascade ──
  // DHIS2 multi-select (MULTI_TEXT) requires BOTH the DE/TEA AND its optionSet to
  // be MULTI_TEXT — otherwise the New Tracker Capture form renders a single-select
  // dropdown even though the field stores comma-separated codes. Patching only one
  // side leaves a broken pair that nobody notices until users try to multi-pick.
  if (action === 'convert_value_type') {
    const _gate = requireWriteAuth('manage_metadata', 'convert_value_type', { object_type: args.object_type, object_id: args.object_id });
    if (_gate) return _gate;
    if (!args.object_type || !args.object_id) return { _error: 'object_type and object_id required for convert_value_type' };
    if (!args.value_type) return { _error: 'value_type required (e.g. "MULTI_TEXT", "TEXT", "LONG_TEXT")' };
    const newVT = String(args.value_type).trim().toUpperCase();

    const supportedTypes = new Set(['dataElements', 'trackedEntityAttributes', 'optionSets']);
    if (!supportedTypes.has(args.object_type)) {
      return { _error: `convert_value_type only supports dataElements, trackedEntityAttributes, optionSets — got "${args.object_type}".` };
    }

    // Targets: each {object_type, object_id, current_value_type} we will patch.
    const targets = [];
    let cascadedFrom = null;

    if (args.object_type === 'optionSets') {
      const osResp = await safeDhis2Fetch(`optionSets/${args.object_id}?fields=id,displayName,valueType`);
      if (osResp._error || !osResp.id) return { _error: `Could not load optionSets/${args.object_id}: ${osResp._error || 'not found'}` };
      targets.push({ object_type: 'optionSets', object_id: osResp.id, name: osResp.displayName, current: osResp.valueType });

      // Cascade: every DE that uses this option set
      const deResp = await safeDhis2Fetch(`dataElements?filter=optionSet.id:eq:${osResp.id}&fields=id,displayName,valueType&paging=false`);
      for (const de of (deResp?.dataElements || [])) {
        targets.push({ object_type: 'dataElements', object_id: de.id, name: de.displayName, current: de.valueType });
      }
      // Cascade: every TEA that uses this option set
      const teaResp = await safeDhis2Fetch(`trackedEntityAttributes?filter=optionSet.id:eq:${osResp.id}&fields=id,displayName,valueType&paging=false`);
      for (const tea of (teaResp?.trackedEntityAttributes || [])) {
        targets.push({ object_type: 'trackedEntityAttributes', object_id: tea.id, name: tea.displayName, current: tea.valueType });
      }
    } else {
      // dataElements or trackedEntityAttributes — load it, get its optionSet, then cascade upward.
      const objResp = await safeDhis2Fetch(`${args.object_type}/${args.object_id}?fields=id,displayName,valueType,optionSet[id,displayName,valueType]`);
      if (objResp._error || !objResp.id) return { _error: `Could not load ${args.object_type}/${args.object_id}: ${objResp._error || 'not found'}` };
      targets.push({ object_type: args.object_type, object_id: objResp.id, name: objResp.displayName, current: objResp.valueType });
      if (objResp.optionSet?.id) {
        cascadedFrom = args.object_type;
        // Add option set itself
        targets.push({ object_type: 'optionSets', object_id: objResp.optionSet.id, name: objResp.optionSet.displayName, current: objResp.optionSet.valueType });
        // Add every other DE/TEA referencing the same option set
        const deResp = await safeDhis2Fetch(`dataElements?filter=optionSet.id:eq:${objResp.optionSet.id}&fields=id,displayName,valueType&paging=false`);
        for (const de of (deResp?.dataElements || [])) {
          if (de.id !== objResp.id) targets.push({ object_type: 'dataElements', object_id: de.id, name: de.displayName, current: de.valueType });
        }
        const teaResp = await safeDhis2Fetch(`trackedEntityAttributes?filter=optionSet.id:eq:${objResp.optionSet.id}&fields=id,displayName,valueType&paging=false`);
        for (const tea of (teaResp?.trackedEntityAttributes || [])) {
          if (tea.id !== objResp.id) targets.push({ object_type: 'trackedEntityAttributes', object_id: tea.id, name: tea.displayName, current: tea.valueType });
        }
      } else if (newVT === 'MULTI_TEXT') {
        return {
          _error: `${args.object_type}/${args.object_id} has no optionSet — MULTI_TEXT requires an option set.`,
          _hint: `Use create_metadata to attach an option set first, or convert an optionSet that already has options.`,
        };
      }
    }

    // Filter out targets already at the new value type (idempotent)
    const toPatch = targets.filter(t => t.current !== newVT);
    if (!toPatch.length) {
      return {
        success: true,
        action: 'convert_value_type',
        new_value_type: newVT,
        already_correct: true,
        targets: targets.map(t => ({ object_type: t.object_type, object_id: t.object_id, name: t.name, value_type: t.current })),
        message: 'All targets already use the requested valueType.',
      };
    }

    // Pre-flight backup over every object we'll touch
    const backup = await ensureBackupOrBail(
      { operation: 'convert_value_type', tool: 'manage_metadata', action: 'convert_value_type', reason: `Convert valueType→${newVT} on ${args.object_type}/${args.object_id} (cascading to ${toPatch.length} object(s))` },
      toPatch.map((t, i) => ({ object_type: t.object_type, object_id: t.object_id, role: i === 0 ? 'primary' : 'cascade' })),
      args
    );
    if (!backup.ok) return backup.error;

    const results = [];
    for (const t of toPatch) {
      const patchResp = await safeDhis2Fetch(`${t.object_type}/${t.object_id}`, {
        method: 'PATCH',
        body: [{ op: 'replace', path: '/valueType', value: newVT }],
      });
      if (patchResp?._error) {
        results.push({ object_type: t.object_type, object_id: t.object_id, name: t.name, ok: false, error: patchResp._error });
      } else {
        results.push({ object_type: t.object_type, object_id: t.object_id, name: t.name, ok: true, from: t.current, to: newVT });
      }
    }

    const failed = results.filter(r => !r.ok);
    return {
      success: failed.length === 0,
      action: 'convert_value_type',
      new_value_type: newVT,
      cascaded_from: cascadedFrom,
      patched: results.filter(r => r.ok),
      failed,
      backup: backup.block,
      ...(failed.length ? { _hint: 'Some targets failed to patch — the optionSet/DE pair may now be inconsistent. Re-run convert_value_type on the failed object_id, or roll back via manage_backups(action=restore).' } : {}),
    };
  }

  return { _error: `Unknown action: ${action}. Use remove_from_stage, delete, check_references, update_program_org_units, update_sharing, add_program_attributes, update_style, convert_value_type, or discover_icons.` };
}

// Helper: check all references for a metadata object
async function checkMetadataReferences(objectType, objectId) {
  const refs = {};
  const id = objectId;

  if (objectType === 'dataElements') {
    // Check program stages containing this DE
    const stagesResp = await safeDhis2Fetch(
      `programStages?filter=programStageDataElements.dataElement.id:eq:${id}&fields=id,name,program[id,name]&paging=false`
    );
    if (!stagesResp._error && stagesResp.programStages?.length) {
      refs.program_stages = stagesResp.programStages.map(ps => ({
        stage_id: ps.id,
        stage_name: ps.name,
        program_id: ps.program?.id,
        program_name: ps.program?.name,
      }));
    }

    // Check program rule variables referencing this DE
    const prvResp = await safeDhis2Fetch(
      `programRuleVariables?filter=dataElement.id:eq:${id}&fields=id,name,program[id,name]&paging=false`
    );
    if (!prvResp._error && prvResp.programRuleVariables?.length) {
      refs.program_rule_variables = prvResp.programRuleVariables.map(v => ({
        id: v.id, name: v.name, program_name: v.program?.name,
      }));
    }

    // Check data element groups
    const degResp = await safeDhis2Fetch(
      `dataElementGroups?filter=dataElements.id:eq:${id}&fields=id,name&paging=false`
    );
    if (!degResp._error && degResp.dataElementGroups?.length) {
      refs.data_element_groups = degResp.dataElementGroups.map(g => ({ id: g.id, name: g.name }));
    }

    refs._note = 'Event data values referencing this data element cannot be fully checked via API. If events contain data for this DE, DHIS2 will return a 409 error on deletion.';
  }

  if (objectType === 'optionSets') {
    const deResp = await safeDhis2Fetch(`dataElements?filter=optionSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!deResp._error && deResp.dataElements?.length) {
      refs.data_elements_using_this = deResp.dataElements.map(de => ({ id: de.id, name: de.name }));
    }
    const teaResp = await safeDhis2Fetch(`trackedEntityAttributes?filter=optionSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!teaResp._error && teaResp.trackedEntityAttributes?.length) {
      refs.tracked_entity_attributes_using_this = teaResp.trackedEntityAttributes.map(t => ({ id: t.id, name: t.name }));
    }
  }

  if (objectType === 'legendSets') {
    // Distinct ref keys (…_using_legendset) so buildDeletionHint can give
    // legend-set-specific guidance without colliding with the option-set keys.
    const deResp = await safeDhis2Fetch(`dataElements?filter=legendSets.id:eq:${id}&fields=id,name&paging=false`);
    if (!deResp._error && deResp.dataElements?.length) {
      refs.data_elements_using_legendset = deResp.dataElements.map(de => ({ id: de.id, name: de.name }));
    }
    const indResp = await safeDhis2Fetch(`indicators?filter=legendSets.id:eq:${id}&fields=id,name&paging=false`);
    if (!indResp._error && indResp.indicators?.length) {
      refs.indicators_using_legendset = indResp.indicators.map(x => ({ id: x.id, name: x.name }));
    }
    const visResp = await safeDhis2Fetch(`visualizations?filter=legendSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!visResp._error && visResp.visualizations?.length) {
      refs.visualizations_using_legendset = visResp.visualizations.map(x => ({ id: x.id, name: x.name }));
    }
    const mapResp = await safeDhis2Fetch(`maps?filter=mapViews.legendSet.id:eq:${id}&fields=id,name&paging=false`);
    if (!mapResp._error && mapResp.maps?.length) {
      refs.maps_using_legendset = mapResp.maps.map(x => ({ id: x.id, name: x.name }));
    }
  }

  if (objectType === 'trackedEntityAttributes') {
    const ptaResp = await safeDhis2Fetch(
      `programs?filter=programTrackedEntityAttributes.trackedEntityAttribute.id:eq:${id}&fields=id,name&paging=false`
    );
    if (!ptaResp._error && ptaResp.programs?.length) {
      refs.programs_using_this = ptaResp.programs.map(p => ({ id: p.id, name: p.name }));
    }
    const prvResp = await safeDhis2Fetch(
      `programRuleVariables?filter=trackedEntityAttribute.id:eq:${id}&fields=id,name,program[id,name]&paging=false`
    );
    if (!prvResp._error && prvResp.programRuleVariables?.length) {
      refs.program_rule_variables = prvResp.programRuleVariables.map(v => ({
        id: v.id, name: v.name, program_name: v.program?.name,
      }));
    }
  }

  if (objectType === 'programStages') {
    const progResp = await safeDhis2Fetch(`programStages/${id}?fields=program[id,name]`);
    if (!progResp._error && progResp.program?.id) {
      refs.parent_program = { id: progResp.program.id, name: progResp.program.name };
    }
  }

  const hasRefs = Object.keys(refs).filter(k => !k.startsWith('_')).some(k => {
    const v = refs[k];
    return Array.isArray(v) ? v.length > 0 : !!v;
  });

  return { object_type: objectType, object_id: id, references: refs, has_references: hasRefs };
}

// Helper: build human-readable hint for resolving references before deletion
function buildDeletionHint(objectType, objectId, refs) {
  const hints = [];
  if (refs.program_stages?.length) {
    for (const s of refs.program_stages) {
      hints.push(`Remove from stage "${s.stage_name}" (${s.stage_id}) using manage_metadata(action=remove_from_stage, stage_id="${s.stage_id}", data_element_ids=["${objectId}"])`);
    }
  }
  if (refs.program_rule_variables?.length) {
    hints.push(`Delete ${refs.program_rule_variables.length} program rule variable(s) that reference this object: ${refs.program_rule_variables.map(v => `${v.name} (${v.id})`).join(', ')}`);
  }
  if (refs.data_element_groups?.length) {
    hints.push(`Remove from ${refs.data_element_groups.length} data element group(s): ${refs.data_element_groups.map(g => g.name).join(', ')}`);
  }
  if (refs.data_elements_using_this?.length) {
    hints.push(`${refs.data_elements_using_this.length} data element(s) use this option set — remove or reassign them first`);
  }
  if (refs.tracked_entity_attributes_using_this?.length) {
    hints.push(`${refs.tracked_entity_attributes_using_this.length} tracked entity attribute(s) use this option set — remove or reassign them first`);
  }
  if (refs.programs_using_this?.length) {
    hints.push(`Remove this attribute from ${refs.programs_using_this.length} program(s): ${refs.programs_using_this.map(p => p.name).join(', ')}`);
  }
  if (refs.data_elements_using_legendset?.length) {
    hints.push(`${refs.data_elements_using_legendset.length} data element(s) use this legend set — detach it from them first (manage_metadata): ${refs.data_elements_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.indicators_using_legendset?.length) {
    hints.push(`${refs.indicators_using_legendset.length} indicator(s) use this legend set — detach it from them first: ${refs.indicators_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.visualizations_using_legendset?.length) {
    hints.push(`${refs.visualizations_using_legendset.length} visualization(s) use this legend set — change their legend in Data Visualizer first: ${refs.visualizations_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.maps_using_legendset?.length) {
    hints.push(`${refs.maps_using_legendset.length} map(s) use this legend set — change the layer legend in Maps first: ${refs.maps_using_legendset.map(d => d.name).join(', ')}`);
  }
  if (refs.parent_program) {
    hints.push(`This stage belongs to program "${refs.parent_program.name}" — removing it will affect all enrollments`);
  }
  return hints.length ? hints.join('\n') : 'Remove all references listed above, then retry deletion.';
}

async function addProgramRules(args) {
  if (!args.program_id) return { _error: 'Missing program_id for add_program_rules' };
  if (!args.program_rules?.length) return { _error: 'Missing program_rules array' };

  // Pre-flight: lint conditions for known-broken boolean patterns.
  const lintErrors = [];
  for (const rule of args.program_rules) {
    const err = lintProgramRuleCondition(rule.condition, rule.name);
    if (err) lintErrors.push(err);
  }
  if (lintErrors.length) {
    return {
      success: false,
      _error: `Program rule condition lint failed (${lintErrors.length}): ${lintErrors.join(' | ')}`,
      phase: 'lint',
      errors: lintErrors,
      _hint: 'Fix the condition(s) using the suggested canonical form, then retry.',
    };
  }

  // Load existing program DEs and TEAs to map names → IDs.
  // PSDE id+compulsory included so HIDEALLFIELDS sugar can flip compulsory→false on
  // hidden DEs (DHIS2 New Tracker Capture refuses to visually hide a compulsory DE).
  const progResp = await safeDhis2Fetch(
    `programs/${args.program_id}?fields=id,programStages[id,displayName,sortOrder,programStageDataElements[id,compulsory,dataElement[id,displayName,optionSet[id]]]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName,optionSet[id]]]`
  );
  if (progResp._error) {
    return {
      _error: `Could not load program ${args.program_id}: ${progResp._error}`,
      _hint: 'If this program id came from a FAILED create_program attempt, nothing was created (the import is atomic) — that id does not exist. Either re-issue the full create_program call (rules can be included inline), or find the real program first via search_metadata(object_type="programs", name_filter=...).',
    };
  }

  // Pre-flight: visibility semantics — checked against BOTH the batch itself
  // and the rules already on the program (a "Show X when Yes" twin of an
  // existing "Hide X when No" is the classic broken pattern). A failed
  // existing-rules read degrades to batch-only linting rather than blocking.
  {
    const existingRulesResp = await safeDhis2Fetch(
      `programRules?filter=program.id:eq:${args.program_id}&fields=id,name,condition,programRuleActions%5BprogramRuleActionType,dataElement%5Bid,displayName%5D,trackedEntityAttribute%5Bid,displayName%5D,programStage%5Bid,displayName%5D,programStageSection%5Bid,displayName%5D%5D&pageSize=100`
    );
    const semanticErrors = lintRuleVisibilitySemantics(
      args.program_rules,
      existingRulesResp._error ? [] : (existingRulesResp.programRules || [])
    );
    if (semanticErrors.length) {
      return {
        success: false,
        _error: `Program rule semantics lint failed (${semanticErrors.length}): ${semanticErrors.join(' | ')}`,
        phase: 'lint',
        errors: semanticErrors,
        _hint: 'Rewrite as ONE hide rule per target (condition = the HIDE case); mandatory-when-visible goes in a separate SETMANDATORYFIELD-only rule with the positive condition. Then retry. Do not work around this by re-wording rule names.',
      };
    }
  }

  // Auto-rewrite SHOWWARNING content + expand HIDEALLFIELDS sugar before processing actions.
  // Side effects: PUT each affected stage with compulsory→false; auto-append a sibling
  // SETMANDATORYFIELD rule that re-mandates those DEs when the trigger condition is false.
  const sugarPlan = applyRuleActionSugar(args.program_rules, progResp.programStages || []);
  const sugarSideEffects = await applyRuleActionSugarSideEffects(sugarPlan, args.program_rules);

  const deNameToId = {};
  const deNameToStage = {};
  const deNameToOptionSetId = {};
  const stageNameToId = {};
  for (const ps of (progResp.programStages || [])) {
    if (ps.displayName) stageNameToId[String(ps.displayName).trim().toLowerCase()] = ps.id;
    for (const psde of (ps.programStageDataElements || [])) {
      const de = psde.dataElement;
      deNameToId[de.displayName] = de.id;
      deNameToStage[de.displayName] = ps.id;
      if (de.optionSet?.id) deNameToOptionSetId[de.displayName] = de.optionSet.id;
    }
  }
  const validStageIdSet = new Set((progResp.programStages || []).map(ps => ps.id));
  // Stage references in actions may arrive as a stage NAME (models often can't
  // know stage UIDs) — resolve name → id; a valid known UID passes through.
  const resolveStageRefForAction = (act) => {
    const ref = act.program_stage_name || act.program_stage_id;
    if (!ref) return null;
    if (validStageIdSet.has(ref)) return ref;
    const byName = stageNameToId[String(ref).trim().toLowerCase()];
    if (byName) return byName;
    if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(String(ref))) return ref; // plausible UID from elsewhere — let the server validate
    return undefined;
  };

  const teaNameToId = {};
  const teaHasOptionSet = {};
  const teaNameToOptionSetId = {};
  for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
    const tea = ptea.trackedEntityAttribute;
    teaNameToId[tea.displayName] = tea.id;
    teaHasOptionSet[tea.displayName] = !!tea.optionSet;
    if (tea.optionSet?.id) teaNameToOptionSetId[tea.displayName] = tea.optionSet.id;
  }

  // Existing PRVs on the program: tokens naming them resolve as-is (no new
  // PRV), and new PRVs must not collide with their names. Option-set details
  // are fetched too so literals compared against EXISTING option-backed
  // variables get the same name→code mapping as new ones.
  const existingPrvResp = await safeDhis2Fetch(
    `programRuleVariables?filter=program.id:eq:${args.program_id}&fields=name,useCodeForOptionSet,dataElement[id,optionSet[id]],trackedEntityAttribute[id,optionSet[id]]&paging=false`
  );
  const existingPrvList = existingPrvResp.programRuleVariables || [];
  const existingVarNames = new Set(existingPrvList.map(v => v.name));

  const allPRVs = [];
  const allPRAs = [];
  const allPRs = [];
  const prvCreated = {};
  for (const n of existingVarNames) prvCreated[n] = 'existing';

  const pushDePrv = (prvName, deName) => {
    if (prvCreated[prvName]) return;
    const prvUid = generateDhis2Uid();
    allPRVs.push({
      id: prvUid,
      name: prvName,
      program: { id: args.program_id },
      dataElement: { id: deNameToId[deName] },
      programRuleVariableSourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
      // Option-set DEs must resolve option CODES so `== 'CODE'` conditions
      // fire (useCodeForOptionSet=false yields the option NAME — silent
      // never-matching rules; MCH bug, play 2.40.12, 2026-07-07).
      ...(deNameToOptionSetId[deName] ? { useCodeForOptionSet: true } : {}),
      ...(deNameToStage[deName] ? { programStage: { id: deNameToStage[deName] } } : {}),
    });
    prvCreated[prvName] = prvUid;
  };
  const pushTeaPrv = (prvName, teaName) => {
    if (prvCreated[prvName]) return;
    const prvUid = generateDhis2Uid();
    allPRVs.push({
      id: prvUid,
      name: prvName,
      program: { id: args.program_id },
      trackedEntityAttribute: { id: teaNameToId[teaName] },
      programRuleVariableSourceType: 'TEI_ATTRIBUTE',
      useCodeForOptionSet: !!teaHasOptionSet[teaName],
    });
    prvCreated[prvName] = prvUid;
  };

  const deNamesAll = Object.keys(deNameToId);
  const teaNamesAll = Object.keys(teaNameToId);
  const autoGuardedConditions = [];
  const ruleTokenRewrites = [];
  for (const rule of args.program_rules) {
    // Bare `#{x} < n` fires on EMPTY fields (empty coerces to 0) — wrap with
    // d2:hasValue so warnings/hides don't trigger on a blank form.
    {
      const g = autoGuardNumericComparisons(rule.condition);
      if (g.guarded.length) {
        rule.condition = g.condition;
        autoGuardedConditions.push({ rule: rule.name, guarded_variables: g.guarded });
      }
    }
    // Resolve #{}/A{} tokens (condition + action data) to program DEs/TEAs —
    // exact sanitized name, then unique prefix; display-name tokens are
    // auto-rewritten to canonical form; tokens naming an existing PRV pass
    // through. Unresolved tokens REFUSE the import (rules with unknown
    // variables save fine but never fire).
    const { bindings, unresolved, rewrites } = resolveRuleTokenBindings(rule, deNamesAll, teaNamesAll, existingVarNames);
    if (rewrites.length) ruleTokenRewrites.push({ rule: rule.name, rewrites });
    if (unresolved.length) {
      return {
        success: false,
        phase: 'lint',
        _error: `Program rule "${rule.name}" references unresolved variable(s): ${unresolved.join(', ')} — no program rule variable, data element or attribute of this program matches (exactly or by prefix). Nothing was imported.`,
        unresolved,
        available_variables: [...existingVarNames].map(n => `#{${n}}`),
        available_data_elements: deNamesAll.map(n => `#{${sanitizeVariableName(n)}}`),
        available_attributes: teaNamesAll.map(n => `A{${sanitizeVariableName(n)}}`),
        _hint: 'Reference an existing program rule variable, or #{sanitized_data_element_name} / A{sanitized_attribute_name} of this program. Fix the token(s) and retry.',
      };
    }
    for (const b of bindings) {
      if (b.kind === 'de') pushDePrv(b.token, b.name); else pushTeaPrv(b.token, b.name);
    }

    // Action-target DEs/TEAs also get a PRV under their sanitized name
    // (pre-existing behavior).
    for (const act of (rule.actions || [])) {
      if (act.data_element_name && deNameToId[act.data_element_name]) {
        pushDePrv(sanitizeVariableName(act.data_element_name), act.data_element_name);
      }
      if (act.tracked_entity_attribute_name && teaNameToId[act.tracked_entity_attribute_name]) {
        pushTeaPrv(sanitizeVariableName(act.tracked_entity_attribute_name), act.tracked_entity_attribute_name);
      }
    }

    // Build program rule + separate actions (top-level programRuleActions array)
    const prUid = generateDhis2Uid();
    const actionRefs = [];

    for (const act of (rule.actions || [])) {
      const praUid = generateDhis2Uid();
      actionRefs.push({ id: praUid });
      const pra = {
        id: praUid,
        programRuleActionType: act.type,
        programRule: { id: prUid },
      };
      if (act.content) pra.content = act.content;
      if (act.data) pra.data = act.data;
      if (act.data_element_id) {
        // Direct ID target — used by HIDEALLFIELDS expansion and any explicit id pass-through.
        pra.dataElement = { id: act.data_element_id };
      } else if (act.data_element_name && deNameToId[act.data_element_name]) {
        pra.dataElement = { id: deNameToId[act.data_element_name] };
      }
      if (act.tei_attribute_id) {
        pra.trackedEntityAttribute = { id: act.tei_attribute_id };
      } else if (act.tracked_entity_attribute_name && teaNameToId[act.tracked_entity_attribute_name]) {
        pra.trackedEntityAttribute = { id: teaNameToId[act.tracked_entity_attribute_name] };
      }
      const stageId = resolveStageRefForAction(act);
      if (stageId) pra.programStage = { id: stageId };
      if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };

      // Fail fast on stage-targeting actions with no resolvable stage — the
      // server rejects the whole bundle with "ProgramStage cannot be null".
      if ((act.type === 'HIDEPROGRAMSTAGE' || act.type === 'CREATEEVENT') && !pra.programStage) {
        return {
          success: false,
          phase: 'lint',
          _error: `Program rule "${rule.name}" has a ${act.type} action whose target stage could not be resolved${act.program_stage_name || act.program_stage_id ? ` from "${act.program_stage_name || act.program_stage_id}"` : ' (no stage reference given)'}. Nothing was imported.`,
          valid_stages: (progResp.programStages || []).map(ps => ({ id: ps.id, name: ps.displayName })),
          _hint: 'Pass program_stage_id with one of the valid stage ids, or program_stage_name with the stage name — the tool resolves names automatically. Fix the action and retry.',
        };
      }
      allPRAs.push(pra);
    }

    allPRs.push({
      id: prUid,
      name: rule.name,
      description: rule.description || '',
      program: { id: args.program_id },
      condition: rule.condition,
      programRuleActions: actionRefs, // ID refs only, not full objects
    });
  }

  // ── Option NAME → CODE mapping in conditions and ASSIGN data ──
  // New PRVs above resolve option CODES (useCodeForOptionSet=true); rewrite any
  // option-NAME literal to its code and flag literals that match neither.
  let ruleConditionAdvisories = [];
  let ruleConditionRewrites = [];
  {
    const deIdToOsId = new Map();
    for (const [n, id] of Object.entries(deNameToId)) {
      if (deNameToOptionSetId[n]) deIdToOsId.set(id, deNameToOptionSetId[n]);
    }
    const teaIdToOsId = new Map();
    for (const [n, id] of Object.entries(teaNameToId)) {
      if (teaNameToOptionSetId[n]) teaIdToOsId.set(id, teaNameToOptionSetId[n]);
    }
    const varToOsKey = new Map();
    for (const prv of allPRVs) {
      const osId = (prv.dataElement?.id && deIdToOsId.get(prv.dataElement.id))
        || (prv.trackedEntityAttribute?.id && teaIdToOsId.get(prv.trackedEntityAttribute.id)) || null;
      if (osId) varToOsKey.set(String(prv.name).toLowerCase(), osId);
    }
    // Existing option-backed PRVs: code-resolving ones join the rewrite; a
    // NAME-resolving one (useCodeForOptionSet=false) compared to a literal is
    // flagged — code literals never match it.
    const nameResolvingOptionVars = [];
    for (const prv of existingPrvList) {
      const osId = prv.dataElement?.optionSet?.id || prv.trackedEntityAttribute?.optionSet?.id || null;
      if (!osId) continue;
      if (prv.useCodeForOptionSet === false) nameResolvingOptionVars.push(prv.name);
      else varToOsKey.set(String(prv.name).toLowerCase(), osId);
    }
    for (const varName of nameResolvingOptionVars) {
      const esc = String(varName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'[^']+'`);
      for (const pr of allPRs) {
        if (re.test(pr.condition || '')) {
          ruleConditionAdvisories.push(`Rule "${pr.name}" compares #{${varName}} to a quoted literal, but that EXISTING variable has useCodeForOptionSet=false (it yields the option NAME, not the CODE) — a code literal never matches. Fix the variable via manage_program_rules or compare against the option name.`);
        }
      }
    }
    const targetToOsKey = new Map();
    for (const pra of allPRAs) {
      const osId = (pra.dataElement?.id && deIdToOsId.get(pra.dataElement.id))
        || (pra.trackedEntityAttribute?.id && teaIdToOsId.get(pra.trackedEntityAttribute.id)) || null;
      if (osId) targetToOsKey.set(pra.dataElement?.id || pra.trackedEntityAttribute?.id, osId);
    }
    const neededOsIds = [...new Set([...varToOsKey.values(), ...targetToOsKey.values()])];
    if (neededOsIds.length) {
      const resps = await Promise.all(neededOsIds.map(id =>
        safeDhis2Fetch(`optionSets/${id}?fields=id,options[name,code]`)));
      const optionsByOsKey = new Map();
      for (let i = 0; i < neededOsIds.length; i++) {
        const o = resps[i];
        if (o && !o._error) optionsByOsKey.set(neededOsIds[i], (o.options || []).map(x => ({ name: x.name, code: x.code })));
      }
      const mapped = rewriteOptionLiteralsGeneric({
        rules: allPRs,
        actions: allPRAs,
        varToOsKey,
        targetToOsKey,
        optionsByOsKey,
      });
      ruleConditionAdvisories = mapped.advisories;
      ruleConditionRewrites = mapped.rewrites;
    }
  }

  const payload = {};
  if (allPRVs.length) payload.programRuleVariables = allPRVs;
  if (allPRAs.length) payload.programRuleActions = allPRAs;
  if (allPRs.length) payload.programRules = allPRs;

  const result = await postMetadataPayload(payload, args.dry_run_only);

  return {
    ...result,
    summary: {
      program_id: args.program_id,
      programRules: allPRs.map(r => ({ id: r.id, name: r.name })),
      programRuleVariables: allPRVs.map(v => ({ id: v.id, name: v.name })),
      programRuleActions: allPRAs.map(a => ({ id: a.id, type: a.programRuleActionType })),
      ...(sugarSideEffects.stageUpdates.length ? { compulsory_flags_cleared: sugarSideEffects.stageUpdates } : {}),
      ...(sugarSideEffects.errors.length ? { compulsory_flag_errors: sugarSideEffects.errors } : {}),
      ...(sugarPlan.siblingMandateRules.length ? { auto_paired_mandate_rules: sugarPlan.siblingMandateRules.map(r => r.name) } : {}),
      ...(autoGuardedConditions.length ? { auto_guarded_conditions: autoGuardedConditions } : {}),
      ...(ruleConditionRewrites.length ? { condition_option_rewrites: ruleConditionRewrites } : {}),
      ...(ruleConditionAdvisories.length ? { condition_option_advisories: ruleConditionAdvisories } : {}),
      ...(ruleTokenRewrites.length ? { rule_token_rewrites: ruleTokenRewrites } : {}),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// manage_program_notifications — Program Notification Templates (CRUD + link)
// Codifies DHIS2's non-obvious rules so the model never has to rediscover them:
//  - No `url` field on the schema → webhook URL goes into messageTemplate.
//  - WEB_HOOK recipient auto-gets deliveryChannels=[HTTP] via postProcess hook
//    (ProgramNotificationTemplateObjectBundleHook), so we don't have to set it.
//  - Template ↔ program linking is a dedicated endpoint:
//      POST /api/programs/{programId}/notificationTemplates/{templateId}
//    (PATCH on the program with `programNotificationTemplates` fails 400.)
//  - subjectTemplate max 100, messageTemplate max 10000.
//  - SCHEDULED_* triggers require relativeScheduledDays (non-null).
//  - External recipients (eligible to carry deliveryChannels):
//      TRACKED_ENTITY_INSTANCE, ORGANISATION_UNIT_CONTACT,
//      PROGRAM_ATTRIBUTE, DATA_ELEMENT, WEB_HOOK
//    Internal (no deliveryChannels — go to the DHIS2 messaging inbox):
//      USER_GROUP, USERS_AT_ORGANISATION_UNIT
// ────────────────────────────────────────────────────────────────────────────

const PN_EXTERNAL_RECIPIENTS = new Set([
  'TRACKED_ENTITY_INSTANCE',
  'ORGANISATION_UNIT_CONTACT',
  'PROGRAM_ATTRIBUTE',
  'DATA_ELEMENT',
  'WEB_HOOK',
]);
const PN_SCHEDULED_TRIGGERS = new Set([
  'SCHEDULED_DAYS_DUE_DATE',
  'SCHEDULED_DAYS_INCIDENT_DATE',
  'SCHEDULED_DAYS_ENROLLMENT_DATE',
]);
const PN_TEMPLATE_FIELDS =
  'id,name,displayName,subjectTemplate,messageTemplate,notificationTrigger,'
  + 'notificationRecipient,deliveryChannels,sendRepeatable,relativeScheduledDays,'
  + 'recipientUserGroup[id,name],recipientProgramAttribute[id,name,valueType],'
  + 'recipientDataElement[id,name,valueType]';

function _pnBuildCreatePayload(args) {
  const name = (args.name || '').trim();
  if (!name) return { _error: 'name is required for create / create_and_link', _hint: 'Pass name="Human-readable template title" (shown in DHIS2 Notifications app).' };
  if (!args.trigger) return { _error: 'trigger is required for create / create_and_link', _hint: 'One of: ENROLLMENT, COMPLETION, PROGRAM_RULE, SCHEDULED_DAYS_DUE_DATE, SCHEDULED_DAYS_INCIDENT_DATE, SCHEDULED_DAYS_ENROLLMENT_DATE.' };
  if (!args.recipient) return { _error: 'recipient is required for create / create_and_link', _hint: 'One of: TRACKED_ENTITY_INSTANCE, ORGANISATION_UNIT_CONTACT, USERS_AT_ORGANISATION_UNIT, USER_GROUP, PROGRAM_ATTRIBUTE, DATA_ELEMENT, WEB_HOOK.' };

  const isWebhook = args.recipient === 'WEB_HOOK';
  const isScheduled = PN_SCHEDULED_TRIGGERS.has(args.trigger);

  // Resolve subjectTemplate + messageTemplate per recipient convention
  let subjectTemplate = args.subject_template;
  let messageTemplate = args.message_template;

  if (isWebhook) {
    // DHIS2 has no url field. Convention: messageTemplate = webhook URL.
    if (!messageTemplate) {
      if (!args.webhook_url) return { _error: 'webhook_url is required when recipient=WEB_HOOK', _hint: 'Pass webhook_url="https://..." — it is stored in messageTemplate (DHIS2 has no dedicated url field).' };
      if (!/^https?:\/\//i.test(args.webhook_url)) return { _error: 'webhook_url must be an http(s) URL', _hint: `Got "${args.webhook_url}". Expected http:// or https://.` };
      messageTemplate = args.webhook_url;
    }
    if (!subjectTemplate) {
      // Put human-readable body / template variables into subjectTemplate.
      subjectTemplate = (args.message_content || name).slice(0, 100);
    }
  } else {
    if (!messageTemplate) messageTemplate = args.message_content || '';
    if (!subjectTemplate) subjectTemplate = (args.subject_template || name).slice(0, 100);
  }

  if (subjectTemplate && subjectTemplate.length > 100) {
    return { _error: `subjectTemplate is ${subjectTemplate.length} chars — DHIS2 limit is 100.`, _hint: 'Shorten subject (for WEB_HOOK, move long content out of subject — but the URL already lives in messageTemplate, so keep subject concise with template vars only).' };
  }
  if (messageTemplate && messageTemplate.length > 10000) {
    return { _error: `messageTemplate is ${messageTemplate.length} chars — DHIS2 limit is 10000.`, _hint: 'Trim message body.' };
  }
  if (!messageTemplate) {
    return { _error: 'messageTemplate cannot be empty', _hint: isWebhook ? 'Pass webhook_url.' : 'Pass message_content="..." with template variables like V{program_name}, V{org_unit_name}, A{<teaUid>}.' };
  }

  // Recipient-specific required fields
  if (args.recipient === 'USER_GROUP' && !args.recipient_user_group_id) {
    return { _error: 'recipient=USER_GROUP requires recipient_user_group_id', _hint: 'Pass the UID of a userGroup — DHIS2 will deliver dashboard messages to its members.' };
  }
  if (args.recipient === 'PROGRAM_ATTRIBUTE' && !args.recipient_program_attribute_id) {
    return { _error: 'recipient=PROGRAM_ATTRIBUTE requires recipient_program_attribute_id (TEA UID)', _hint: 'TEA must be of valueType EMAIL or PHONE_NUMBER so DHIS2 can infer the deliveryChannel.' };
  }
  if (args.recipient === 'DATA_ELEMENT' && !args.recipient_data_element_id) {
    return { _error: 'recipient=DATA_ELEMENT requires recipient_data_element_id (DE UID)', _hint: 'DE must be of valueType EMAIL or PHONE_NUMBER.' };
  }
  if (isScheduled && (args.relative_scheduled_days == null || isNaN(Number(args.relative_scheduled_days)))) {
    return { _error: `trigger=${args.trigger} requires relative_scheduled_days (integer, negative = before the anchor date)`, _hint: 'e.g. relative_scheduled_days=-3 to fire 3 days before due date.' };
  }

  const payload = {
    name,
    subjectTemplate: subjectTemplate || '',
    messageTemplate,
    notificationTrigger: args.trigger,
    notificationRecipient: args.recipient,
    sendRepeatable: !!args.send_repeatable,
  };
  if (isScheduled) payload.relativeScheduledDays = Number(args.relative_scheduled_days);
  if (args.recipient === 'USER_GROUP') payload.recipientUserGroup = { id: args.recipient_user_group_id };
  if (args.recipient === 'PROGRAM_ATTRIBUTE') payload.recipientProgramAttribute = { id: args.recipient_program_attribute_id };
  if (args.recipient === 'DATA_ELEMENT') payload.recipientDataElement = { id: args.recipient_data_element_id };

  // Only set deliveryChannels for external recipients; the server's postProcess
  // will overwrite it anyway for WEB_HOOK/PROGRAM_ATTRIBUTE/DATA_ELEMENT, but
  // setting for WEB_HOOK up front avoids a transient empty-channels window.
  if (PN_EXTERNAL_RECIPIENTS.has(args.recipient)) {
    if (Array.isArray(args.delivery_channels) && args.delivery_channels.length) {
      payload.deliveryChannels = args.delivery_channels;
    } else if (isWebhook) {
      payload.deliveryChannels = ['HTTP'];
    }
  }

  return { payload, _notes: [
    isWebhook ? 'WEB_HOOK: URL placed in messageTemplate; deliveryChannels=[HTTP] will be enforced by DHIS2 postProcess.' : null,
    isScheduled ? `Scheduled trigger: relativeScheduledDays=${payload.relativeScheduledDays}.` : null,
  ].filter(Boolean) };
}

async function executeManageProgramNotifications(args) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action', _hint: 'One of: list, get, create, update, delete, link, unlink, create_and_link.' };

  // ── list ──
  if (action === 'list') {
    if (!args.program_id) return { _error: 'program_id required for list', _hint: 'Pass the program UID whose notification templates you want.' };
    const resp = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=${PN_TEMPLATE_FIELDS}&paging=false`);
    if (resp._error) return { _error: `Failed to list templates: ${resp._error}`, _hint: 'Check the program_id — it must be an existing program UID.' };
    const templates = resp.programNotificationTemplates || resp.notificationTemplates || [];
    return {
      success: true,
      program_id: args.program_id,
      count: templates.length,
      templates,
    };
  }

  // ── get ──
  if (action === 'get') {
    if (!args.template_id) return { _error: 'template_id required for get' };
    const resp = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}?fields=${PN_TEMPLATE_FIELDS}`);
    if (resp._error) return { _error: `Failed to fetch template: ${resp._error}`, _hint: 'Verify template_id is a valid UID.' };
    return { success: true, template: resp };
  }

  // ── create ──
  if (action === 'create' || action === 'create_and_link') {
    const _gate = requireWriteAuth('manage_program_notifications', action);
    if (_gate) return _gate;
    const built = _pnBuildCreatePayload(args);
    if (built._error) return built;
    const payload = built.payload;

    // Validate program exists up front to avoid creating orphaned templates.
    if (action === 'create_and_link') {
      if (!args.program_id) return { _error: 'program_id required for create_and_link' };
      const progProbe = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}?fields=id,name`);
      if (progProbe._error) return { _error: `program_id ${args.program_id} not found: ${progProbe._error}`, _hint: 'Use search_metadata(type="program", query="...") to find the correct UID.' };
    }

    // For USER_GROUP/PROGRAM_ATTRIBUTE/DATA_ELEMENT, probe the referenced UID
    // so we fail fast with a clear error instead of a vague DHIS2 500.
    if (payload.recipientUserGroup) {
      const ugProbe = await safeDhis2Fetch(`userGroups/${encodeURIComponent(payload.recipientUserGroup.id)}?fields=id`);
      if (ugProbe._error) return { _error: `recipient_user_group_id ${payload.recipientUserGroup.id} not found`, _hint: 'Pass a valid userGroup UID.' };
    }
    if (payload.recipientProgramAttribute) {
      const teaProbe = await safeDhis2Fetch(`trackedEntityAttributes/${encodeURIComponent(payload.recipientProgramAttribute.id)}?fields=id,valueType`);
      if (teaProbe._error) return { _error: `recipient_program_attribute_id ${payload.recipientProgramAttribute.id} not found`, _hint: 'Pass a valid TEA UID.' };
      const vt = teaProbe.valueType;
      if (vt !== 'EMAIL' && vt !== 'PHONE_NUMBER') {
        return { _error: `TEA ${payload.recipientProgramAttribute.id} has valueType=${vt}; only EMAIL or PHONE_NUMBER are usable as notification recipients`, _hint: 'Choose a TEA storing an email or phone number.' };
      }
    }
    if (payload.recipientDataElement) {
      const deProbe = await safeDhis2Fetch(`dataElements/${encodeURIComponent(payload.recipientDataElement.id)}?fields=id,valueType`);
      if (deProbe._error) return { _error: `recipient_data_element_id ${payload.recipientDataElement.id} not found`, _hint: 'Pass a valid DE UID.' };
      const vt = deProbe.valueType;
      if (vt !== 'EMAIL' && vt !== 'PHONE_NUMBER') {
        return { _error: `DE ${payload.recipientDataElement.id} has valueType=${vt}; only EMAIL or PHONE_NUMBER are usable as notification recipients`, _hint: 'Choose a DE storing an email or phone number.' };
      }
    }

    // ── Pre-flight dedup (create_and_link only): if a template with the same
    // name is already attached to the target program, return it instead of
    // creating a duplicate. This prevents the "two MCH enrollment templates"
    // class of issue caused by retries after a false-negative link.
    if (action === 'create_and_link') {
      const existing = await safeDhis2Fetch(
        `programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=${PN_TEMPLATE_FIELDS}&paging=false`
      );
      const existingList = existing?.programNotificationTemplates || existing?.notificationTemplates || [];
      const match = Array.isArray(existingList) && existingList.find(t => t.name === payload.name);
      if (match) {
        return {
          success: true,
          template_id: match.id,
          linked_to_program: args.program_id,
          template: match,
          _notes: [...(built._notes || []), `Dedup: a template named "${payload.name}" is already linked to this program — returning existing (no duplicate created).`],
        };
      }
    }

    // POST to the programNotificationTemplates collection.
    const createResp = await safeDhis2Fetch('programNotificationTemplates', {
      method: 'POST',
      body: payload,
    });
    if (createResp._error) {
      return {
        _error: `Create failed: ${createResp._error}`,
        _status: createResp._status,
        _body: createResp._body,
        _hint: 'If 409 on subjectTemplate length, shorten message_content/subject_template. If 500 with a property error, the payload shape is correct for DHIS2 2.36+ — check the server version and any custom webhook sender plugin.',
        payload,
      };
    }
    const templateId = createResp.response?.uid || createResp.uid;
    if (!templateId) {
      return { _error: 'Create returned no uid', _raw: createResp, _hint: 'The server response did not include a template UID; the template may not have been persisted.' };
    }

    // Verify the create by reading it back. If the read fails, we have already
    // persisted a template on the server but can't confirm state — attempt a
    // rollback delete so we never leave an unverifiable orphan.
    const verify = await safeDhis2Fetch(`programNotificationTemplates/${templateId}?fields=${PN_TEMPLATE_FIELDS}`);
    if (verify._error) {
      const rb = await safeDhis2Fetch(`programNotificationTemplates/${templateId}`, { method: 'DELETE', allowEmptyBody: true });
      return {
        _error: `Template create verification failed (uid=${templateId}). ${rb._error ? 'Rollback delete also failed.' : 'Rollback delete succeeded — server is clean.'}`,
        rollback: { attempted: true, succeeded: !rb._error, template_id: templateId },
        _hint: rb._error
          ? `Manual cleanup needed: manage_program_notifications(action="delete", template_id="${templateId}"). Rollback error: ${rb._error}`
          : 'Server is clean. Retry the create_and_link call.',
      };
    }

    if (action === 'create') {
      return {
        success: true,
        template_id: templateId,
        template: verify,
        _notes: built._notes,
        _hint: 'Template created but NOT yet linked to any program. Call action="link" with program_id to activate it, or use action="create_and_link" next time.',
      };
    }

    // action === 'create_and_link' → link with retry + auto-rollback.
    // DHIS2's link endpoint returns HTTP 200 with an empty body on success, so
    // we opt into allowEmptyBody and verify by listing the program's
    // notificationTemplates (source-of-truth check, idempotent).
    const tryLink = async () => {
      const resp = await safeDhis2Fetch(
        `programs/${encodeURIComponent(args.program_id)}/notificationTemplates/${templateId}`,
        { method: 'POST', allowEmptyBody: true }
      );
      const vr = await safeDhis2Fetch(
        `programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=id&paging=false`
      );
      const lst = vr?.programNotificationTemplates || vr?.notificationTemplates || [];
      return { linked: Array.isArray(lst) && lst.some(t => t.id === templateId), resp };
    };

    let linkAttempt = await tryLink();
    if (!linkAttempt.linked) linkAttempt = await tryLink(); // one retry
    if (!linkAttempt.linked) {
      // Auto-rollback: delete the orphan template so the server goes back to
      // the exact state it was in before this call. This honors the user-stated
      // invariant: "never end up with leftovers when the task doesn't complete".
      const rb = await safeDhis2Fetch(
        `programNotificationTemplates/${templateId}`,
        { method: 'DELETE', allowEmptyBody: true }
      );
      return {
        _error: `Link failed after retry (template ${templateId} could not be attached to program ${args.program_id}). ${linkAttempt.resp?._error || ''}`.trim(),
        rollback: { attempted: true, succeeded: !rb._error, template_id_was: templateId },
        _hint: rb._error
          ? `Rollback delete FAILED — manual cleanup needed: manage_program_notifications(action="delete", template_id="${templateId}"). Rollback error: ${rb._error}`
          : 'Template rolled back (deleted). Server is clean — safe to retry the create_and_link call.',
      };
    }
    return {
      success: true,
      template_id: templateId,
      linked_to_program: args.program_id,
      template: verify,
      _notes: built._notes,
    };
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_program_notifications', 'update', { template_id: args.template_id });
    if (_gate) return _gate;
    if (!args.template_id) return { _error: 'template_id required for update' };
    // Verify the template exists before patching.
    const _verify = await verifyTargetExists('programNotificationTemplates', args.template_id, 'manage_program_notifications', 'update');
    if (!_verify.exists) return _verify.refusal;
    // Accept `patch` object OR top-level args — both forms map to the same JSON Patch ops.
    // This avoids the "patch had no recognized keys" dead-end when the model places
    // update keys directly on the call instead of nesting them under `patch`.
    const p = (args.patch && typeof args.patch === 'object') ? { ...args.patch } : {};
    for (const k of ['name', 'subject_template', 'message_template', 'webhook_url', 'message_content', 'trigger', 'recipient', 'send_repeatable', 'relative_scheduled_days', 'url', 'webhookUrl', 'hookUrl', 'endpoint', 'targetUrl']) {
      if (args[k] != null && p[k] == null) p[k] = args[k];
    }
    if (Object.keys(p).length === 0) return { _error: 'No fields to update', _hint: 'Pass either patch={...} or the fields directly (name, webhook_url, trigger, recipient, subject_template, message_template, message_content, send_repeatable, relative_scheduled_days). Do NOT use "url" — DHIS2 has no such field; pass webhook_url which writes to messageTemplate.' };
    // Translate friendly keys → DHIS2 property names.
    const map = [];
    const reject = [];
    if (p.name != null) map.push(['name', p.name]);
    if (p.subject_template != null) {
      if (String(p.subject_template).length > 100) reject.push('subject_template >100 chars');
      else map.push(['subjectTemplate', p.subject_template]);
    }
    if (p.message_template != null) {
      if (String(p.message_template).length > 10000) reject.push('message_template >10000 chars');
      else map.push(['messageTemplate', p.message_template]);
    }
    if (p.webhook_url != null) {
      if (!/^https?:\/\//i.test(p.webhook_url)) reject.push('webhook_url must be http(s)');
      else map.push(['messageTemplate', p.webhook_url]);
    }
    if (p.message_content != null) map.push(['subjectTemplate', String(p.message_content).slice(0, 100)]);
    if (p.trigger != null) map.push(['notificationTrigger', p.trigger]);
    if (p.recipient != null) map.push(['notificationRecipient', p.recipient]);
    if (p.send_repeatable != null) map.push(['sendRepeatable', !!p.send_repeatable]);
    if (p.relative_scheduled_days != null) map.push(['relativeScheduledDays', Number(p.relative_scheduled_days)]);
    if ('url' in p || 'webhookUrl' in p || 'hookUrl' in p || 'endpoint' in p || 'targetUrl' in p) {
      reject.push('DHIS2 has no url/webhookUrl/hookUrl/endpoint/targetUrl field — use webhook_url (which writes to messageTemplate)');
    }
    if (reject.length) return { _error: `Invalid patch keys: ${reject.join('; ')}`, _hint: 'See the tool description for supported keys.' };
    if (!map.length) return { _error: 'patch had no recognized keys', _hint: 'Supported: name, subject_template, message_template, webhook_url, message_content, trigger, recipient, send_repeatable, relative_scheduled_days.' };

    // Snapshot the template BEFORE patching.
    const updateBackup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_program_notifications', action: 'update', reason: `Updating notification template ${args.template_id}` },
      [{ object_type: 'programNotificationTemplates', object_id: args.template_id, role: 'primary' }],
      args
    );
    if (!updateBackup.ok) return updateBackup.error;

    // Build RFC 6902 JSON Patch
    const patchOps = map.map(([k, v]) => ({ op: 'replace', path: '/' + k, value: v }));
    const patchResp = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}`, {
      method: 'PATCH',
      body: patchOps,
    });
    if (patchResp._error) {
      return { _error: `Patch failed: ${patchResp._error}`, _status: patchResp._status, _body: patchResp._body, _hint: 'PATCH uses application/json-patch+json — the tool sets this automatically. 400 usually means you tried to write a property that does not exist on the schema.', backup: updateBackup.block };
    }
    const verify = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}?fields=${PN_TEMPLATE_FIELDS}`);
    return { success: true, template_id: args.template_id, applied_ops: patchOps, template: verify, backup: updateBackup.block };
  }

  // ── delete ──
  if (action === 'delete') {
    if (!args.template_id) return { _error: 'template_id required for delete' };

    const _gate = requireWriteAuth('manage_program_notifications', 'delete', { template_id: args.template_id });
    if (_gate) return _gate;
    const _verify = await verifyTargetExists('programNotificationTemplates', args.template_id, 'manage_program_notifications', 'delete');
    if (!_verify.exists) return _verify.refusal;

    const deleteBackup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_program_notifications', action: 'delete', reason: `Deleting notification template ${args.template_id}` },
      [{ object_type: 'programNotificationTemplates', object_id: args.template_id, role: 'primary' }],
      args
    );
    if (!deleteBackup.ok) return deleteBackup.error;

    const delResp = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(args.template_id)}`, { method: 'DELETE' });
    if (delResp._error) return { _error: `Delete failed: ${delResp._error}`, _hint: 'If the template is still linked to a program, DHIS2 will usually still delete it (the link is removed too). A 404 means it was already gone.', backup: deleteBackup.block };
    return { success: true, template_id: args.template_id, message: 'Template deleted.', backup: deleteBackup.block };
  }

  // ── link ──
  if (action === 'link') {
    const _gate = requireWriteAuth('manage_program_notifications', 'link', { program_id: args.program_id, template_id: args.template_id });
    if (_gate) return _gate;
    if (!args.program_id) return { _error: 'program_id required for link' };
    if (!args.template_id) return { _error: 'template_id required for link' };
    // DHIS2's link endpoint returns HTTP 200 with empty body on success — opt into
    // allowEmptyBody and then GET-verify against the program's templates list.
    await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates/${encodeURIComponent(args.template_id)}`, { method: 'POST', allowEmptyBody: true });
    const verify = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=id&paging=false`);
    const list = verify?.programNotificationTemplates || verify?.notificationTemplates || [];
    const linked = Array.isArray(list) && list.some(t => t.id === args.template_id);
    if (!linked) return { _error: `Link verification failed: template ${args.template_id} is not in program ${args.program_id}.`, _hint: 'Verify both UIDs exist. A 404 on POST typically means either the program or the template UID is wrong.' };
    return { success: true, program_id: args.program_id, template_id: args.template_id, linked: true };
  }

  // ── unlink ──
  if (action === 'unlink') {
    const _gate = requireWriteAuth('manage_program_notifications', 'unlink', { program_id: args.program_id, template_id: args.template_id });
    if (_gate) return _gate;
    if (!args.program_id) return { _error: 'program_id required for unlink' };
    if (!args.template_id) return { _error: 'template_id required for unlink' };
    await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates/${encodeURIComponent(args.template_id)}`, { method: 'DELETE', allowEmptyBody: true });
    const verify = await safeDhis2Fetch(`programs/${encodeURIComponent(args.program_id)}/notificationTemplates?fields=id&paging=false`);
    const list = verify?.programNotificationTemplates || verify?.notificationTemplates || [];
    const stillLinked = Array.isArray(list) && list.some(t => t.id === args.template_id);
    if (stillLinked) return { _error: `Unlink verification failed: template ${args.template_id} is still attached to program ${args.program_id}.`, _hint: 'If the endpoint returned 404 the template was not attached in the first place; otherwise retry or check admin access.' };
    return { success: true, program_id: args.program_id, template_id: args.template_id, unlinked: true };
  }

  // ── orphan_sweep ── find templates not linked to any program or stage
  if (action === 'orphan_sweep') {
    // Source of truth for "linked": a template UID appears in
    // programs[].notificationTemplates OR programStages[].notificationTemplates.
    const [progs, stages, all] = await Promise.all([
      safeDhis2Fetch('programs?fields=id,name,notificationTemplates%5Bid%5D&paging=false'),
      safeDhis2Fetch('programStages?fields=id,name,notificationTemplates%5Bid%5D&paging=false'),
      safeDhis2Fetch(`programNotificationTemplates?fields=id,name,notificationTrigger,notificationRecipient,created,lastUpdated&paging=false`),
    ]);
    if (progs._error) return { _error: `orphan_sweep: failed to list programs: ${progs._error}` };
    if (stages._error) return { _error: `orphan_sweep: failed to list programStages: ${stages._error}` };
    if (all._error) return { _error: `orphan_sweep: failed to list templates: ${all._error}` };

    const linkedIds = new Set();
    for (const p of (progs.programs || [])) for (const t of (p.notificationTemplates || [])) linkedIds.add(t.id);
    for (const s of (stages.programStages || [])) for (const t of (s.notificationTemplates || [])) linkedIds.add(t.id);

    const templates = all.programNotificationTemplates || [];
    const orphans = templates.filter(t => !linkedIds.has(t.id));

    if (!args.delete) {
      return {
        success: true,
        total_templates: templates.length,
        linked_count: templates.length - orphans.length,
        orphans_found: orphans.length,
        orphans,
        _hint: orphans.length
          ? 'Re-run with delete=true to remove these orphans. Each has never been attached to any program or stage.'
          : 'No orphaned notification templates on this server.',
      };
    }

    // delete=true → snapshot every orphan in one batch BEFORE deleting any.
    if (orphans.length > BULK_DELETE_SOFT_CAP && args.acknowledge_large_bulk !== true) {
      return {
        _error: `Refusing to delete ${orphans.length} orphan template(s) in one sweep — soft cap is ${BULK_DELETE_SOFT_CAP}. List the IDs to the user, get an explicit "yes", then retry with acknowledge_large_bulk:true.`,
        orphans_found: orphans.length,
        first_30_orphans: orphans.slice(0, 30),
        _hint: `Add acknowledge_large_bulk:true to authorize a sweep larger than ${BULK_DELETE_SOFT_CAP} items.`,
      };
    }
    const sweepBackup = await ensureBackupOrBail(
      { operation: 'orphan_sweep', tool: 'manage_program_notifications', action: 'orphan_sweep', reason: `Deleting ${orphans.length} orphan notification template(s)` },
      orphans.map((o) => ({ object_type: 'programNotificationTemplates', object_id: o.id, role: 'primary' })),
      args
    );
    if (!sweepBackup.ok) return sweepBackup.error;

    const deleted = [];
    const failed = [];
    for (const o of orphans) {
      const d = await safeDhis2Fetch(`programNotificationTemplates/${encodeURIComponent(o.id)}`, { method: 'DELETE', allowEmptyBody: true });
      if (d._error) failed.push({ id: o.id, name: o.name, error: d._error });
      else deleted.push({ id: o.id, name: o.name });
    }
    return {
      success: failed.length === 0,
      orphans_found: orphans.length,
      deleted_count: deleted.length,
      deleted,
      failed_count: failed.length,
      failed,
      _hint: failed.length ? 'Some deletes failed — inspect `failed[]` for details.' : 'All orphans cleaned.',
      backup: sweepBackup.block,
    };
  }

  return { _error: `Unknown action: ${action}`, _hint: 'One of: list, get, create, update, delete, link, unlink, create_and_link, orphan_sweep.' };
}

// ────────────────────────────────────────────────────────────────────────────
// manage_program_rules — Full CRUD for program rules, variables and actions
// ────────────────────────────────────────────────────────────────────────────

// Validate a program rule condition via DHIS2's own parser. This catches syntax
// and reference errors that local linting cannot model perfectly.
async function validateProgramRuleCondition(condition, programId) {
  if (!dhis2.baseUrl || !dhis2.apiVersion) {
    const ok = await ensureConnected();
    if (!ok) return { _error: 'Not connected to DHIS2' };
  }
  const url = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/programRules/condition/description?programId=${encodeURIComponent(programId)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: condition || '',
    });
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      try {
        const parsed = JSON.parse(bodyText);
        return { _error: parsed.message || parsed.description || `HTTP ${resp.status}`, _status: resp.status };
      } catch {
        return { _error: `HTTP ${resp.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`, _status: resp.status };
      }
    }
    try { return JSON.parse(bodyText); } catch { return { status: 'OK', description: bodyText }; }
  } catch (e) {
    return { _error: `Validation fetch failed: ${e.message}` };
  }
}

function getProgramRuleExpressionRefs(text) {
  const s = String(text || '');
  const hash = [...s.matchAll(/#\{([^}]+)\}/g)].map(m => m[1]);
  const tea = [...s.matchAll(/A\{([^}]+)\}/g)].map(m => m[1]);
  return { hash, tea };
}

async function executeManageProgramRules(args, ctxProgramId) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  const programId = args.program_id || ctxProgramId;

  // ── list ──
  if (action === 'list') {
    if (!programId) return { _error: 'program_id required for list' };
    const [rulesResp, varsResp] = await Promise.all([
      safeDhis2Fetch(
        `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,priority,description,programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]]&pageSize=100&order=priority:asc`
      ),
      safeDhis2Fetch(
        `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=100`
      ),
    ]);
    if (rulesResp._error) return rulesResp;
    return {
      programRules: rulesResp.programRules || [],
      programRuleVariables: varsResp._error ? [] : (varsResp.programRuleVariables || []),
      total_rules: rulesResp._pagerInfo?.total ?? (rulesResp.programRules || []).length,
      _note: 'Use action=get with rule_id for full action details on a specific rule.',
    };
  }

  // ── list_variables ──
  if (action === 'list_variables') {
    if (!programId) return { _error: 'program_id required for list_variables' };
    return safeDhis2Fetch(
      `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=100`
    );
  }

  // ── get ──
  if (action === 'get') {
    if (!args.rule_id) return { _error: 'rule_id required for get' };
    return safeDhis2Fetch(
      `programRules/${args.rule_id}?fields=id,name,condition,priority,description,program[id,displayName],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName],programStageSection[id,displayName]]`
    );
  }

  // ── create ──
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_program_rules', 'create');
    if (_gate) return _gate;
    if (!programId) return { _error: 'program_id required for create' };
    const rulesToCreate = args.rules || (args.rule ? [args.rule] : null);
    if (!rulesToCreate?.length) return { _error: 'rule object or rules array required for create' };
    return await _buildAndPostProgramRules(programId, rulesToCreate, args.dry_run_only);
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_program_rules', 'update', { rule_id: args.rule_id });
    if (_gate) return _gate;
    if (!args.rule_id) return { _error: 'rule_id required for update' };
    if (!args.rule) return { _error: 'rule object (with fields to change) required for update' };

    // Verify the rule exists BEFORE touching it. 404 → STOP, do not invent context.
    const _verify = await verifyTargetExists('programRules', args.rule_id, 'manage_program_rules', 'update',
      'id,name,condition,priority,description,program[id],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id],trackedEntityAttribute[id],programStage[id]]');
    if (!_verify.exists) return _verify.refusal;
    const existing = _verify.data;

    const merged = {
      name:        args.rule.name        ?? existing.name,
      condition:   args.rule.condition   ?? existing.condition,
      description: args.rule.description ?? existing.description,
      priority:    args.rule.priority    ?? existing.priority,
      variables:   args.rule.variables   || [],
      // New actions array replaces all old actions when provided; otherwise keep existing
      actions:     args.rule.actions     || null,
    };

    const oldActionIds = (existing.programRuleActions || []).map(a => a.id);
    const pid = existing.program?.id || programId;

    const allPRVs = [];
    const allPRAs = [];

    // Build variables if any
    for (const v of (merged.variables || [])) {
      const prvUid = generateDhis2Uid();
      const prv = {
        id: prvUid,
        name: v.name,
        program: { id: pid },
        programRuleVariableSourceType: v.source_type || 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
        valueType: v.value_type || 'TEXT',
        useCodeForOptionSet: v.use_code_for_option_set || false,
      };
      if (v.data_element_id) prv.dataElement = { id: v.data_element_id };
      if (v.tei_attribute_id) prv.trackedEntityAttribute = { id: v.tei_attribute_id };
      if (v.program_stage_id) prv.programStage = { id: v.program_stage_id };
      allPRVs.push(prv);
    }

    // Resolve any action target display names → UIDs (same as the create path).
    // Without this a name-targeted ASSIGN/SETMANDATORYFIELD/HIDEFIELD would save
    // target-less and DHIS2 would reject the whole update.
    if (merged.actions) {
      const _res = await resolveRuleActionTargetNames(pid, merged.actions);
      if (_res.unresolved && _res.unresolved.length) {
        return {
          _error: `Rule action target name(s) could not be resolved on this program: ${_res.unresolved.map(u => `${u.kind} "${u.name}"`).join(', ')}.`,
          _hint: 'Pass the exact data element / attribute display name as it appears on this program, or pass the UID directly (data_element_id / tei_attribute_id).',
        };
      }
    }

    // Visibility semantics on the merged rule: refuse an update that would
    // leave the rule hiding + mandating the same field, or "showing" a field
    // by hiding it (same checks as create — see lintRuleVisibilitySemantics).
    if (merged.actions) {
      const semanticErrors = lintRuleVisibilitySemantics([
        { name: merged.name, condition: merged.condition, actions: merged.actions },
      ]);
      if (semanticErrors.length) {
        return {
          success: false,
          _error: `Program rule semantics lint failed: ${semanticErrors.join(' | ')}`,
          phase: 'lint',
          errors: semanticErrors,
          _hint: 'Rewrite as ONE hide rule per target (condition = the HIDE case); mandatory-when-visible goes in a separate SETMANDATORYFIELD-only rule with the positive condition. Then retry.',
        };
      }
    }

    // Token resolution on the UPDATED condition / action data. Without this,
    // an update whose new condition references #{a_de_never_variable_ized}
    // saves fine but the rule silently never fires — the same failure class
    // the create paths already refuse. Display-name tokens are auto-rewritten
    // to canonical form; tokens that resolve to a program DE/TEA get their
    // PRV auto-created; genuinely unknown tokens refuse the update.
    const tokenRewrites = [];
    if (args.rule.condition !== undefined || (merged.actions || []).some(a => a.data)) {
      const [progStructResp, prvResp] = await Promise.all([
        safeDhis2Fetch(`programs/${pid}?fields=programStages%5Bid,programStageDataElements%5BdataElement%5Bid,displayName,valueType,optionSet%5Bid%5D%5D%5D%5D,programTrackedEntityAttributes%5BtrackedEntityAttribute%5Bid,displayName,valueType,optionSet%5Bid%5D%5D%5D`),
        safeDhis2Fetch(`programRuleVariables?filter=program.id:eq:${pid}&fields=id,name&pageSize=200`),
      ]);
      if (!progStructResp._error && !prvResp._error) {
        const deInfo = new Map();   // displayName → {id, valueType, optionSet, stageId}
        for (const ps of (progStructResp.programStages || [])) {
          for (const psde of (ps.programStageDataElements || [])) {
            const de = psde.dataElement;
            if (de?.id && !deInfo.has(de.displayName)) deInfo.set(de.displayName, { ...de, stageId: ps.id });
          }
        }
        const teaInfo = new Map();
        for (const ptea of (progStructResp.programTrackedEntityAttributes || [])) {
          const tea = ptea.trackedEntityAttribute;
          if (tea?.id) teaInfo.set(tea.displayName, tea);
        }
        const existingVarNames = new Set((prvResp.programRuleVariables || []).map(v => v.name));
        for (const v of (merged.variables || [])) if (v.name) existingVarNames.add(v.name);
        const pseudoRule = { name: merged.name, condition: merged.condition, actions: merged.actions || [] };
        const { bindings, unresolved, rewrites } = resolveRuleTokenBindings(
          pseudoRule, [...deInfo.keys()], [...teaInfo.keys()], existingVarNames
        );
        if (unresolved.length) {
          return {
            success: false,
            phase: 'lint',
            _error: `Updated rule "${merged.name}" references unresolved variable(s): ${unresolved.join(', ')} — no program rule variable, data element or attribute of this program matches. The rule would save but NEVER fire. Nothing was changed.`,
            unresolved,
            available_variables: [...existingVarNames].map(n => `#{${n}}`),
            available_data_elements: [...deInfo.keys()].map(n => `#{${sanitizeVariableName(n)}}`),
            available_attributes: [...teaInfo.keys()].map(n => `A{${sanitizeVariableName(n)}}`),
            _hint: 'Reference an existing program rule variable, or #{sanitized_data_element_name} / A{sanitized_attribute_name} of this program. Fix the token(s) and retry.',
          };
        }
        merged.condition = pseudoRule.condition;
        tokenRewrites.push(...rewrites);
        // Auto-create the PRVs the (re)written expression needs.
        for (const b of bindings) {
          if (b.kind === 'de') {
            const de = deInfo.get(b.name);
            allPRVs.push({
              id: generateDhis2Uid(), name: b.token, program: { id: pid },
              programRuleVariableSourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
              valueType: de.valueType || 'TEXT',
              useCodeForOptionSet: !!de.optionSet,
              dataElement: { id: de.id },
              ...(de.stageId ? { programStage: { id: de.stageId } } : {}),
            });
          } else {
            const tea = teaInfo.get(b.name);
            allPRVs.push({
              id: generateDhis2Uid(), name: b.token, program: { id: pid },
              programRuleVariableSourceType: 'TEI_ATTRIBUTE',
              valueType: tea.valueType || 'TEXT',
              useCodeForOptionSet: !!tea.optionSet,
              trackedEntityAttribute: { id: tea.id },
            });
          }
        }
      }
    }

    // Decide which actions to use
    const actionsToPost = merged.actions
      ? merged.actions  // new set provided — will replace all old ones
      : (existing.programRuleActions || []).map(a => ({
          // re-use existing actions unchanged
          _existingId: a.id,
          type: a.programRuleActionType,
          content: a.content,
          data: a.data,
          data_element_id: a.dataElement?.id,
          tei_attribute_id: a.trackedEntityAttribute?.id,
          program_stage_id: a.programStage?.id,
          evaluation_time: a.evaluationTime,
        }));

    // Reuse the existing action UIDs positionally when a new actions array is
    // provided: the metadata import (mergeMode REPLACE) then UPDATES each old
    // row in place — type/content/target all swap cleanly — instead of
    // creating new rows and orphaning the old ones. The orphan-delete used to
    // 409 ("could not automatically delete the old action") and leave junk
    // programRuleAction rows behind; with ID reuse the common N→N action swap
    // produces zero orphans and zero DELETE calls.
    const reusableOldIds = merged.actions ? [...oldActionIds] : [];
    const newActionIds = [];
    for (const act of actionsToPost) {
      const praId = act._existingId || reusableOldIds.shift() || generateDhis2Uid();
      newActionIds.push(praId);
      const pra = {
        id: praId,
        programRule: { id: args.rule_id },
        programRuleActionType: act.type,
        evaluationTime: act.evaluation_time || 'ON_DATA_ENTRY',
      };
      if (act.content) pra.content = act.content;
      if (act.data) pra.data = act.data;
      if (act.data_element_id) pra.dataElement = { id: act.data_element_id };
      if (act.tei_attribute_id) pra.trackedEntityAttribute = { id: act.tei_attribute_id };
      if (act.program_stage_id) pra.programStage = { id: act.program_stage_id };
      if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };
      allPRAs.push(pra);
    }

    const updatedRule = {
      id: args.rule_id,
      name: merged.name,
      program: { id: pid },
      condition: merged.condition || 'true',
      programRuleActions: newActionIds.map(id => ({ id })),
    };
    if (merged.description !== undefined) updatedRule.description = merged.description;
    if (merged.priority !== undefined) updatedRule.priority = merged.priority;

    const payload = {};
    if (allPRVs.length) payload.programRuleVariables = allPRVs;
    if (allPRAs.length) payload.programRuleActions = allPRAs;
    payload.programRules = [updatedRule];

    // Lint the merged condition the same way create does.
    const lintErr = lintProgramRuleCondition(updatedRule.condition, updatedRule.name);
    if (lintErr) {
      return {
        success: false,
        _error: `Program rule condition lint failed: ${lintErr}`,
        phase: 'lint',
        errors: [lintErr],
        _hint: 'Fix the condition using the suggested canonical form, then retry.',
      };
    }

    if (args.dry_run_only) {
      return { success: true, phase: 'dry_run', message: 'Dry run only. No changes committed.', would_update: updatedRule };
    }

    // Snapshot the rule and every action it references (including any old
    // actions that this update will orphan-delete) so a restore can rebuild
    // the full rule structure.
    const ruleBackupTargets = [
      { object_type: 'programRules', object_id: args.rule_id, role: 'primary' },
      ...oldActionIds.map((aid) => ({ object_type: 'programRuleActions', object_id: aid, role: 'cascade' })),
    ];
    const backup = await ensureBackupOrBail(
      { operation: 'update', tool: 'manage_program_rules', action: 'update', reason: `Updating program rule ${merged.name || args.rule_id}` },
      ruleBackupTargets,
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload(payload, false);

    // Delete surplus old actions the update no longer uses (only possible when
    // the new actions array is SHORTER than the old one — equal/longer arrays
    // reuse every old UID in place and leave nothing to clean up).
    const orphan_cleanup = { attempted: [], deleted: [], failed: [] };
    if (result.success && merged.actions && oldActionIds.length) {
      const toDelete = oldActionIds.filter(id => !newActionIds.includes(id));
      orphan_cleanup.attempted = toDelete;
      for (const aid of toDelete) {
        let d = await safeDhis2Fetch(`programRuleActions/${aid}`, { method: 'DELETE', allowEmptyBody: true });
        if (d._error) {
          // Raw DELETE on programRuleActions can 409 right after the rule
          // import; the metadata import path handles the reference bookkeeping
          // and succeeds where the raw endpoint conflicts.
          d = await safeDhis2Fetch('metadata?importStrategy=DELETE&atomicMode=ALL',
            { method: 'POST', body: { programRuleActions: [{ id: aid }] } });
        }
        if (d._error) orphan_cleanup.failed.push({ id: aid, error: d._error });
        else orphan_cleanup.deleted.push(aid);
      }
    }

    const response = { ...result, updated_rule_id: args.rule_id, rule_name: merged.name, backup: backup.block };
    if (tokenRewrites.length) response.rule_token_rewrites = tokenRewrites;
    if (orphan_cleanup.attempted.length) {
      response.orphan_cleanup = orphan_cleanup;
      if (orphan_cleanup.failed.length) {
        response._hint = `Rule update succeeded but ${orphan_cleanup.failed.length} old programRuleAction row(s) could not be deleted — they are now orphaned. Inspect orphan_cleanup.failed and delete manually via dhis2_query DELETE programRuleActions/{id}.`;
      }
    }
    return response;
  }

  // ── delete ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_program_rules', 'delete', { rule_id: args.rule_id });
    if (_gate) return _gate;
    if (!args.rule_id) return { _error: 'rule_id required for delete' };

    // Verify the rule exists BEFORE deleting. 404 → STOP, do not invent context.
    const _verify = await verifyTargetExists('programRules', args.rule_id, 'manage_program_rules', 'delete');
    if (!_verify.exists) return _verify.refusal;

    // Snapshot the rule (and its actions) so a restore can recreate the full structure.
    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_program_rules', action: 'delete', reason: `Deleting program rule ${args.rule_id}` },
      [{ object_type: 'programRules', object_id: args.rule_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const resp = await safeDhis2Fetch(`programRules/${args.rule_id}`, { method: 'DELETE' });
    if (resp._error) return { ...resp, backup: backup.block };
    return { success: true, deleted_rule_id: args.rule_id, backup: backup.block };
  }

  // ── audit ──
  // Scan every rule + variable in a program and report structural problems that stop rules
  // firing at runtime. Does NOT commit any change — returns issues + fix hints.
  if (action === 'audit') {
    if (!programId) return { _error: 'program_id required for audit' };
    const deep = args.deep !== false;

    // Paginate rules + actions (pageCount-driven so we never miss a page)
    const PAGE_SIZE = 100;
    const allRules = [];
    const ruleFirst = await safeDhis2Fetch(
      `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,priority,description,programStage[id,displayName],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName],programStageSection[id,displayName]]&pageSize=${PAGE_SIZE}&page=1&order=name:asc&totalPages=true`,
      { noTruncate: true }
    );
    if (ruleFirst._error) return ruleFirst;
    allRules.push(...(ruleFirst.programRules || []));
    const totalRules = ruleFirst.pager?.total ?? allRules.length;
    const rulePageCount = ruleFirst.pager?.pageCount ?? 1;
    const fetchErrors = [];
    for (let p = 2; p <= Math.min(rulePageCount, 50); p++) {
      const resp = await safeDhis2Fetch(
        `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,priority,description,programStage[id,displayName],programRuleActions[id,programRuleActionType,content,data,evaluationTime,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName],programStageSection[id,displayName]]&pageSize=${PAGE_SIZE}&page=${p}&order=name:asc`,
        { noTruncate: true }
      );
      if (resp._error) { fetchErrors.push({ kind: 'rules', page: p, error: resp._error }); continue; }
      allRules.push(...(resp.programRules || []));
    }

    // Variables
    const allVars = [];
    const varFirst = await safeDhis2Fetch(
      `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=${PAGE_SIZE}&page=1&order=name:asc&totalPages=true`,
      { noTruncate: true }
    );
    if (varFirst._error) {
      fetchErrors.push({ kind: 'variables', error: varFirst._error });
    } else {
      allVars.push(...(varFirst.programRuleVariables || []));
      const varPageCount = varFirst.pager?.pageCount ?? 1;
      for (let p = 2; p <= Math.min(varPageCount, 50); p++) {
        const resp = await safeDhis2Fetch(
          `programRuleVariables?filter=program.id:eq:${programId}&fields=id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id,displayName]&pageSize=${PAGE_SIZE}&page=${p}&order=name:asc`,
          { noTruncate: true }
        );
        if (resp._error) { fetchErrors.push({ kind: 'variables', page: p, error: resp._error }); continue; }
        allVars.push(...(resp.programRuleVariables || []));
      }
    }
    const varByName = new Map();
    for (const v of allVars) varByName.set(v.name, v);

    // Program structure — for validating DE / TEA / stage / section references.
    // PSDE compulsory included so we can flag HIDEFIELD-on-compulsory (DHIS2 New
    // Tracker Capture refuses to visually hide a compulsory DE — exactly the
    // "5 unhidden" failure mode users hit when HIDEALLFIELDS is asked of stages
    // whose DEs are compulsory).
    const progResp = await safeDhis2Fetch(
      `programs/${programId}?fields=id,programStages[id,displayName,programStageDataElements[id,compulsory,dataElement[id,displayName]],programStageSections[id,displayName]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName]]`,
      { noTruncate: true }
    );
    const validStageIds = new Set();
    const validDeIds = new Set();
    const validTeaIds = new Set();
    const validSectionIds = new Set();
    const compulsoryDeIds = new Set(); // DE ids with compulsory=true on at least one PSDE
    let structureAvailable = false;
    if (!progResp._error) {
      structureAvailable = true;
      for (const stage of (progResp.programStages || [])) {
        validStageIds.add(stage.id);
        for (const psde of (stage.programStageDataElements || [])) {
          if (psde.dataElement?.id) {
            validDeIds.add(psde.dataElement.id);
            if (psde.compulsory) compulsoryDeIds.add(psde.dataElement.id);
          }
        }
        for (const sec of (stage.programStageSections || [])) {
          if (sec.id) validSectionIds.add(sec.id);
        }
      }
      for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
        if (ptea.trackedEntityAttribute?.id) validTeaIds.add(ptea.trackedEntityAttribute.id);
      }
    }

    // Action types that require each of the target fields
    const NEEDS_CONTENT = new Set(['SHOWWARNING', 'SHOWERROR', 'DISPLAYTEXT', 'WARNINGONCOMPLETE', 'ERRORONCOMPLETE']);
    const NEEDS_DATA = new Set(['ASSIGN']);
    const NEEDS_DE_OR_TEA = new Set(['HIDEFIELD', 'SETMANDATORYFIELD']);
    const NEEDS_STAGE = new Set(['HIDEPROGRAMSTAGE', 'CREATEEVENT']);
    const NEEDS_SECTION = new Set(['HIDESECTION']);

    const ruleIssues = [];
    const varIssues = [];

    // ── Rule-level scan ──
    for (const rule of allRules) {
      const probs = [];
      const cond = rule.condition || '';

      if (!cond.trim()) {
        probs.push('Empty condition — rule will never fire.');
      } else {
        const lintErr = lintProgramRuleCondition(cond, null);
        if (lintErr) probs.push(`Condition lint: ${lintErr}`);
      }

      // #{var} references must resolve to a programRuleVariable
      const hashRefs = getProgramRuleExpressionRefs(cond).hash;
      const seenHash = new Set();
      for (const varName of hashRefs) {
        if (seenHash.has(varName)) continue;
        seenHash.add(varName);
        if (!varByName.has(varName)) {
          probs.push(`Condition references unknown variable #{${varName}} — no programRuleVariable with that name exists in this program.`);
        }
      }

      // A{attr} references must resolve to a program TEA (by UID — 11-char DHIS2 UID)
      const teaRefs = getProgramRuleExpressionRefs(cond).tea;
      const seenTea = new Set();
      for (const ref of teaRefs) {
        if (seenTea.has(ref)) continue;
        seenTea.add(ref);
        if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(ref)) {
          if (structureAvailable && !validTeaIds.has(ref)) {
            probs.push(`Condition references tracked-entity attribute not on this program: A{${ref}}`);
          }
        }
        // A{name} form is also legal — skipped; the engine resolves by name
      }

      // Balanced braces/parens
      let dp = 0, db = 0;
      for (const c of cond) {
        if (c === '(') dp++; else if (c === ')') dp--;
        else if (c === '{') db++; else if (c === '}') db--;
        if (dp < 0 || db < 0) break;
      }
      if (dp !== 0) probs.push('Unbalanced parentheses in condition.');
      if (db !== 0) probs.push('Unbalanced braces in condition.');

      // Actions — each must have the fields its type demands, and refs must resolve.
      const actions = rule.programRuleActions || [];
      if (actions.length === 0) {
        probs.push('No programRuleActions — rule has nothing to do even if condition fires.');
      }
      for (const a of actions) {
        const t = a.programRuleActionType;
        const deId = a.dataElement?.id;
        const teaId = a.trackedEntityAttribute?.id;
        const stageId = a.programStage?.id;
        const sectionId = a.programStageSection?.id;

        if (NEEDS_CONTENT.has(t) && !String(a.content || '').trim() && !String(a.data || '').trim()) {
          probs.push(`${t} action ${a.id} has no content — warning/error/display will be blank.`);
        }
        // Variable refs in `content` are shown literally (DHIS2 only evaluates `data`).
        if (NEEDS_CONTENT.has(t) && t !== 'DISPLAYTEXT' && /[#A]\{[^}]+\}/.test(String(a.content || ''))) {
          probs.push(`${t} action ${a.id} has variable refs in content — DHIS2 will display the literal "#{var}" / "A{attr}" tokens. Move dynamic refs to the data field (e.g. content="Selected:" + data="#{my_de}", or data="d2:concatenate(\\"prefix \\", #{a}, \\", \\", #{b})"). Fix via manage_program_rules(action=update) or bulk_fix_conditions can't help here — this is an action-level fix.`);
        }
        if (NEEDS_DATA.has(t) && !String(a.data || '').trim()) {
          probs.push(`${t} action ${a.id} has no data expression — ASSIGN cannot compute a value.`);
        }
        if (String(a.data || '').trim()) {
          const refs = getProgramRuleExpressionRefs(a.data);
          const seenActionHash = new Set();
          for (const varName of refs.hash) {
            if (seenActionHash.has(varName)) continue;
            seenActionHash.add(varName);
            if (!varByName.has(varName)) {
              probs.push(`${t} action ${a.id} data references unknown variable #{${varName}} — no programRuleVariable with that name exists in this program.`);
            }
          }
          const seenActionTea = new Set();
          for (const ref of refs.tea) {
            if (seenActionTea.has(ref)) continue;
            seenActionTea.add(ref);
            if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(ref) && structureAvailable && !validTeaIds.has(ref)) {
              probs.push(`${t} action ${a.id} data references tracked-entity attribute not on this program: A{${ref}}`);
            }
          }
        }
        if (NEEDS_DE_OR_TEA.has(t) && !deId && !teaId) {
          probs.push(`${t} action ${a.id} has neither dataElement nor trackedEntityAttribute target — it will not apply to any field.`);
        }
        if (NEEDS_STAGE.has(t) && !stageId) {
          probs.push(`${t} action ${a.id} has no programStage target.`);
        }
        if (NEEDS_SECTION.has(t) && !sectionId) {
          probs.push(`${t} action ${a.id} has no programStageSection target.`);
        }

        if (structureAvailable) {
          if (deId && !validDeIds.has(deId)) {
            probs.push(`${t} action ${a.id} targets dataElement ${deId} which is not on any stage of this program (orphan reference).`);
          }
          if (teaId && !validTeaIds.has(teaId)) {
            probs.push(`${t} action ${a.id} targets trackedEntityAttribute ${teaId} which is not on this program.`);
          }
          if (stageId && !validStageIds.has(stageId)) {
            probs.push(`${t} action ${a.id} targets programStage ${stageId} which does not exist on this program.`);
          }
          if (sectionId && !validSectionIds.has(sectionId)) {
            probs.push(`${t} action ${a.id} targets programStageSection ${sectionId} which does not exist on this program.`);
          }
          // HIDEFIELD on a compulsory PSDE: DHIS2 New Tracker Capture leaves the
          // field VISIBLE because compulsion outranks visibility rules. Surface a
          // structured fix hint pointing at the auto-fix path.
          if (t === 'HIDEFIELD' && deId && compulsoryDeIds.has(deId)) {
            probs.push(`HIDEFIELD action ${a.id} targets dataElement ${deId} which is compulsory in its program stage — DHIS2 New Tracker Capture will NOT visually hide a compulsory DE, so this rule appears to fail. Fix: clear the PSDE compulsory flag (PUT the parent programStage with compulsory=false on the PSDE) AND add a paired SETMANDATORYFIELD rule with the inverse condition to restore mandatory status when the DE is shown. Recreating the rule via manage_program_rules(action=create) using HIDEALLFIELDS does both automatically.`);
          }
        }
      }

      const hasConditionFinding = probs.some(p => p.startsWith('Condition ') || p.includes(' condition'));
      if (deep && cond.trim() && hasConditionFinding) {
        const serverRes = await validateProgramRuleCondition(cond, programId);
        const status = serverRes?.status;
        const serverRejected = serverRes?._error
          || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
        if (serverRejected) {
          const msg = serverRes._error || serverRes.message || serverRes.description || status || 'unknown error';
          probs.push(`Server rejected condition: ${String(msg).substring(0, 200)}`);
        } else if (serverRes?.status === 'OK') {
          // DHIS2's parser is authoritative for condition references. If a
          // metadata page failed to load completely, do not keep local-only
          // unknown-variable findings for the condition.
          for (let i = probs.length - 1; i >= 0; i--) {
            if (probs[i].startsWith('Condition references unknown variable ')) probs.splice(i, 1);
          }
        }
      }

      if (probs.length) {
        ruleIssues.push({
          id: rule.id,
          name: rule.name,
          condition: cond.substring(0, 300),
          action_count: actions.length,
          issues: probs,
        });
      }
    }

    // ── Variable-level scan ──
    for (const v of allVars) {
      const probs = [];
      const st = v.programRuleVariableSourceType;
      if (!st) {
        probs.push('Missing programRuleVariableSourceType.');
      }
      if (st === 'TEI_ATTRIBUTE') {
        if (!v.trackedEntityAttribute?.id) probs.push('TEI_ATTRIBUTE variable has no trackedEntityAttribute reference.');
        else if (structureAvailable && !validTeaIds.has(v.trackedEntityAttribute.id)) {
          probs.push(`TEI_ATTRIBUTE variable points at TEA ${v.trackedEntityAttribute.id} not on this program (orphan).`);
        }
      }
      if (st && st.startsWith('DATAELEMENT_')) {
        if (!v.dataElement?.id) probs.push(`${st} variable has no dataElement reference.`);
        else if (structureAvailable && !validDeIds.has(v.dataElement.id)) {
          probs.push(`${st} variable points at dataElement ${v.dataElement.id} not in any stage of this program (orphan).`);
        }
        if (st === 'DATAELEMENT_NEWEST_EVENT_PROGRAM_STAGE' && !v.programStage?.id) {
          probs.push('DATAELEMENT_NEWEST_EVENT_PROGRAM_STAGE variable has no programStage reference.');
        }
      }
      if (probs.length) {
        varIssues.push({ id: v.id, name: v.name, source_type: st, issues: probs });
      }
    }

    // ── Cross-rule visibility-semantics scan ──
    // Same checks the create/update paths enforce at lint time, run over the
    // EXISTING rule set: hide+mandate contradictions inside one rule, show/hide
    // twin rules that hide the same target under complementary conditions
    // (target permanently hidden — the classic "field shows but can't be
    // used" / "field never appears" complaint), and duplicate hide rules.
    const crossRuleIssues = lintRuleVisibilitySemantics(allRules);

    // Build fix hints for the conditions that only need a lint-driven rewrite.
    const conditionFixHints = [];
    for (const r of ruleIssues) {
      const lintLine = r.issues.find(x => x.startsWith('Condition lint:'));
      if (!lintLine) continue;
      const fixMatch = lintLine.match(/Rewrite as `([^`]+)`/);
      if (fixMatch) {
        conditionFixHints.push({
          rule_id: r.id,
          name: r.name,
          current_condition: r.condition,
          suggested_condition: fixMatch[1],
        });
      }
    }

    return {
      program_id: programId,
      total_rules_checked: allRules.length,
      total_rules_in_program: totalRules,
      total_variables_checked: allVars.length,
      structure_validation: structureAvailable ? 'full (DE/TEA/stage/section references checked)' : 'limited (program structure unavailable)',
      total_rules_with_issues: ruleIssues.length,
      total_variables_with_issues: varIssues.length,
      rule_issues: ruleIssues.slice(0, 200),
      variable_issues: varIssues.slice(0, 200),
      _has_more_rule_issues: ruleIssues.length > 200,
      _has_more_variable_issues: varIssues.length > 200,
      ...(crossRuleIssues.length ? { cross_rule_issues: crossRuleIssues.slice(0, 50) } : {}),
      ...(fetchErrors.length ? { _fetch_errors: fetchErrors } : {}),
      ...(conditionFixHints.length ? {
        _condition_fix_hints: conditionFixHints,
        _condition_fix_action: `manage_program_rules(action=bulk_fix_conditions, fixes=[...])`,
      } : {}),
      summary: (ruleIssues.length + varIssues.length + crossRuleIssues.length) === 0
        ? `All ${allRules.length} rules and ${allVars.length} variables are structurally sound.`
        : `Found ${ruleIssues.length} rule(s), ${varIssues.length} variable(s)${crossRuleIssues.length ? `, and ${crossRuleIssues.length} cross-rule contradiction(s)` : ''} with issues. ${crossRuleIssues.length ? 'Cross-rule contradictions make fields permanently hidden or hidden-and-mandatory — fix by DELETING the redundant "Show …" twin rule (there is no SHOW action in DHIS2; fields re-appear when the hide condition is false). ' : ''}${conditionFixHints.length ? 'Use bulk_fix_conditions to apply the suggested condition rewrites.' : 'Fix action targets / variable references via update/create/delete.'} NEVER use dhis2_query PUT/PATCH for program rule metadata.`,
    };
  }

  // ── bulk_fix_conditions ──
  // Batch-apply condition rewrites across many rules. Each fix either sets a new condition
  // directly, or applies a find/replace regex. All new conditions are lint-checked before POST.
  if (action === 'bulk_fix_conditions') {
    const _gate = requireWriteAuth('manage_program_rules', 'bulk_fix_conditions', { count: (args.fixes || []).length });
    if (_gate) return _gate;
    if (!Array.isArray(args.fixes) || !args.fixes.length) {
      return { _error: 'fixes array required for bulk_fix_conditions — each entry: { rule_id, condition? | find+replace? }' };
    }

    const prObjects = [];
    const changes = [];
    const lintErrors = [];
    const fetchErrors = [];

    for (const fix of args.fixes) {
      if (!fix.rule_id) { fetchErrors.push({ error: 'fix entry missing rule_id', entry: fix }); continue; }

      const existing = await safeDhis2Fetch(
        `programRules/${fix.rule_id}?fields=id,name,condition,priority,description,program[id],programStage[id],programRuleActions[id]`
      );
      if (existing._error) { fetchErrors.push({ id: fix.rule_id, error: existing._error }); continue; }

      let newCondition = existing.condition;
      if (typeof fix.condition === 'string') {
        newCondition = fix.condition;
      } else if (fix.find && typeof fix.replace === 'string') {
        try {
          newCondition = (existing.condition || '').replace(new RegExp(fix.find, 'g'), fix.replace);
        } catch (e) {
          fetchErrors.push({ id: fix.rule_id, error: `Invalid regex in fix.find: ${e.message}` });
          continue;
        }
      } else {
        fetchErrors.push({ id: fix.rule_id, error: 'fix entry must supply condition or find+replace' });
        continue;
      }

      const lintErr = lintProgramRuleCondition(newCondition, existing.name);
      if (lintErr) {
        lintErrors.push({ id: fix.rule_id, name: existing.name, rejected_value: newCondition, reason: lintErr });
        continue;
      }

      if (newCondition === existing.condition) continue; // nothing to do

      const pr = {
        id: existing.id,
        name: existing.name,
        program: { id: existing.program?.id || programId },
        condition: newCondition,
        programRuleActions: (existing.programRuleActions || []).map(a => ({ id: a.id })),
      };
      if (existing.programStage?.id) pr.programStage = { id: existing.programStage.id };
      if (existing.description !== undefined) pr.description = existing.description;
      if (existing.priority !== undefined) pr.priority = existing.priority;

      prObjects.push(pr);
      changes.push({
        id: existing.id,
        name: existing.name,
        before: existing.condition,
        after: newCondition,
      });
    }

    if (args.dry_run_only) {
      return {
        success: true,
        phase: 'dry_run',
        message: 'Dry run only. No changes committed.',
        would_commit: prObjects.length,
        changes,
        lint_errors: lintErrors,
        fetch_errors: fetchErrors,
      };
    }

    if (!prObjects.length) {
      return {
        _error: 'No rules to update.',
        lint_errors: lintErrors,
        fetch_errors: fetchErrors,
      };
    }

    // Snapshot every rule that we are about to mutate, in one batched dataStore entry.
    const backup = await ensureBackupOrBail(
      { operation: 'bulk_fix_conditions', tool: 'manage_program_rules', action: 'bulk_fix_conditions', reason: `Bulk-fixing conditions on ${prObjects.length} rule(s)` },
      prObjects.map((p) => ({ object_type: 'programRules', object_id: p.id, role: 'primary' })),
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload({ programRules: prObjects }, false);
    return {
      ...result,
      summary: {
        fixed_count: prObjects.length,
        lint_errors_count: lintErrors.length,
        fetch_errors_count: fetchErrors.length,
        rules: prObjects.map(p => ({ id: p.id, name: p.name })),
      },
      changes,
      ...(lintErrors.length ? { lint_errors: lintErrors } : {}),
      ...(fetchErrors.length ? { fetch_errors: fetchErrors } : {}),
      backup: backup.block,
    };
  }

  return { _error: `Unknown action: ${action}. Use: list, get, create, update, delete, list_variables, audit, bulk_fix_conditions` };
}

// Lint a program-rule condition for patterns known to fail in the DHIS2 rule engine.
// Returns null if OK, or an error string with the canonical fix.
function lintProgramRuleCondition(condition, ruleName) {
  if (!condition || typeof condition !== 'string') return null;
  const label = ruleName ? `"${ruleName}": ` : '';

  // #{var} == false / != false → engine treats false inconsistently, esp. when empty.
  const eqFalse = condition.match(/(#\{[^}]+\}|A\{[^}]+\})\s*(==|!=)\s*false\b/);
  if (eqFalse) {
    const v = eqFalse[1];
    const op = eqFalse[2];
    const fix = op === '==' ? `!d2:hasValue(${v}) || ${v} != true` : `d2:hasValue(${v}) && ${v} == true`;
    return `${label}condition uses \`${eqFalse[0]}\` which fails on BOOLEAN/TRUE_ONLY fields in DHIS2. Rewrite as \`${fix}\`.`;
  }

  // Quoted boolean literals: == 'true' / == "false" / == 'Yes' / == 'No'
  const quotedBool = condition.match(/(#\{[^}]+\}|A\{[^}]+\})\s*(==|!=)\s*['"](true|false|Yes|No|yes|no|YES|NO)['"]/);
  if (quotedBool) {
    const v = quotedBool[1];
    const op = quotedBool[2];
    const lit = quotedBool[3].toLowerCase();
    const wantsTrue = (op === '==' && (lit === 'true' || lit === 'yes'))
                   || (op === '!=' && (lit === 'false' || lit === 'no'));
    const fix = wantsTrue
      ? `${v} == true`
      : `!d2:hasValue(${v}) || ${v} != true`;
    return `${label}condition compares boolean against quoted literal \`${quotedBool[0]}\`. DHIS2 booleans are unquoted true/false. Rewrite as \`${fix}\`.`;
  }

  return null;
}

// ── Visibility-semantics lint ───────────────────────────────────────────────
// DHIS2 has NO "show field" action: everything is visible by default, HIDEFIELD
// / HIDESECTION / HIDEPROGRAMSTAGE hide while their condition is TRUE and the
// engine re-shows automatically when it turns false. Models that don't know
// this emit catastrophic rule sets — observed live (TB program, 2026-07-11):
//   • "Show Primary Symptoms when X is Yes"  = HIDEFIELD + SETMANDATORYFIELD
//     on the SAME field under the positive condition → selecting Yes hides the
//     field AND makes it mandatory at once (multi-select rendered unusable);
//   • paired with "Hide Primary Symptoms when X is No" (complementary
//     condition, same target) → the field is hidden in EVERY case.
// These import fine and fail only in front of the health worker, so they are
// blocked at lint time. Handles both the tool-input shape ({actions:[{type,
// data_element_name,...}]}) and the server shape ({programRuleActions:[...]}).

const PR_HIDE_ACTION_TYPES = new Set(['HIDEFIELD', 'HIDESECTION', 'HIDEPROGRAMSTAGE']);

// Every ProgramRuleActionType the DHIS2 server accepts (union across 2.40–2.43).
// Anything else fails Jackson enum deserialization with a 409/500 that kills the
// WHOLE atomic import before validation even runs — so an invalid type must be
// caught client-side and never reach the server. (Verified live 2026-07-12: a
// model-invented "COMPLETEENROLLMENT" 409'd the entire create_program import.)
const VALID_PR_ACTION_TYPES = new Set([
  'DISPLAYTEXT', 'DISPLAYKEYVALUEPAIR', 'HIDEFIELD', 'HIDESECTION', 'HIDEPROGRAMSTAGE',
  'ASSIGN', 'SHOWWARNING', 'WARNINGONCOMPLETE', 'SHOWERROR', 'ERRORONCOMPLETE',
  'CREATEEVENT', 'SETMANDATORYFIELD', 'SENDMESSAGE', 'SCHEDULEMESSAGE', 'SCHEDULEEVENT',
  'HIDEOPTION', 'SHOWOPTIONGROUP', 'HIDEOPTIONGROUP',
]);

// Model-invented action types that map to a real, closest-intent action. DHIS2
// has NO "complete/close enrollment" rule action, so the documented best effort
// is a visible completion PROMPT (SHOWWARNING with static content).
const PR_COMPLETE_PROMPT = 'This case meets the completion criteria — complete the enrollment to close the tracker file. (DHIS2 has no automatic complete-enrollment program-rule action.)';
const PR_ACTION_TYPE_ALIASES = {
  COMPLETEENROLLMENT: { type: 'SHOWWARNING', content: PR_COMPLETE_PROMPT },
  COMPLETEEVENT: { type: 'SHOWWARNING', content: PR_COMPLETE_PROMPT },
  CLOSEENROLLMENT: { type: 'SHOWWARNING', content: PR_COMPLETE_PROMPT },
  MARKCOMPLETE: { type: 'SHOWWARNING', content: PR_COMPLETE_PROMPT },
  FINISHENROLLMENT: { type: 'SHOWWARNING', content: PR_COMPLETE_PROMPT },
};

// Normalize a program-rule action's type BEFORE it is put on the wire. Returns
// one of:
//   { type }                       — a valid type (canonical upper-case)
//   { type, content, note }        — an aliased invalid type + fallback content
//   { skip: true, note }           — an unusable type; caller drops this action
// so no create_program / manage_program_rules path can 409 the whole import on a
// bad enum. Shared by every rule-building path (create_program, add_program_rules).
function normalizeRuleActionType(rawType, existingContent) {
  const t = String(rawType || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (VALID_PR_ACTION_TYPES.has(t)) return { type: t };
  const alias = PR_ACTION_TYPE_ALIASES[t];
  if (alias) {
    return {
      type: alias.type,
      content: existingContent || alias.content,
      note: `action type "${rawType}" is not a DHIS2 program-rule action — translated to ${alias.type} (visible completion prompt) so the import does not fail.`,
    };
  }
  return {
    skip: true,
    note: `action type "${rawType}" is not a valid DHIS2 ProgramRuleActionType and was dropped. Valid types: ${[...VALID_PR_ACTION_TYPES].join(', ')}.`,
  };
}

// Reduce a condition to the comparison that drives it: strip whitespace noise,
// the two canonical emptiness-guard prefixes, and redundant outer parens.
function _prCoreCondition(cond) {
  let s = String(cond || '').replace(/\s+/g, ' ').trim();
  let m = s.match(/^!\s*d2:hasValue\(\s*([#A]\{[^}]+\})\s*\)\s*\|\|\s*(.+)$/i);
  if (m) s = m[2].trim();
  else if ((m = s.match(/^d2:hasValue\(\s*([#A]\{[^}]+\})\s*\)\s*&&\s*(.+)$/i))) s = m[2].trim();
  for (;;) {
    if (!(s.startsWith('(') && s.endsWith(')'))) break;
    let depth = 0, wraps = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) { wraps = false; break; } }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function _prConditionsComplementary(a, b) {
  const ca = _prCoreCondition(a), cb = _prCoreCondition(b);
  if (!ca || !cb) return false;
  const parse = (s) => {
    const m = s.match(/^([#A]\{[^}]+\})\s*(==|!=)\s*(.+)$/);
    return m ? { ref: m[1], op: m[2], lit: m[3].trim() } : null;
  };
  const pa = parse(ca), pb = parse(cb);
  if (pa && pb && pa.ref === pb.ref && pa.lit === pb.lit && pa.op !== pb.op) return true;
  return `!(${ca})` === cb || `!(${cb})` === ca;
}

function _prConditionsEquivalent(a, b) {
  const ca = _prCoreCondition(a), cb = _prCoreCondition(b);
  return !!ca && ca === cb;
}

// Normalize one rule (either shape) → { name, condition, actions:[{type, keys:Set,
// label, hasHideAllFields}] }. `keys` holds every identifier the action's target
// answers to (kind-prefixed UID and sanitized display name) so input-shape rules
// (names) and server-shape rules (ids) can be matched against each other.
function _prNormalizeRuleForLint(rule) {
  const rawActions = rule.programRuleActions || rule.actions || [];
  const actions = [];
  let hasHideAllFields = false;
  for (const a of rawActions) {
    const type = a.programRuleActionType || a.type;
    if (type === 'HIDEALLFIELDS') hasHideAllFields = true;
    const keys = new Set();
    let label = null;
    const add = (prefix, id, name) => {
      if (id) keys.add(`${prefix}:${id}`);
      if (name) { keys.add(`${prefix}:${sanitizeVariableName(name)}`); label = label || name; }
    };
    add('de', a.data_element_id || a.dataElement?.id, a.data_element_name || a.dataElement?.displayName);
    add('tea', a.tei_attribute_id || a.trackedEntityAttribute?.id, a.tracked_entity_attribute_name || a.trackedEntityAttribute?.displayName);
    add('stage', a.program_stage_id || a.programStage?.id, a.program_stage_name || a.programStage?.displayName);
    add('section', a.program_stage_section_id || a.programStageSection?.id, a.programStageSection?.displayName);
    if (!label) label = a.data_element_id || a.tei_attribute_id || a.program_stage_id || a.program_stage_section_id
      || a.dataElement?.id || a.trackedEntityAttribute?.id || a.programStage?.id || a.programStageSection?.id || null;
    actions.push({ type, keys, label });
  }
  return { id: rule.id || null, name: rule.name || '', condition: rule.condition || '', actions, hasHideAllFields };
}

const _prKeysIntersect = (a, b) => { for (const k of a) if (b.has(k)) return true; return false; };

const PR_ONE_RULE_DOCTRINE = 'DHIS2 has NO SHOW action — fields/sections/stages are visible by default, and a HIDE action automatically un-hides when its condition turns false. "Show X only when C" = exactly ONE rule: condition = the HIDE case (e.g. !d2:hasValue(#{c}) || #{c} != true), action = HIDEFIELD on X. If X must also be mandatory when visible, add a SEPARATE rule with the positive condition and SETMANDATORYFIELD only. NEVER create show/hide rule pairs and NEVER put HIDEFIELD under the "show" condition.';

// Lint new rules (tool-input or server shape) against each other AND against
// the program's existing rules. Returns an array of error strings — callers
// refuse the import when any are present.
function lintRuleVisibilitySemantics(newRules, existingRules = []) {
  const errors = [];
  const news = (newRules || []).map(_prNormalizeRuleForLint);
  const olds = (existingRules || []).map(_prNormalizeRuleForLint);

  // 1. Same-rule contradiction: HIDE + SETMANDATORYFIELD on the same target.
  for (const r of news) {
    for (const hide of r.actions) {
      if (!PR_HIDE_ACTION_TYPES.has(hide.type)) continue;
      const mand = r.actions.find(a => a.type === 'SETMANDATORYFIELD' && _prKeysIntersect(a.keys, hide.keys));
      if (mand) {
        errors.push(`Rule "${r.name}": contradictory actions — ${hide.type} and SETMANDATORYFIELD both target "${hide.label}" in the SAME rule, so when the condition is true the field is hidden AND mandatory at once (the field renders broken/un-fillable in Capture). ${PR_ONE_RULE_DOCTRINE}`);
      }
    }
    // 2. Inverted "Show X" rule: the rule's name promises to SHOW the very
    // target its action HIDES while the condition is true.
    if (!r.hasHideAllFields && /^\s*(show|display|reveal|unhide)\b/i.test(r.name)) {
      const nameSan = `_${sanitizeVariableName(r.name)}_`;
      for (const act of r.actions) {
        if (!PR_HIDE_ACTION_TYPES.has(act.type)) continue;
        if (act.label && nameSan.includes(`_${sanitizeVariableName(String(act.label))}_`)) {
          errors.push(`Rule "${r.name}" claims to SHOW "${act.label}" but its ${act.type} action HIDES it while the condition is true — inverted semantics. ${PR_ONE_RULE_DOCTRINE}`);
          break;
        }
      }
    }
  }

  // 3. Complementary / duplicate hide pairs on the same target (batch-internal
  // and new-vs-existing). Complementary pair ⇒ the target is hidden in EVERY
  // case; duplicate ⇒ redundant twin rule.
  const hideEntries = (list, isNew) => {
    const out = [];
    for (const r of list) {
      for (const act of r.actions) {
        if (PR_HIDE_ACTION_TYPES.has(act.type)) out.push({ rule: r, act, isNew });
      }
    }
    return out;
  };
  const newHides = hideEntries(news, true);
  const allHides = [...newHides, ...hideEntries(olds, false)];
  const flagged = new Set();
  for (const a of newHides) {
    for (const b of allHides) {
      if (a === b || a.rule === b.rule) continue;
      if (a.act.type !== b.act.type || !_prKeysIntersect(a.act.keys, b.act.keys)) continue;
      const pairKey = [a.rule.name, b.rule.name, a.act.label].sort().join('|');
      if (flagged.has(pairKey)) continue;
      if (_prConditionsComplementary(a.rule.condition, b.rule.condition)) {
        flagged.add(pairKey);
        const bDesc = b.isNew ? `rule "${b.rule.name}" in this same request` : `EXISTING rule "${b.rule.name}"${b.rule.id ? ` (${b.rule.id})` : ''}`;
        errors.push(`Rule "${a.rule.name}" and ${bDesc} BOTH hide "${a.act.label}" under COMPLEMENTARY conditions ("${a.rule.condition}" vs "${b.rule.condition}") — together they hide it in every case, so the field/stage never appears. Keep ONLY the rule whose condition expresses when to HIDE and drop the other. ${PR_ONE_RULE_DOCTRINE}`);
      } else if (_prConditionsEquivalent(a.rule.condition, b.rule.condition)) {
        flagged.add(pairKey);
        const bDesc = b.isNew ? `rule "${b.rule.name}" in this same request` : `EXISTING rule "${b.rule.name}"${b.rule.id ? ` (${b.rule.id})` : ''}`;
        errors.push(`Rule "${a.rule.name}" duplicates ${bDesc}: same ${a.act.type} target "${a.act.label}" under an equivalent condition. Do not create duplicate rules — keep one.`);
      }
    }
  }
  return errors;
}

// ── Auto-guard bare `< / <=` numeric comparisons against EMPTY fields ──
// The Capture rules engine coerces an empty numeric field to 0, so a condition
// like `#{apgar_score} < 7` is TRUE before the user types anything and its
// SHOWWARNING/HIDEFIELD fires on a blank form. Verified live on play 2.40.12
// (2026-07-07): "APGAR < 7" warning rendered under an untouched empty field.
// Fix: wrap each bare `#{x} < n` / `#{x} <= n` atom in-place as
// `(d2:hasValue(#{x}) && #{x} < n)` — compositional under && and ||, so
// compound conditions keep their meaning. Deliberately skipped when the
// condition contains any negation (`!` other than `!=`) or already guards the
// same variable with d2:hasValue — rewriting inside a negation would invert
// the intended empty-field behavior.
function autoGuardNumericComparisons(condition) {
  const original = String(condition || '');
  if (!original.trim()) return { condition: original, guarded: [] };
  if (/!(?!=)/.test(original)) return { condition: original, guarded: [] }; // negations present — hands off
  const guarded = [];
  const re = /([#A]\{[^}]+\})\s*(<=?)\s*(-?\d+(?:\.\d+)?)(?!\d)/g;
  const rewritten = original.replace(re, (full, token, op, num) => {
    if (original.includes(`d2:hasValue(${token})`)) return full; // author already guarded it
    guarded.push(token);
    return `(d2:hasValue(${token}) && ${token} ${op} ${num})`;
  });
  return { condition: rewritten, guarded };
}

// ── Rewrite option NAMES → CODES in rule conditions and ASSIGN data ──
// Shared by the create_program embedded-rules path and add_program_rules.
// (manage_program_rules has its own equivalent, verified earlier — untouched.)
// Auto-created option-set PRVs use useCodeForOptionSet=true, so the engine
// compares option CODES. A condition/ASSIGN written with the option NAME
// ('Live Birth' instead of 'LIVE_BIRTH') lints clean, saves, and then never
// matches — the exact silent failure seen on the MCH program (play 2.40.12,
// 2026-07-07: Stage-2 infant fields stayed hidden even with outcome = Live
// Birth). This only rewrites a NAME literal to its CODE; literals that are
// already codes, empty-string checks, and unknown literals are left alone
// (unknowns are surfaced as advisories instead).
//   rules:   [{ name, condition }]                      — condition mutated in place
//   actions: [{ programRuleActionType, data, dataElement, trackedEntityAttribute }]
//   varToOsKey:    Map lowercased #{var} name → option-set key
//   targetToOsKey: Map DE/TEA id (action targets) → option-set key
//   optionsByOsKey: Map key → [{ name, code }]
function rewriteOptionLiteralsGeneric({ rules, actions, varToOsKey, targetToOsKey, optionsByOsKey }) {
  const advisories = [];
  const rewrites = [];
  const lookup = (osKey) => {
    const opts = optionsByOsKey.get(osKey);
    if (!opts || !opts.length) return null;
    return {
      byCode: new Set(opts.map(o => String(o.code))),
      byName: new Map(opts.map(o => [String(o.name).toLowerCase(), String(o.code)])),
      codes: opts.map(o => o.code).join(', '),
    };
  };

  for (const rule of (rules || [])) {
    let cond = String(rule.condition || '');
    const usedVars = new Set((cond.match(/#\{([^}]+)\}/g) || []).map(m => m.slice(2, -1)));
    for (const vRaw of usedVars) {
      const osKey = varToOsKey.get(vRaw.toLowerCase());
      if (!osKey) continue;
      const os = lookup(osKey);
      if (!os) continue;
      const varToken = `#{${vRaw}}`;
      const esc = vRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'([^']*)'|'([^']*)'\\s*(==|!=)\\s*#\\{${esc}\\}`, 'g');
      cond = cond.replace(re, (full, op1, lit1, lit2, op2) => {
        const lit = (lit1 !== undefined ? lit1 : lit2);
        const op = op1 || op2;
        if (lit === '') return full;         // empty-value check — leave alone
        if (os.byCode.has(lit)) return full; // already a code — leave alone
        const code = os.byName.get(lit.toLowerCase());
        if (code) {
          rewrites.push(`Rule "${rule.name}": '${lit}' → option code '${code}'`);
          return op1 ? `${varToken} ${op} '${code}'` : `'${code}' ${op} ${varToken}`;
        }
        advisories.push(`Rule "${rule.name}": #{${vRaw}} is compared to '${lit}', which is neither a code nor a name of its option set (codes: ${os.codes}). This comparison will never match — verify the value.`);
        return full;
      });
    }
    rule.condition = cond;
  }

  for (const pra of (actions || [])) {
    if (pra.programRuleActionType !== 'ASSIGN') continue;
    const targetId = pra.dataElement?.id || pra.trackedEntityAttribute?.id;
    const osKey = targetId && targetToOsKey.get(targetId);
    if (!osKey) continue;
    const os = lookup(osKey);
    if (!os) continue;
    const literal = typeof pra.data === 'string' && pra.data.trim().match(/^'([^']*)'$/);
    if (!literal) continue; // dynamic expression — can't statically check
    const value = literal[1];
    if (value === '' || os.byCode.has(value)) continue;
    const code = os.byName.get(value.toLowerCase());
    if (code) {
      rewrites.push(`ASSIGN '${value}' → option code '${code}'`);
      pra.data = `'${code}'`;
    } else {
      advisories.push(`ASSIGN uses '${value}', which is neither an option code nor an option name of the target's option set (codes: ${os.codes}). The assigned value will bounce on save — fix it.`);
    }
  }

  return { advisories, rewrites };
}

// PI grammar — d2 functions DHIS2 2.41 actually accepts inside a programIndicator
// expression OR filter. Keep in sync with VALID_D2_FUNCS in audit (line ~12854).
// d2:contains / d2:containsString / d2:inOrgUnit / d2:hasUserRole / d2:removeMin
// look tempting because they exist in Program Rules — they DO NOT exist in PI.
// Functions the PI ANTLR parser ACTUALLY accepts — every entry verified live
// against /programIndicators/{expression|filter}/description on BOTH
// play 2.42.5.1 and 2.43.0-1 (2026-07-10). The DHIS2 docs list many more
// (floor/ceil/round, string fns, zScore*, inOrgUnitGroup, lastEventDate) but
// the parser rejects them with "Item d2:<fn>( not supported for this type of
// expression" — docs-derived whitelisting produced false "valid" lints.
const VALID_PI_D2_FUNCS = new Set([
  'condition', 'count', 'countIfValue', 'countIfCondition', 'daysBetween',
  'hasValue', 'maxValue', 'minValue', 'monthsBetween', 'oizp', 'relationshipCount',
  'weeksBetween', 'yearsBetween', 'minutesBetween', 'zing', 'zpvc',
]);
// Documented-but-rejected: caught locally with a targeted workaround hint so
// the model self-corrects in one step instead of bouncing off the server.
const PI_D2_FUNCS_PARSER_REJECTS = new Set([
  'ceil', 'floor', 'round', 'modulus', 'addDays', 'validatePattern',
  'left', 'right', 'substring', 'split', 'concatenate', 'length',
  'inOrgUnitGroup', 'lastEventDate', 'zScoreHFA', 'zScoreWFA', 'zScoreWFH',
]);

// lintProgramIndicatorExpression — fast local check before round-tripping to
// DHIS2's /programIndicators/{expression|filter}/description. Catches the
// dead-on-arrival patterns that the model commonly emits, so the user gets a
// useful hint instead of a generic "Invalid string token 'd' at line:1
// character:0" from the server. Returns null when clean, else { error, hint }.
//
// kind: 'expression' | 'filter' (only used to phrase the hint)
function lintProgramIndicatorExpression(text, kind) {
  if (!text || typeof text !== 'string') return null;
  const t = text;

  // Program-RULE-only d2 functions leaking into a PI. d2:contains is the #1
  // offender — common ask is "MULTI_TEXT contains X AND Y" and the model
  // reaches for the rule-engine helper. The DHIS2 PI parser rejects it with
  // "Invalid string token 'd' at line:1 character:0" and analytics returns 409.
  const ruleOnly = t.match(/d2:(contains|containsString|inOrgUnit|hasUserRole|removeMin)\s*\(/);
  if (ruleOnly) {
    const fn = ruleOnly[1];
    const isContains = fn === 'contains' || fn === 'containsString';
    return {
      error: `\`d2:${fn}(\` is a program-rule function, not a program-indicator function. The DHIS2 PI parser rejects it (e.g. "Invalid string token 'd' at line:1 character:0"). Even if the create returns 201, analytics returns 409 at query time.`,
      hint: isContains
        ? 'There is NO contains operator in DHIS2 2.41 program-indicator grammar — `==` does exact-string match even on MULTI_TEXT (verified). Workarounds for "MULTI_TEXT contains both X and Y": (a) restructure: split the multi-select into separate BOOLEAN data elements (Diabetes flag, Hypertension flag), then filter `#{stage.de_dm} == true && #{stage.de_htn} == true` — clean and analytics-safe; (b) for ad-hoc analysis, use the Line Listing app which DOES support contains via the IN operator at query time; (c) brittle exact-match: `#{stage.de} == \'Diabetes,HYPERTENSION\'` — order-dependent and breaks if any other risk factor is selected. Tell the user (a) is the right fix; (c) is a stopgap only.'
        : 'This d2 function is only valid in Program Rules. Restructure the expression using a supported PI d2 function or plain operators.',
    };
  }

  // Unknown or parser-rejected d2 function — catch typos, made-up names, and
  // the documented-but-unsupported set early with a targeted workaround.
  const SUPPORTED_LIST = 'condition, count, countIfValue, countIfCondition, hasValue (FILTER only), daysBetween, weeksBetween, monthsBetween, yearsBetween, minutesBetween, minValue, maxValue, oizp, zing, zpvc, relationshipCount';
  const d2Calls = [...t.matchAll(/d2:([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
  for (const [, fn] of d2Calls) {
    if (PI_D2_FUNCS_PARSER_REJECTS.has(fn)) {
      const isRounding = fn === 'floor' || fn === 'ceil' || fn === 'round';
      return {
        error: `\`d2:${fn}(\` appears in the DHIS2 docs but the program-indicator parser REJECTS it ("Item d2:${fn}( not supported for this type of expression") — verified live on 2.42 and 2.43.`,
        hint: isRounding
          ? 'For rounding, drop the function and keep the plain arithmetic (e.g. `d2:daysBetween(#{stage.lmp}, V{event_date}) / 7`), then set the indicator\'s `decimals` (0 for whole numbers) — analytics rounds the displayed value. Supported functions: ' + SUPPORTED_LIST + '.'
          : `Restructure without d2:${fn}. Supported PI d2 functions (parser-verified): ${SUPPORTED_LIST}. String/date manipulation beyond these belongs in program RULES or the Line Listing app, and org-unit scoping belongs in the visualization's ou dimension, not the PI.`,
      };
    }
    if (!VALID_PI_D2_FUNCS.has(fn)) {
      return {
        error: `Unknown program-indicator function: \`d2:${fn}(\`.`,
        hint: `Supported PI d2 functions (parser-verified on 2.42/2.43): ${SUPPORTED_LIST}.`,
      };
    }
  }

  // d2:hasValue parses ONLY in filter context — in an expression the parser
  // returns "not supported for this type of expression" (verified 2.42 + 2.43).
  if (kind === 'expression' && /d2:hasValue\s*\(/.test(t)) {
    return {
      error: '`d2:hasValue(` is FILTER-only in the program-indicator grammar — the expression parser rejects it (verified live on 2.42 and 2.43).',
      hint: 'Move the has-value check into the indicator\'s `filter`, or in the expression use a numeric proxy like `d2:count(#{stage.de}) > 0` inside a d2:condition.',
    };
  }

  // subExpression(...) — Indicator (regular) feature; PI parser returns
  // "Item subExpression( not supported for this type of expression" (verified
  // against play.im.dhis2.org/stable-2-41-8 in both expression and filter context).
  if (/\bsubExpression\s*\(/.test(t)) {
    return {
      error: '`subExpression(...)` is not supported in program-indicator expressions or filters in DHIS2 2.41 — it is a feature of regular Indicators (a different object). The server returns "Item subExpression( not supported for this type of expression".',
      hint: 'Use only the documented PI grammar: ==, !=, <, >, <=, >=, &&, ||, +, -, *, / and the supported d2:* functions.',
    };
  }

  // SQL-style operators that look tempting but the PI ANTLR grammar rejects
  // ("Invalid string token 'LIKE' at line:1 character:N"). Verified.
  const sqlIsh = t.match(/(?:^|[\s(])(LIKE|ILIKE|IN\s*\(|position\s*\(|string_to_array\s*\(|coalesce\s*\(|regexp_match\s*\(|~\s*\')/i);
  if (sqlIsh) {
    return {
      error: `Token \`${sqlIsh[1].trim()}\` is SQL-style and is rejected by the DHIS2 program-indicator parser.`,
      hint: 'PI grammar supports only: ==, !=, <, >, <=, >=, &&, ||, +, -, *, / and the documented d2:* functions. There is no LIKE/ILIKE/IN/position/regex.',
    };
  }

  // Wrong reference shapes — defence in depth. C{}/I{}/OUG{} are valid in
  // regular indicators but not in program indicators.
  if (/\bC\{[^}]+\}/.test(t)) return { error: 'C{} (category option combo) references are not valid in program indicators.', hint: 'Use #{stageId.deId}, A{teaId}, V{var}, or a constant value instead.' };
  if (/\bI\{[^}]+\}/.test(t)) return { error: 'I{} (indicator) references are not valid in program indicators.', hint: 'Compose the calculation directly in this PI using #{stage.de} / A{tea}.' };
  if (/\bOUG\{[^}]+\}/.test(t)) return { error: 'OUG{} (org unit group) references are not valid in program indicators.', hint: 'Scope by org unit in the ANALYTICS request instead: put the org-unit group / OUs in the visualization\'s ou dimension (e.g. OU_GROUP-<ougId> in dhis2 analytics, or org_units in manage_dashboards). The PI itself must stay OU-agnostic — d2:inOrgUnitGroup is rejected by the PI parser on 2.42/2.43.' };

  // Same-field equality against two DIFFERENT literals is impossible ONLY when the
  // comparisons are AND-ed: `#{X} == 'A' && #{X} == 'B'`. The OR form
  // `#{X} == 'A' || #{X} == 'B'` is the NORMAL, correct way to match one of several
  // option codes (RR/MDR profile, treatment-outcome cohorts, …) and must NOT be
  // blocked. So evaluate the check PER OR-TERM (split on ||): within a single
  // conjunction a field can equal only one literal; across OR-terms it can equal
  // any of them. (The old check counted same-ref equalities across the whole
  // filter and wrongly rejected valid `||` "field in set" filters.)
  if (kind === 'filter') {
    for (const term of t.split('||')) {
      const byRef = new Map(); // ref → Set(distinct literals compared with ==)
      for (const m of term.matchAll(/(#\{[^}]+\}|A\{[^}]+\})\s*==\s*'([^']*)'/g)) {
        if (!byRef.has(m[1])) byRef.set(m[1], new Set());
        byRef.get(m[1]).add(m[2]);
      }
      for (const [ref, lits] of byRef) {
        if (lits.size >= 2) {
          return {
            error: `Filter requires the same field ${ref} to equal ${[...lits].map(l => `'${l}'`).join(' AND ')} simultaneously — logically impossible (within an AND a field can equal only one literal).`,
            hint: 'To match ANY of several values use OR: `#{X} == \'A\' || #{X} == \'B\'`. For a MULTI_TEXT "contains both A and B" (not expressible in PI grammar): split into BOOLEAN data elements and filter `#{stage.a} == true && #{stage.b} == true`, or use the Line Listing app at query time.',
          };
        }
      }
    }
  }

  return null;
}

// applyRuleActionSugar — shared rewrite step for both create-rule paths.
// Mutates `rules[].actions` in place AND returns the side-effect plan that the
// caller must execute against DHIS2:
//
//   { psdesToFlipNonCompulsory: [{ stageId, psdeId, deId, deName }],
//     siblingMandateRules: [{ name, condition, actions: [SETMANDATORYFIELD per DE] }] }
//
// Behaviors:
//   1. Auto-move #{var}/A{attr} refs out of `content` into `data` for the
//      *_WARNING / *_ERROR / SHOWWARNINGINFORMATION action types. Variables in
//      `content` are shown LITERALLY by DHIS2; only `data` is evaluated.
//   2. Expand HIDEALLFIELDS sugar into real HIDEFIELDs (per DE in the trigger
//      DE's stage) + HIDEPROGRAMSTAGEs (every other stage). Trigger DE list comes
//      from action.exclude_data_element_ids, falling back to #{var} refs in the
//      rule condition resolved via sanitized DE display name.
//   3. For HIDEALLFIELDS targets that are COMPULSORY in their PSDE: report them
//      via psdesToFlipNonCompulsory so the caller can PUT the stage with
//      compulsory=false. DHIS2 New Tracker Capture refuses to visually hide a
//      compulsory DE — leaving the flag set is exactly what made 5 fields stay
//      visible in the user-reported "5 unhidden" bug.
//   4. To preserve the original "required when shown" semantic, when at least
//      one compulsory PSDE was flipped AND the rule action did NOT pass
//      restore_mandate_when_visible:false, emit a sibling rule with the inverse
//      condition that SETMANDATORYFIELD's each formerly-compulsory DE.
//      Inverse-condition heuristics:
//        Pattern A: !d2:hasValue(#{X}) || #{X} != true   → #{X} == true
//        Pattern B: #{X} == true                          → !d2:hasValue(#{X}) || #{X} != true
//        Otherwise: !( <original> )    (always valid d2)
function applyRuleActionSugar(rules, programStages) {
  const result = { psdesToFlipNonCompulsory: [], siblingMandateRules: [] };

  const TEMPLATE_TYPES = new Set([
    'SHOWWARNING', 'SHOWERROR', 'WARNINGONCOMPLETE', 'ERRORONCOMPLETE', 'SHOWWARNINGINFORMATION',
  ]);
  const VAR_REF_PATTERN = /[#A]\{[^}]+\}/g;
  const splitTemplateContent = (raw) => {
    const matches = [...raw.matchAll(new RegExp(VAR_REF_PATTERN.source, 'g'))];
    if (!matches.length) return null;
    if (matches.length === 1) {
      const ref = matches[0][0];
      const stripped = raw.replace(ref, '').replace(/[\s:\-–—]+$/, '').trimEnd();
      return { content: stripped, data: ref };
    }
    const parts = [];
    let lastIdx = 0;
    let m;
    const re = new RegExp(VAR_REF_PATTERN.source, 'g');
    while ((m = re.exec(raw)) !== null) {
      if (m.index > lastIdx) parts.push(JSON.stringify(raw.substring(lastIdx, m.index)));
      parts.push(m[0]);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < raw.length) parts.push(JSON.stringify(raw.substring(lastIdx)));
    return { content: '', data: `d2:concatenate(${parts.join(', ')})` };
  };

  // 1. Content → data rewrite
  for (const rule of rules) {
    for (const act of (rule.actions || [])) {
      if (!TEMPLATE_TYPES.has(act.type)) continue;
      const c = String(act.content || '');
      if (!new RegExp(VAR_REF_PATTERN.source).test(c)) continue;
      if (String(act.data || '').trim()) continue; // respect explicit data
      const split = splitTemplateContent(c);
      if (split) {
        act.content = split.content;
        act.data = split.data;
        act._auto_rewrote_template = true;
      }
    }
  }

  // 2-4. HIDEALLFIELDS expansion + compulsion handling + inverse mandate rule
  const stages = Array.isArray(programStages) ? programStages : [];
  if (!stages.length) return result;

  // Index PSDEs/DEs across the program. We track psdeId + compulsory so we can
  // flip the flag on stages whose DEs are about to get HIDEFIELD'd.
  const deIdToInfo = new Map(); // deId → { stageId, psdeId, displayName, compulsory }
  const deBySanitizedName = new Map();
  for (const ps of stages) {
    for (const psde of (ps.programStageDataElements || [])) {
      const de = psde.dataElement;
      if (!de?.id) continue;
      deIdToInfo.set(de.id, {
        stageId: ps.id,
        psdeId: psde.id,
        displayName: de.displayName,
        compulsory: !!psde.compulsory,
      });
      if (de.displayName) deBySanitizedName.set(sanitizeVariableName(de.displayName), de.id);
    }
  }
  const allStageIds = stages.map(ps => ps.id).filter(Boolean);

  // Inverse-condition helper — covers the two common boolean shapes plus a generic !(...) fallback.
  const inverseCondition = (cond) => {
    if (!cond) return 'true';
    const s = cond.trim();
    let m;
    if ((m = s.match(/^!d2:hasValue\(#\{(\w+)\}\)\s*\|\|\s*#\{\1\}\s*!=\s*true$/))) {
      return `#{${m[1]}} == true`;
    }
    if ((m = s.match(/^#\{(\w+)\}\s*==\s*true$/))) {
      return `!d2:hasValue(#{${m[1]}}) || #{${m[1]}} != true`;
    }
    return `!(${s})`;
  };

  for (const rule of rules) {
    if (!(rule.actions || []).some(a => a.type === 'HIDEALLFIELDS')) continue;
    const expanded = [];
    const compulsoryHiddenDEs = []; // { deId, deName, stageId, psdeId } across this rule
    let restoreMandate = true; // default true; can be turned off per HIDEALLFIELDS action

    for (const act of (rule.actions || [])) {
      if (act.type !== 'HIDEALLFIELDS') { expanded.push(act); continue; }
      if (act.restore_mandate_when_visible === false) restoreMandate = false;

      const excludeIds = new Set(act.exclude_data_element_ids || []);
      if (excludeIds.size === 0) {
        for (const m of String(rule.condition || '').match(/#\{([^}]+)\}/g) || []) {
          const name = m.slice(2, -1);
          const hit = deBySanitizedName.get(sanitizeVariableName(name));
          if (hit) excludeIds.add(hit);
        }
      }
      const triggerStageIds = new Set();
      for (const id of excludeIds) {
        const info = deIdToInfo.get(id);
        if (info?.stageId) triggerStageIds.add(info.stageId);
      }
      const expandFieldStages = triggerStageIds.size ? triggerStageIds : new Set(allStageIds);
      for (const ps of stages) {
        if (expandFieldStages.has(ps.id)) {
          for (const psde of (ps.programStageDataElements || [])) {
            const deId = psde.dataElement?.id;
            if (!deId || excludeIds.has(deId)) continue;
            expanded.push({ type: 'HIDEFIELD', data_element_id: deId });
            if (psde.compulsory) {
              compulsoryHiddenDEs.push({
                deId,
                deName: psde.dataElement.displayName,
                stageId: ps.id,
                psdeId: psde.id,
              });
            }
          }
        } else {
          expanded.push({ type: 'HIDEPROGRAMSTAGE', program_stage_id: ps.id });
        }
      }
    }
    rule.actions = expanded;

    if (compulsoryHiddenDEs.length) {
      // Schedule each PSDE for compulsory→false (DHIS2 won't hide a compulsory DE).
      for (const c of compulsoryHiddenDEs) result.psdesToFlipNonCompulsory.push(c);

      // Optionally re-mandate them when the trigger condition is FALSE (i.e. shown).
      if (restoreMandate) {
        result.siblingMandateRules.push({
          name: `${rule.name || 'Hide all fields'} — require when visible`,
          description: `Auto-paired with "${rule.name || ''}" to restore mandatory status on ${compulsoryHiddenDEs.length} originally-compulsory data element(s) when the hide condition is false. Created automatically because HIDEFIELD does not visually hide compulsory DEs in DHIS2 New Tracker Capture; the partner rule clears compulsion at metadata level, this rule re-applies it via SETMANDATORYFIELD when fields are shown.`,
          condition: inverseCondition(rule.condition),
          actions: compulsoryHiddenDEs.map(c => ({ type: 'SETMANDATORYFIELD', data_element_id: c.deId })),
          _auto_paired_with: rule.name,
        });
      }
    }
  }

  return result;
}

// Apply the side effects collected by applyRuleActionSugar:
//   - Flip PSDE.compulsory→false on each affected stage via PUT (one PUT per stage).
//   - Append the auto-built sibling SETMANDATORYFIELD rules into the rules list so
//     the caller's existing build pipeline emits them in the same metadata POST.
// Returns { stageUpdates: [{ stage_id, flipped: [{ deId, deName }] }], errors: [...] }.
async function applyRuleActionSugarSideEffects(plan, rules) {
  const result = { stageUpdates: [], errors: [] };
  if (!plan) return result;

  // 1. Group PSDE flips by stage.
  const byStage = new Map();
  for (const f of (plan.psdesToFlipNonCompulsory || [])) {
    if (!byStage.has(f.stageId)) byStage.set(f.stageId, []);
    byStage.get(f.stageId).push(f);
  }
  for (const [stageId, flips] of byStage) {
    const stageResp = await safeDhis2Fetch(`programStages/${stageId}.json?fields=:owner`);
    if (stageResp?._error || !stageResp?.id) {
      result.errors.push({ stage_id: stageId, error: stageResp?._error || 'stage not found' });
      continue;
    }
    const targetPsdeIds = new Set(flips.map(f => f.psdeId));
    let flipped = 0;
    for (const psde of (stageResp.programStageDataElements || [])) {
      if (targetPsdeIds.has(psde.id) && psde.compulsory) {
        psde.compulsory = false;
        flipped++;
      }
    }
    if (!flipped) {
      result.stageUpdates.push({ stage_id: stageId, flipped: [], note: 'No matching compulsory PSDEs (already cleared).' });
      continue;
    }
    const putResp = await safeDhis2Fetch(`programStages/${stageId}`, { method: 'PUT', body: stageResp });
    if (putResp?._error) {
      result.errors.push({ stage_id: stageId, error: `PUT failed: ${putResp._error}` });
      continue;
    }
    result.stageUpdates.push({
      stage_id: stageId,
      flipped: flips.map(f => ({ data_element_id: f.deId, data_element_name: f.deName })),
    });
  }

  // 2. Append sibling mandate rules so they go through the normal build pipeline.
  if ((plan.siblingMandateRules || []).length) {
    rules.push(...plan.siblingMandateRules);
  }

  return result;
}

// Build and post programRuleVariables + programRuleActions + programRules atomically.
// actions must reference their parent rule via programRule:{id} (confirmed working pattern).
//
// Variable-reference contract: DHIS2 silently accepts rules with unresolved #{var}
// references — the rule is created but never fires at runtime. To prevent dead rules,
// this function:
//   1. scans every condition + action.data for #{varName} and A{attrRef}
//   2. matches each #{varName} against existing programRuleVariables, model-supplied
//      rule.variables[], and (as last resort) program data elements by sanitized
//      displayName — auto-creating a PRV when a DE match is found
//   3. rewrites A{name} (non-UID) into A{UID} using the program's TEAs
//   4. refuses the POST with a structured _hint when a reference cannot be resolved
// Resolve rule-action target display names (data_element_name /
// tracked_entity_attribute_name) to UIDs against a program's DEs + TEAs. Mutates
// each action in place, filling data_element_id / tei_attribute_id when only a
// name was supplied. Returns { unresolved:[{name,kind}] } for names that matched
// nothing. Lets the manage_program_rules UPDATE path bind name-targeted actions
// the same way the create path (_buildAndPostProgramRules) already does — without
// it, an ASSIGN/SETMANDATORYFIELD/HIDEFIELD passed by name saved target-less and
// DHIS2 rejected the bundle ("DataElement ... cannot be null").
async function resolveRuleActionTargetNames(pid, actions) {
  const needs = (actions || []).some(a => a && (
    (a.data_element_name && !a.data_element_id) ||
    (a.tracked_entity_attribute_name && !a.tei_attribute_id)));
  if (!needs) return { unresolved: [] };
  const prog = await safeDhis2Fetch(`programs/${pid}?fields=programStages[programStageDataElements[dataElement[id,displayName]]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName]]`);
  if (!prog || prog._error) return { unresolved: [], _fetchError: prog && prog._error };
  const deByName = new Map(), deBySan = new Map();
  for (const ps of (prog.programStages || [])) for (const psde of (ps.programStageDataElements || [])) {
    const de = psde.dataElement; if (!de?.id) continue;
    deByName.set(de.displayName, de.id); deBySan.set(sanitizeVariableName(de.displayName), de.id);
  }
  const teaByName = new Map(), teaBySan = new Map();
  for (const pta of (prog.programTrackedEntityAttributes || [])) {
    const tea = pta.trackedEntityAttribute; if (!tea?.id) continue;
    teaByName.set(tea.displayName, tea.id); teaBySan.set(sanitizeVariableName(tea.displayName), tea.id);
  }
  const unresolved = [];
  for (const a of (actions || [])) {
    if (a.data_element_name && !a.data_element_id) {
      const id = deByName.get(a.data_element_name) || deBySan.get(sanitizeVariableName(a.data_element_name));
      if (id) a.data_element_id = id; else unresolved.push({ name: a.data_element_name, kind: 'dataElement' });
    }
    if (a.tracked_entity_attribute_name && !a.tei_attribute_id) {
      const id = teaByName.get(a.tracked_entity_attribute_name) || teaBySan.get(sanitizeVariableName(a.tracked_entity_attribute_name));
      if (id) a.tei_attribute_id = id; else unresolved.push({ name: a.tracked_entity_attribute_name, kind: 'trackedEntityAttribute' });
    }
  }
  return { unresolved };
}

async function _buildAndPostProgramRules(programId, rules, dryRun) {
  // 1. Lint conditions for known-broken boolean patterns.
  const lintErrors = [];
  for (const rule of rules) {
    const err = lintProgramRuleCondition(rule.condition, rule.name);
    if (err) lintErrors.push(err);
  }
  if (lintErrors.length) {
    return {
      success: false,
      _error: `Program rule condition lint failed (${lintErrors.length}): ${lintErrors.join(' | ')}`,
      phase: 'lint',
      errors: lintErrors,
      _hint: 'Fix the condition(s) using the suggested canonical form, then retry.',
    };
  }

  // 1a. Bare `#{x} < n` fires on EMPTY fields (empty coerces to 0) — wrap with
  // d2:hasValue so warnings/hides don't trigger on a blank form.
  const autoGuardedConditions = [];
  for (const rule of rules) {
    const g = autoGuardNumericComparisons(rule.condition);
    if (g.guarded.length) {
      rule.condition = g.condition;
      autoGuardedConditions.push({ rule: rule.name, guarded_variables: g.guarded });
    }
  }

  // 2. Load program so we can resolve variable references and pick smart defaults.
  // PSDE id+compulsory included so HIDEALLFIELDS sugar can flip compulsory→false on
  // hidden DEs (DHIS2 New Tracker Capture refuses to visually hide a compulsory DE).
  const progResp = await safeDhis2Fetch(
    `programs/${programId}?fields=id,programStages[id,displayName,programStageDataElements[id,compulsory,dataElement[id,displayName,valueType,optionSet[id]]]],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName,valueType,optionSet[id]]],programRuleVariables[id,name,programRuleVariableSourceType,valueType,useCodeForOptionSet,dataElement[id,displayName],trackedEntityAttribute[id,displayName],programStage[id]]`
  );
  if (progResp._error) {
    return { success: false, _error: `Could not load program ${programId}: ${progResp._error}`, phase: 'preflight' };
  }

  // 1b. Visibility-semantics lint against the batch AND the program's existing
  // rules (show/hide twins, hide+mandate contradictions, inverted "Show X"
  // rules). A failed existing-rules read degrades to batch-only linting.
  {
    const existingRulesResp = await safeDhis2Fetch(
      `programRules?filter=program.id:eq:${programId}&fields=id,name,condition,programRuleActions%5BprogramRuleActionType,dataElement%5Bid,displayName%5D,trackedEntityAttribute%5Bid,displayName%5D,programStage%5Bid,displayName%5D,programStageSection%5Bid,displayName%5D%5D&pageSize=100`
    );
    const semanticErrors = lintRuleVisibilitySemantics(
      rules,
      existingRulesResp._error ? [] : (existingRulesResp.programRules || [])
    );
    if (semanticErrors.length) {
      return {
        success: false,
        _error: `Program rule semantics lint failed (${semanticErrors.length}): ${semanticErrors.join(' | ')}`,
        phase: 'lint',
        errors: semanticErrors,
        _hint: 'Rewrite as ONE hide rule per target (condition = the HIDE case); mandatory-when-visible goes in a separate SETMANDATORYFIELD-only rule with the positive condition. Then retry. Do not work around this by re-wording rule names.',
      };
    }
  }

  // 2a/2b. Apply the shared rule-action sugar: auto-move #{var}/A{attr} from
  //         SHOWWARNING/SHOWERROR/etc content → data, and expand HIDEALLFIELDS into
  //         HIDEFIELD-per-DE (trigger stage) + HIDEPROGRAMSTAGE (other stages).
  // Side effects (executed before rule POST): PSDE compulsory→false PUTs +
  // sibling SETMANDATORYFIELD rule appended to `rules` so the PSDE-flipped DEs
  // remain required when the trigger condition is FALSE (i.e. when shown).
  const sugarPlan = applyRuleActionSugar(rules, progResp.programStages || []);
  const sugarSideEffects = await applyRuleActionSugarSideEffects(sugarPlan, rules);

  // Index existing PRVs by name (case-insensitive for tolerance).
  const existingPRVs = new Map();  // lowercased name → PRV
  for (const prv of (progResp.programRuleVariables || [])) {
    existingPRVs.set(String(prv.name || '').toLowerCase(), prv);
  }

  // Index program DEs by sanitized display name AND by which stage(s) they live in.
  const deBySanitized = new Map();  // sanitized(displayName) → { id, displayName, valueType, optionSet, stageIds:[] }
  const deByDisplayName = new Map(); // raw displayName → same
  const deById = new Map();          // deId → same entry (for ASSIGN option-code checks)
  for (const ps of (progResp.programStages || [])) {
    for (const psde of (ps.programStageDataElements || [])) {
      const de = psde.dataElement;
      if (!de?.id) continue;
      const sKey = sanitizeVariableName(de.displayName);
      let entry = deBySanitized.get(sKey);
      if (!entry) {
        entry = { id: de.id, displayName: de.displayName, valueType: de.valueType, optionSet: de.optionSet, stageIds: [] };
        deBySanitized.set(sKey, entry);
        deByDisplayName.set(de.displayName, entry);
      }
      deById.set(de.id, entry);
      if (!entry.stageIds.includes(ps.id)) entry.stageIds.push(ps.id);
    }
  }

  // Index TEAs by sanitized display name and by UID for A{} rewriting.
  const teaBySanitized = new Map();
  const teaByDisplayName = new Map(); // raw displayName → entry (for action target resolution)
  const teaById = new Map();
  for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
    const tea = ptea.trackedEntityAttribute;
    if (!tea?.id) continue;
    const entry = { id: tea.id, displayName: tea.displayName, valueType: tea.valueType, optionSet: tea.optionSet };
    teaBySanitized.set(sanitizeVariableName(tea.displayName), entry);
    teaByDisplayName.set(tea.displayName, entry);
    teaById.set(tea.id, entry);
  }

  const isDhis2Uid = (s) => /^[a-zA-Z][a-zA-Z0-9]{10}$/.test(s);

  // Stage references in actions may arrive as a stage NAME — resolve name → id.
  const stageNameToId = new Map();
  const validStageIdSet = new Set();
  for (const ps of (progResp.programStages || [])) {
    validStageIdSet.add(ps.id);
    if (ps.displayName) stageNameToId.set(String(ps.displayName).trim().toLowerCase(), ps.id);
  }
  const resolveStageRefForAction = (act) => {
    const ref = act.program_stage_name || act.program_stage_id;
    if (!ref) return null;
    if (validStageIdSet.has(ref)) return ref;
    const byName = stageNameToId.get(String(ref).trim().toLowerCase());
    if (byName) return byName;
    if (isDhis2Uid(String(ref))) return ref; // plausible UID from elsewhere — let the server validate
    return undefined;
  };

  // Resolve a rule action's TARGET (the DE/TEA the action acts on) from either an
  // explicit UID (data_element_id / tei_attribute_id) OR a display name
  // (data_element_name / tracked_entity_attribute_name). The schema advertises the
  // *_name fields as "resolved to ID automatically" and the create_metadata rule
  // path already resolves them (via deUidMap) — this makes manage_program_rules
  // behave identically, so ASSIGN / SETMANDATORYFIELD / HIDEFIELD written by name
  // actually bind instead of bouncing with "DataElement ... cannot be null".
  const resolveActionDeEntry = (act) => {
    if (!act) return null;
    if (act.data_element_id) return deById.get(act.data_element_id) || { id: act.data_element_id };
    const nm = act.data_element_name;
    if (!nm) return null;
    return deByDisplayName.get(nm)
      || deBySanitized.get(String(nm).toLowerCase())
      || deBySanitized.get(sanitizeVariableName(nm))
      || null;
  };
  const resolveActionTeaEntry = (act) => {
    if (!act) return null;
    if (act.tei_attribute_id) return teaById.get(act.tei_attribute_id) || { id: act.tei_attribute_id };
    const nm = act.tracked_entity_attribute_name;
    if (!nm) return null;
    return teaByDisplayName.get(nm)
      || teaBySanitized.get(String(nm).toLowerCase())
      || teaBySanitized.get(sanitizeVariableName(nm))
      || null;
  };

  // 3. Build payload while resolving references per-rule.
  const allPRVs = [];
  const allPRAs = [];
  const allPRs  = [];
  const newPRVsByName = new Map();  // lowercased name → PRV (tracks PRVs we're creating in this batch)
  const unresolved = []; // { rule, ref, suggestions }
  const autoCreated = []; // for summary

  // Pick a smart sourceType: if the DE lives in a stage that this rule's actions also target,
  // CURRENT_EVENT is the right default (in-form visibility). Otherwise fall back to
  // NEWEST_EVENT_PROGRAM (cross-event lookups).
  const pickSourceType = (deEntry, rule) => {
    const actionStageIds = new Set();
    for (const act of (rule.actions || [])) {
      // Resolve the action target by id OR name so name-targeted actions still
      // steer the PRV toward CURRENT_EVENT when they act on the trigger's stage.
      const tgt = resolveActionDeEntry(act);
      if (tgt && Array.isArray(tgt.stageIds)) {
        for (const sid of tgt.stageIds) actionStageIds.add(sid);
      }
      const actStageId = resolveStageRefForAction(act);
      if (actStageId) actionStageIds.add(actStageId);
    }
    for (const sid of deEntry.stageIds) {
      if (actionStageIds.has(sid)) return { sourceType: 'DATAELEMENT_CURRENT_EVENT', stageId: null };
    }
    return { sourceType: 'DATAELEMENT_NEWEST_EVENT_PROGRAM', stageId: null };
  };

  const buildPRVFromDE = (varName, deEntry, rule) => {
    const { sourceType } = pickSourceType(deEntry, rule);
    const prvUid = generateDhis2Uid();
    const prv = {
      id: prvUid,
      name: varName,
      program: { id: programId },
      programRuleVariableSourceType: sourceType,
      valueType: deEntry.valueType || 'TEXT',
      useCodeForOptionSet: !!deEntry.optionSet,
      dataElement: { id: deEntry.id },
    };
    return prv;
  };

  const buildPRVFromTEA = (varName, teaEntry) => {
    const prvUid = generateDhis2Uid();
    return {
      id: prvUid,
      name: varName,
      program: { id: programId },
      programRuleVariableSourceType: 'TEI_ATTRIBUTE',
      valueType: teaEntry.valueType || 'TEXT',
      useCodeForOptionSet: !!teaEntry.optionSet,
      trackedEntityAttribute: { id: teaEntry.id },
    };
  };

  // Ensure a PRV exists for `name`. Returns true if resolved (existing, model-supplied,
  // or auto-created); false if no match could be found — also pushes to `unresolved`.
  const ensureVarForRule = (name, rule) => {
    const key = name.toLowerCase();
    if (existingPRVs.has(key)) return true;
    if (newPRVsByName.has(key)) return true;

    // Model supplied it explicitly — build from the provided def.
    const modelVar = (rule.variables || []).find(v => String(v.name || '').toLowerCase() === key);
    if (modelVar) {
      const prvUid = generateDhis2Uid();
      const prv = {
        id: prvUid,
        name: modelVar.name,
        program: { id: programId },
        programRuleVariableSourceType: modelVar.source_type || 'DATAELEMENT_NEWEST_EVENT_PROGRAM',
        valueType: modelVar.value_type || 'TEXT',
        useCodeForOptionSet: modelVar.use_code_for_option_set || false,
      };
      if (modelVar.data_element_id) prv.dataElement = { id: modelVar.data_element_id };
      if (modelVar.tei_attribute_id) prv.trackedEntityAttribute = { id: modelVar.tei_attribute_id };
      if (modelVar.program_stage_id) prv.programStage = { id: modelVar.program_stage_id };
      allPRVs.push(prv);
      newPRVsByName.set(key, prv);
      return true;
    }

    // Auto-resolve via DE display name (sanitized).
    const deEntry = deBySanitized.get(key) || deBySanitized.get(sanitizeVariableName(name));
    if (deEntry) {
      const prv = buildPRVFromDE(name, deEntry, rule);
      allPRVs.push(prv);
      newPRVsByName.set(key, prv);
      autoCreated.push({ name, source: 'dataElement', data_element_id: deEntry.id, data_element_name: deEntry.displayName, source_type: prv.programRuleVariableSourceType, valueType: prv.valueType });
      return true;
    }

    // Auto-resolve via TEA display name (sanitized).
    const teaEntry = teaBySanitized.get(key) || teaBySanitized.get(sanitizeVariableName(name));
    if (teaEntry) {
      const prv = buildPRVFromTEA(name, teaEntry);
      allPRVs.push(prv);
      newPRVsByName.set(key, prv);
      autoCreated.push({ name, source: 'trackedEntityAttribute', tei_attribute_id: teaEntry.id, source_type: 'TEI_ATTRIBUTE', valueType: prv.valueType });
      return true;
    }

    return false;
  };

  const collectSuggestions = (name) => {
    const nLower = name.toLowerCase();
    const suggestions = [];
    for (const [_, e] of deBySanitized) {
      if (e.displayName && (e.displayName.toLowerCase().includes(nLower) || nLower.includes(sanitizeVariableName(e.displayName)))) {
        suggestions.push({ kind: 'dataElement', id: e.id, displayName: e.displayName });
      }
    }
    for (const [_, e] of teaBySanitized) {
      if (e.displayName && (e.displayName.toLowerCase().includes(nLower) || nLower.includes(sanitizeVariableName(e.displayName)))) {
        suggestions.push({ kind: 'trackedEntityAttribute', id: e.id, displayName: e.displayName });
      }
    }
    return suggestions.slice(0, 6);
  };

  for (const rule of rules) {
    const prUid = generateDhis2Uid();
    let condition = rule.condition || 'true';

    // Extract #{var} references from condition AND any action.data expressions.
    const scanStrings = [condition, ...(rule.actions || []).map(a => a.data || '').filter(Boolean)];
    const varRefs = new Set();
    const attrRefs = new Set();
    for (const s of scanStrings) {
      for (const m of (s.match(/#\{([^}]+)\}/g) || [])) varRefs.add(m.slice(2, -1));
      for (const m of (s.match(/A\{([^}]+)\}/g) || [])) attrRefs.add(m.slice(2, -1));
    }

    for (const name of varRefs) {
      const ok = ensureVarForRule(name, rule);
      if (!ok) unresolved.push({ rule: rule.name, reference: `#{${name}}`, suggestions: collectSuggestions(name) });
    }

    // A{ref}: DHIS2's grammar accepts BOTH a TEA UID and the NAME of a
    // TEI_ATTRIBUTE-sourced programRuleVariable (the demo DB's own rules use
    // e.g. d2:yearsBetween(A{born}, V{current_date}) where "born" is a PRV).
    // Resolution order:
    //   1. UID → pass through.
    //   2. Existing PRV with that name, or a variables:[] entry the model
    //      supplied in THIS rule (source_type TEI_ATTRIBUTE) → keep A{name},
    //      creating the PRV if it came from variables:[]. (Previously this
    //      path was missing: the tool's own error hint told the model to pass
    //      variables:[], then ignored them for A{} refs and refused the POST.)
    //   3. TEA displayName match → rewrite to A{uid}.
    //   4. Otherwise unresolved.
    for (const ref of attrRefs) {
      if (isDhis2Uid(ref) && teaById.has(ref)) continue;
      if (isDhis2Uid(ref)) continue;  // Leave unknown UIDs alone — DHIS2 will resolve at runtime.
      if (existingPRVs.has(ref.toLowerCase()) || newPRVsByName.has(ref.toLowerCase())) continue;
      const suppliedVar = (rule.variables || []).find(v =>
        String(v.name || '').toLowerCase() === ref.toLowerCase()
        && (v.source_type === 'TEI_ATTRIBUTE' || v.tei_attribute_id));
      if (suppliedVar && ensureVarForRule(ref, rule)) continue;
      const teaEntry = teaBySanitized.get(ref.toLowerCase()) || teaBySanitized.get(sanitizeVariableName(ref));
      if (teaEntry) {
        const before = `A{${ref}}`;
        const after  = `A{${teaEntry.id}}`;
        condition = condition.split(before).join(after);
        for (const act of (rule.actions || [])) {
          if (act.data) act.data = act.data.split(before).join(after);
        }
      } else {
        unresolved.push({ rule: rule.name, reference: `A{${ref}}`, suggestions: collectSuggestions(ref) });
      }
    }

    // Build this rule's actions (regardless of unresolved refs — we'll abort below if any).
    const actionRefs = [];
    for (const act of (rule.actions || [])) {
      const praUid = generateDhis2Uid();
      actionRefs.push({ id: praUid });
      const pra = {
        id: praUid,
        programRule: { id: prUid },
        programRuleActionType: act.type,
        evaluationTime: act.evaluation_time || 'ON_DATA_ENTRY',
      };
      if (act.content) pra.content = act.content;
      if (act.data) pra.data = act.data;
      // Resolve the action's target DE/TEA by id OR by display name. Previously
      // only *_id was honored, so a name-targeted ASSIGN/SETMANDATORYFIELD/HIDEFIELD
      // saved with no target and DHIS2 rejected the whole bundle at validation.
      const deTgt = resolveActionDeEntry(act);
      const teaTgt = deTgt ? null : resolveActionTeaEntry(act);
      if (deTgt && deTgt.id) pra.dataElement = { id: deTgt.id };
      else if (teaTgt && teaTgt.id) pra.trackedEntityAttribute = { id: teaTgt.id };
      // A name was supplied but did not resolve → surface it (fail loudly with
      // suggestions) rather than posting a target-less action that bounces server-side.
      if (!pra.dataElement && !pra.trackedEntityAttribute) {
        if (act.data_element_name) {
          unresolved.push({ rule: rule.name, reference: `action target data_element_name="${act.data_element_name}"`, suggestions: collectSuggestions(act.data_element_name) });
        } else if (act.tracked_entity_attribute_name) {
          unresolved.push({ rule: rule.name, reference: `action target tracked_entity_attribute_name="${act.tracked_entity_attribute_name}"`, suggestions: collectSuggestions(act.tracked_entity_attribute_name) });
        }
      }
      const stageId = resolveStageRefForAction(act);
      if (stageId) pra.programStage = { id: stageId };
      if (act.program_stage_section_id) pra.programStageSection = { id: act.program_stage_section_id };
      // Stage-targeting actions without a resolvable stage bounce server-side
      // with "ProgramStage cannot be null" — surface via the unresolved flow.
      if ((act.type === 'HIDEPROGRAMSTAGE' || act.type === 'CREATEEVENT') && !pra.programStage) {
        unresolved.push({
          rule: rule.name,
          reference: `${act.type} target stage "${act.program_stage_name || act.program_stage_id || '(none given)'}"`,
          suggestions: (progResp.programStages || []).map(ps => ({ kind: 'programStage', id: ps.id, displayName: ps.displayName })),
        });
      }
      allPRAs.push(pra);
    }

    const pr = {
      id: prUid,
      name: rule.name,
      program: { id: programId },
      condition,
      programRuleActions: actionRefs,
    };
    if (rule.description) pr.description = rule.description;
    if (rule.priority !== undefined) pr.priority = rule.priority;
    allPRs.push(pr);
  }

  // 4. Abort if any reference could not be resolved — surface a structured hint so
  //    the model can self-correct in the next agentic iteration.
  if (unresolved.length) {
    return {
      success: false,
      _error: `Program rule references cannot be resolved: ${unresolved.map(u => u.reference).join(', ')}`,
      phase: 'variable_resolution',
      unresolved,
      _hint: `Every #{name} must resolve to a programRuleVariable. Either (a) pass variables:[{name, source_type:"DATAELEMENT_CURRENT_EVENT"|"DATAELEMENT_NEWEST_EVENT_PROGRAM"|"TEI_ATTRIBUTE", value_type, data_element_id|tei_attribute_id}] inside the rule, (b) rename the reference to match an existing data element's sanitized display name (lowercase, non-alphanumerics → "_") so it can auto-resolve, or (c) first call manage_program_rules(action=list_variables, program_id=...) to see what variables already exist. A{name} references must use a tracked-entity-attribute UID or a displayName that matches a TEA on the program.`,
    };
  }

  // ── ASSIGN → option-set DE: the assigned literal MUST be an option CODE ──
  // The server-side rule engine (2.42+ runs ASSIGN on tracker import) and the
  // tracker importer validate assigned values against the option set's CODES,
  // not names. A rule assigning 'Moderate' to a DE whose option codes are
  // MILD/MODERATE/SEVERE bounces every event save with E1125. Verified live on
  // play 2.42.5.1 (2026-07-01). Auto-map a name → its code; reject unknowns
  // with the valid code list so the model can self-correct in one iteration.
  {
    const assignsByOptionSet = new Map(); // optionSetId → [pra]
    for (const pra of allPRAs) {
      if (pra.programRuleActionType !== 'ASSIGN' || !pra.dataElement?.id) continue;
      const deEntry = deById.get(pra.dataElement.id);
      const osId = deEntry?.optionSet?.id;
      if (!osId) continue;
      const literal = typeof pra.data === 'string' && pra.data.trim().match(/^'([^']*)'$|^"([^"]*)"$/);
      if (!literal) continue; // dynamic expression — can't statically check
      if (!assignsByOptionSet.has(osId)) assignsByOptionSet.set(osId, []);
      assignsByOptionSet.get(osId).push(pra);
    }
    if (assignsByOptionSet.size) {
      const optionSetIds = [...assignsByOptionSet.keys()];
      const optResps = await Promise.all(optionSetIds.map(id =>
        safeDhis2Fetch(`optionSets/${id}?fields=id,name,options[name,code]`)));
      const codeErrors = [];
      for (let i = 0; i < optionSetIds.length; i++) {
        const os = optResps[i];
        if (!os || os._error) continue; // can't verify — let the server decide
        const byCode = new Map((os.options || []).map(o => [String(o.code), o]));
        const byName = new Map((os.options || []).map(o => [String(o.name).toLowerCase(), o]));
        for (const pra of assignsByOptionSet.get(optionSetIds[i])) {
          const raw = pra.data.trim();
          const value = raw.slice(1, -1);
          if (byCode.has(value)) continue;
          const named = byName.get(value.toLowerCase());
          if (named) {
            pra.data = `'${named.code}'`; // auto-map display name → code
          } else {
            codeErrors.push(`ASSIGN to "${deById.get(pra.dataElement.id)?.displayName}" uses '${value}', which is neither an option code nor an option name of option set "${os.name}". Valid codes: ${(os.options || []).map(o => o.code).join(', ')}`);
          }
        }
      }
      if (codeErrors.length) {
        return {
          success: false,
          _error: `ASSIGN value(s) do not match the target data element's option set: ${codeErrors.join(' | ')}`,
          phase: 'assign_option_code_check',
          _hint: 'ASSIGN writes the raw value into the field; for an option-set data element the value must be an option CODE (names are auto-mapped when they match). Fix the data expression to one of the listed codes and retry.',
        };
      }
    }
  }

  // ── Option-set CONDITION literals: rewrite option NAMES → CODES ──
  // Auto-created option-set PRVs use useCodeForOptionSet=true, so the value the
  // rule engine compares is the option CODE (this matches the DHIS2 demo DB
  // convention, e.g. #{CaseClassifiedAs} != 'IMPORTED'). A condition that compares
  // such a variable to an option NAME (…== 'Positive') lints clean, SAVES, and then
  // NEVER FIRES — a silent failure. We already map ASSIGN data names→codes; do the
  // same for conditions. This only ever rewrites a NAME literal to its CODE — it
  // never touches '' (empty checks) or literals that are already valid codes, so it
  // cannot break a condition that was already correct (it can only fix a broken one).
  let conditionOptionAdvisories = [];
  {
    // varName(lower) → { optionSetId, useCode } for every option-set-backed PRV
    // in scope (freshly built for this batch + already existing on the program).
    const varOptionInfo = new Map();
    const noteVar = (name, useCode, deId, teaId) => {
      if (!name) return;
      let osId = null;
      if (deId) osId = deById.get(deId)?.optionSet?.id || null;
      else if (teaId) osId = teaById.get(teaId)?.optionSet?.id || null;
      if (osId) varOptionInfo.set(String(name).toLowerCase(), { optionSetId: osId, useCode: useCode !== false });
    };
    for (const prv of allPRVs) noteVar(prv.name, prv.useCodeForOptionSet, prv.dataElement?.id, prv.trackedEntityAttribute?.id);
    for (const [, prv] of existingPRVs) noteVar(prv.name, prv.useCodeForOptionSet, prv.dataElement?.id, prv.trackedEntityAttribute?.id);

    // Which option sets do the conditions actually reference (option vars w/ useCode)?
    const neededOsIds = new Set();
    for (const pr of allPRs) {
      for (const m of (pr.condition.match(/#\{([^}]+)\}/g) || [])) {
        const info = varOptionInfo.get(m.slice(2, -1).toLowerCase());
        if (info && info.useCode) neededOsIds.add(info.optionSetId);
      }
    }
    if (neededOsIds.size) {
      const osIds = [...neededOsIds];
      const resps = await Promise.all(osIds.map(id => safeDhis2Fetch(`optionSets/${id}?fields=id,name,options[name,code]`)));
      const osMap = new Map(); // osId → { byCode:Set, byName:Map(lower→code), name, options }
      for (let i = 0; i < osIds.length; i++) {
        const o = resps[i];
        if (!o || o._error) continue;
        osMap.set(osIds[i], {
          byCode: new Set((o.options || []).map(x => String(x.code))),
          byName: new Map((o.options || []).map(x => [String(x.name).toLowerCase(), String(x.code)])),
          name: o.name,
          options: o.options || [],
        });
      }
      for (const pr of allPRs) {
        let cond = pr.condition;
        const usedVars = new Set((cond.match(/#\{([^}]+)\}/g) || []).map(m => m.slice(2, -1)));
        for (const vRaw of usedVars) {
          const info = varOptionInfo.get(vRaw.toLowerCase());
          if (!info || !info.useCode) continue;
          const os = osMap.get(info.optionSetId);
          if (!os) continue;
          const varToken = `#{${vRaw}}`;
          const esc = vRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // `#{var} ==|!= 'literal'` in either order.
          const re = new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'([^']*)'|'([^']*)'\\s*(==|!=)\\s*#\\{${esc}\\}`, 'g');
          cond = cond.replace(re, (full, op1, lit1, lit2, op2) => {
            const lit = (lit1 !== undefined ? lit1 : lit2);
            const op = op1 || op2;
            if (lit === '') return full;         // empty-value check — leave alone
            if (os.byCode.has(lit)) return full; // already a code — leave alone
            const code = os.byName.get(lit.toLowerCase());
            if (code) return op1 ? `${varToken} ${op} '${code}'` : `'${code}' ${op} ${varToken}`;
            // Neither a code nor a name of this option set → advise (don't rewrite).
            conditionOptionAdvisories.push(`Rule "${pr.name}": #{${vRaw}} is compared to '${lit}', which is neither a code nor a name of option set "${os.name}" (codes: ${os.options.map(x => x.code).join(', ')}). This comparison will never match — verify the value.`);
            return full;
          });
        }
        pr.condition = cond;
      }
    }
  }

  const payload = {};
  if (allPRVs.length) payload.programRuleVariables = allPRVs;
  if (allPRAs.length) payload.programRuleActions = allPRAs;
  payload.programRules = allPRs;

  const result = await postMetadataPayload(payload, dryRun);
  return {
    ...result,
    summary: {
      programRules: allPRs.map(r => ({ id: r.id, name: r.name })),
      programRuleVariables: allPRVs.map(v => ({ id: v.id, name: v.name, sourceType: v.programRuleVariableSourceType, dataElement: v.dataElement?.id, trackedEntityAttribute: v.trackedEntityAttribute?.id })),
      programRuleActions: allPRAs.map(a => ({ id: a.id, type: a.programRuleActionType })),
      auto_created_variables: autoCreated,
      reused_existing_variables: Array.from(varRefsCovered(allPRs, existingPRVs)),
      ...(sugarSideEffects.stageUpdates.length ? { compulsory_flags_cleared: sugarSideEffects.stageUpdates } : {}),
      ...(sugarSideEffects.errors.length ? { compulsory_flag_errors: sugarSideEffects.errors } : {}),
      ...(sugarPlan.siblingMandateRules.length ? { auto_paired_mandate_rules: sugarPlan.siblingMandateRules.map(r => r.name) } : {}),
      ...(conditionOptionAdvisories.length ? { condition_option_advisories: conditionOptionAdvisories } : {}),
      ...(autoGuardedConditions.length ? { auto_guarded_conditions: autoGuardedConditions } : {}),
    },
  };
}

// Enumerate variable names that the posted rules reference AND that already existed
// (i.e. were not auto-created). Purely for the summary — helps the model + user see
// which PRVs were reused vs freshly created.
function varRefsCovered(rules, existingPRVs) {
  const out = new Set();
  for (const r of rules) {
    const s = r.condition || '';
    for (const m of (s.match(/#\{([^}]+)\}/g) || [])) {
      const n = m.slice(2, -1).toLowerCase();
      if (existingPRVs.has(n)) out.add(m.slice(2, -1));
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// manage_program_indicators — Full CRUD for program indicators
// ────────────────────────────────────────────────────────────────────────────

// Validate a program indicator expression/filter via DHIS2's server-side description endpoint.
// The endpoint accepts a raw text body (Content-Type: text/plain) and returns { status, description, message }.
async function validateProgramIndicatorExpression(kind, text, programId) {
  if (!dhis2.baseUrl || !dhis2.apiVersion) {
    const ok = await ensureConnected();
    if (!ok) return { _error: 'Not connected to DHIS2' };
  }
  const endpoint = kind === 'filter' ? 'filter/description' : 'expression/description';
  const url = `${dhis2.baseUrl}/api/${dhis2.apiVersion}/programIndicators/${endpoint}?programId=${encodeURIComponent(programId)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: text || '',
    });
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      // Some DHIS2 versions return 409/400 with JSON { message }; surface that as the error.
      try {
        const parsed = JSON.parse(bodyText);
        return { _error: parsed.message || parsed.description || `HTTP ${resp.status}`, _status: resp.status };
      } catch {
        return { _error: `HTTP ${resp.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`, _status: resp.status };
      }
    }
    try { return JSON.parse(bodyText); } catch { return { status: 'OK', description: bodyText }; }
  } catch (e) {
    return { _error: `Validation fetch failed: ${e.message}` };
  }
}

async function executeManageProgramIndicators(args, ctxProgramId) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  const programId = args.program_id || ctxProgramId;

  // ── discover (cross-program, no program_id required) ──
  // Ranks program indicators by expression complexity and/or per-program event volume.
  // One metadata pass (paginated) + parallel analytics counts per distinct program.
  if (action === 'discover') {
    const sortBy = ['complexity', 'data_volume', 'combined'].includes(args.sort_by) ? args.sort_by : 'combined';
    const topN = Math.max(1, Math.min(100, parseInt(args.top_n) || 20));
    const period = (args.period && String(args.period).trim()) || 'LAST_5_YEARS';
    const includeCounts = args.include_event_counts !== false;
    const nameFilter = (args.name_filter || '').trim();
    const programsFilter = Array.isArray(args.programs) ? args.programs.filter(Boolean) : [];

    // Step 1 — fetch all program indicators with pagination
    const PAGE_SIZE = 200;
    const fields = 'id,displayName,shortName,program[id,displayName],expression,filter,analyticsType,aggregationType';
    const buildUrl = (page) => {
      const parts = [
        `fields=${encodeURIComponent(fields)}`,
        `pageSize=${PAGE_SIZE}`,
        `page=${page}`,
        'totalPages=true',
        'order=displayName:asc',
      ];
      if (nameFilter) parts.push(`filter=${encodeURIComponent(`displayName:ilike:${nameFilter}`)}`);
      if (programsFilter.length) parts.push(`filter=${encodeURIComponent(`program.id:in:[${programsFilter.join(',')}]`)}`);
      return `programIndicators?${parts.join('&')}`;
    };

    const first = await safeDhis2Fetch(buildUrl(1), { noTruncate: true });
    if (first?._error) return first;
    const allPIs = Array.isArray(first.programIndicators) ? [...first.programIndicators] : [];
    const totalCount = first.pager?.total ?? allPIs.length;
    const pageCount = first.pager?.pageCount ?? 1;
    const PAGE_CAP = 50; // safety cap: 10,000 indicators
    const fetchErrors = [];
    if (pageCount > 1) {
      const pagePromises = [];
      for (let p = 2; p <= Math.min(pageCount, PAGE_CAP); p++) {
        pagePromises.push(safeDhis2Fetch(buildUrl(p), { noTruncate: true }).then(r => ({ p, r })));
      }
      const results = await Promise.all(pagePromises);
      for (const { p, r } of results) {
        if (r?._error) { fetchErrors.push({ page: p, error: r._error }); continue; }
        if (Array.isArray(r.programIndicators)) allPIs.push(...r.programIndicators);
      }
    }

    if (allPIs.length === 0) {
      return {
        _note: `No program indicators found${nameFilter ? ` matching name_filter="${nameFilter}"` : ''}${programsFilter.length ? ` in programs [${programsFilter.join(',')}]` : ''}.`,
        total_indicators_scanned: 0,
      };
    }

    // Step 2 — compute complexity per indicator
    const scorePI = (pi) => {
      const expr = pi.expression || '';
      const filt = pi.filter || '';
      const combined = `${expr} ${filt}`;
      const hashRefs = (combined.match(/#\{[^}]+\}/g) || []).length;
      const attrRefs = (combined.match(/A\{[^}]+\}/g) || []).length;
      const varRefs = (combined.match(/V\{[^}]+\}/g) || []).length;
      const d2Funcs = (combined.match(/d2:\w+/g) || []).length;
      const operators = (combined.match(/==|!=|<=|>=|&&|\|\||[+\-*/<>]/g) || []).length;
      const condBlocks = (combined.match(/\bcase\b|\bif\b|\?.*:/g) || []).length;
      const length = combined.length;
      const score =
        hashRefs * 2 +
        attrRefs * 2 +
        varRefs * 1 +
        d2Funcs * 3 +
        operators * 1 +
        condBlocks * 2 +
        Math.floor(length / 40);
      return {
        score,
        breakdown: { hash_refs: hashRefs, attr_refs: attrRefs, var_refs: varRefs, d2_funcs: d2Funcs, operators, cond_blocks: condBlocks, length },
      };
    };
    const scored = allPIs.map(pi => ({ pi, complexity: scorePI(pi) }));

    // Step 3 — per-program event counts via /analytics/events/query (totalPages trick, pageSize=1)
    //   Uses USER_ORGUNIT so the count respects the user's org-unit scope. Parallel across programs.
    const distinctProgramIds = Array.from(new Set(scored.map(s => s.pi.program?.id).filter(Boolean)));
    const eventCounts = new Map(); // programId -> number (or null on failure)
    const countErrors = [];
    if (includeCounts && distinctProgramIds.length) {
      const CONCURRENCY = 5;
      const queue = [...distinctProgramIds];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const pid = queue.shift();
          if (!pid) break;
          const path = `analytics/events/query/${pid}?dimension=pe:${encodeURIComponent(period)}&dimension=ou:USER_ORGUNIT&pageSize=1&totalPages=true&outputType=EVENT`;
          const r = await safeDhis2Fetch(path);
          if (r?._error) {
            eventCounts.set(pid, null);
            countErrors.push({ program_id: pid, error: r._error });
            continue;
          }
          const total = r?.metaData?.pager?.total;
          eventCounts.set(pid, Number.isFinite(total) ? total : (parseInt(total, 10) || 0));
        }
      });
      await Promise.all(workers);
    }

    // Step 4 — rank by chosen axis
    const ranked = scored.map(({ pi, complexity }) => {
      const progId = pi.program?.id;
      const events = includeCounts ? eventCounts.get(progId) : null;
      const dataVolume = Number.isFinite(events) ? events : 0;
      let combined;
      if (!includeCounts) {
        combined = complexity.score;
      } else {
        combined = complexity.score * Math.log10(dataVolume + 10);
      }
      return {
        indicator_id: pi.id,
        name: pi.displayName || pi.shortName || pi.id,
        program: { id: progId, name: pi.program?.displayName || progId },
        analytics_type: pi.analyticsType,
        aggregation_type: pi.aggregationType,
        complexity_score: complexity.score,
        complexity_breakdown: complexity.breakdown,
        program_event_count: dataVolume,
        combined_score: Math.round(combined * 100) / 100,
        expression: pi.expression,
        filter: pi.filter || null,
      };
    });
    const sortKey = sortBy === 'complexity' ? 'complexity_score'
      : sortBy === 'data_volume' ? 'program_event_count'
      : 'combined_score';
    ranked.sort((a, b) => (b[sortKey] - a[sortKey]));
    const top = ranked.slice(0, topN);

    return {
      action: 'discover',
      sort_by: sortBy,
      period_used_for_counts: includeCounts ? period : null,
      total_indicators_scanned: allPIs.length,
      total_indicators_in_instance: totalCount,
      distinct_programs_scanned: distinctProgramIds.length,
      pagination_complete: allPIs.length >= totalCount && fetchErrors.length === 0,
      pagination_errors: fetchErrors.length ? fetchErrors : undefined,
      event_count_errors: countErrors.length ? countErrors : undefined,
      top_indicators: top,
      _note: `Top ${top.length} of ${allPIs.length} indicators ranked by ${sortKey}. Complexity = hash_refs×2 + attr_refs×2 + var_refs + d2_funcs×3 + operators + cond_blocks×2 + length÷40. ${includeCounts ? `Event counts over ${period} at USER_ORGUNIT via analytics/events/query totalPages.` : 'Pass include_event_counts=true to rank by data volume as well.'}`,
    };
  }

  // ── rank_ou (cross-program, OU-breakdown) ──
  // For "which OUs/districts/regions/facilities have the most data for these indicators".
  // Takes indicator_ids (preferred, reused from a prior discover call) or an explicit programs list,
  // runs one analytics/events/aggregate per distinct program at the requested OU level, sums per OU.
  if (action === 'rank_ou') {
    const level = Math.max(1, Math.min(6, parseInt(args.level) || 2));
    const period = (args.period && String(args.period).trim()) || 'LAST_5_YEARS';
    const topN = Math.max(1, Math.min(100, parseInt(args.top_n) || 10));

    // Step 0 — resolve distinct program IDs
    let distinctProgramIds = [];
    if (Array.isArray(args.indicator_ids) && args.indicator_ids.length) {
      // Validate indicator IDs look like UIDs, then fetch their programs
      const goodIds = args.indicator_ids.filter(id => /^[A-Za-z][A-Za-z0-9]{10}$/.test(id));
      if (goodIds.length === 0) return {
        _error: 'indicator_ids contained no valid DHIS2 UIDs (must be 11 chars, first alphabetic).',
        _hint: 'Reuse indicator IDs returned by a prior manage_program_indicators(action="discover") call.',
      };
      const fetched = await safeDhis2Fetch(
        `programIndicators?filter=id:in:[${goodIds.join(',')}]&fields=id,program[id]&paging=false`
      );
      if (fetched?._error) return fetched;
      const seen = new Set();
      for (const pi of (fetched.programIndicators || [])) {
        const pid = pi?.program?.id;
        if (pid && !seen.has(pid)) { seen.add(pid); distinctProgramIds.push(pid); }
      }
      const resolvedIds = new Set((fetched.programIndicators || []).map(pi => pi.id));
      const missing = goodIds.filter(id => !resolvedIds.has(id));
      if (missing.length) {
        return {
          _error: `indicator_ids not found in this instance: ${missing.join(', ')}.`,
          _hint: 'Do NOT invent indicator IDs. Use manage_program_indicators(action="discover") to get real UIDs.',
        };
      }
    } else if (Array.isArray(args.programs) && args.programs.length) {
      const known = await getKnownPrograms();
      const goodIds = args.programs.filter(id => /^[A-Za-z][A-Za-z0-9]{10}$/.test(id));
      const bad = goodIds.filter(id => known && !known.has(id));
      if (bad.length) {
        return {
          _error: `programs not found in this instance: ${bad.join(', ')}.`,
          _hint: 'Reuse program UIDs from a prior discover/search_metadata call. NEVER invent.',
        };
      }
      distinctProgramIds = goodIds;
    } else {
      return {
        _error: 'rank_ou requires either indicator_ids or programs.',
        _hint: 'Pass indicator_ids from a prior manage_program_indicators(action="discover"). Do not invent UIDs.',
      };
    }

    if (distinctProgramIds.length === 0) {
      return { _error: 'No distinct programs resolved from the input.' };
    }

    // Step 1 — resolve root OU: user-provided UID, else ctx, else USER_ORGUNIT literal dim
    let rootOuId = (args.root_ou && /^[A-Za-z][A-Za-z0-9]{10}$/.test(args.root_ou)) ? args.root_ou : null;
    if (!rootOuId) rootOuId = dhis2.pageContext?.orgUnitId || null;
    // If still null, use USER_ORGUNIT keyword (analytics accepts it in dimension values).
    const ouDim = rootOuId ? `${rootOuId};LEVEL-${level}` : `USER_ORGUNIT;LEVEL-${level}`;

    // Step 2 — parallel analytics/events/aggregate per program
    const CONCURRENCY = 5;
    const ouTotals = new Map();    // ouId -> number
    const ouNames = new Map();     // ouId -> displayName
    const perProgram = new Map();  // programId -> { name, events, per_ou: Map<ouId, n> }
    const errors = [];
    const queue = [...distinctProgramIds];
    const known = await getKnownPrograms();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const pid = queue.shift();
        if (!pid) break;
        const path = `analytics/events/aggregate/${pid}?dimension=ou:${encodeURIComponent(ouDim)}&dimension=pe:${encodeURIComponent(period)}`;
        const r = await safeDhis2Fetch(path);
        if (r?._error) { errors.push({ program_id: pid, error: r._error }); continue; }
        const headers = Array.isArray(r.headers) ? r.headers : [];
        const ouIdx = headers.findIndex(h => h?.name === 'ou');
        const vIdx = headers.findIndex(h => h?.name === 'value');
        const items = r?.metaData?.items || {};
        let progTotal = 0;
        const programOus = new Map();
        if (ouIdx >= 0 && vIdx >= 0 && Array.isArray(r.rows)) {
          for (const row of r.rows) {
            const ou = row[ouIdx];
            const v = parseFloat(row[vIdx]);
            if (!ou || !Number.isFinite(v)) continue;
            ouTotals.set(ou, (ouTotals.get(ou) || 0) + v);
            if (items[ou]?.name && !ouNames.has(ou)) ouNames.set(ou, items[ou].name);
            programOus.set(ou, (programOus.get(ou) || 0) + v);
            progTotal += v;
          }
        }
        perProgram.set(pid, {
          name: (known && known.get(pid)) || items[pid]?.name || pid,
          events: progTotal,
          per_ou: programOus,
        });
      }
    });
    await Promise.all(workers);

    if (ouTotals.size === 0 && errors.length === distinctProgramIds.length) {
      return {
        _error: 'All analytics/events/aggregate calls failed.',
        _details: errors,
        _hint: 'Common causes: analytics tables not rebuilt (E7144) or wrong LEVEL for this instance. Try a different level or ask the admin to run the analytics job.',
      };
    }

    // Step 3 — rank
    const rows = Array.from(ouTotals.entries()).map(([ou, total]) => ({
      org_unit_id: ou,
      org_unit_name: ouNames.get(ou) || ou,
      total_events: Math.round(total),
      per_program: Array.from(perProgram.entries())
        .filter(([, p]) => p.per_ou.has(ou))
        .map(([pid, p]) => ({ program_id: pid, program_name: p.name, events: Math.round(p.per_ou.get(ou) || 0) })),
    }));
    rows.sort((a, b) => b.total_events - a.total_events);

    return {
      action: 'rank_ou',
      level,
      period,
      root_ou: rootOuId || 'USER_ORGUNIT',
      programs_scanned: distinctProgramIds.length,
      program_errors: errors.length ? errors : undefined,
      total_org_units_with_data: rows.length,
      top_org_units: rows.slice(0, topN),
      _note: `Top ${Math.min(topN, rows.length)} of ${rows.length} OUs at level ${level} under ${rootOuId || 'USER_ORGUNIT'} over ${period}, summed across ${distinctProgramIds.length} program(s). Per-program breakdown included per OU.`,
    };
  }

  // ── list ──
  if (action === 'list') {
    if (!programId) return { _error: 'program_id required for list' };
    const page = Math.max(1, parseInt(args.page) || 1);
    const resp = await safeDhis2Fetch(
      `programIndicators?filter=program.id:eq:${programId}&fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals&pageSize=50&page=${page}&order=name:asc`
    );
    if (resp._error) return resp;
    const total = resp.pager?.total ?? 0;
    const pageCount = resp.pager?.pageCount ?? 1;
    return {
      ...resp,
      _page: page,
      _has_more: page < pageCount,
      _total: total,
      _note: page < pageCount
        ? `Showing page ${page} of ${pageCount} (${total} total). Call list(page=${page + 1}) for next page. To find issues across all indicators, use action=audit instead.`
        : `All ${total} indicator(s) shown (page ${page} of ${pageCount}).`,
    };
  }

  // ── audit ──
  if (action === 'audit') {
    if (!programId) return { _error: 'program_id required for audit' };
    const deep = args.deep !== false; // server-side validation default ON; pass deep:false to skip

    // Step 1: Fetch all indicators reliably using pager.pageCount (not batch-length heuristic).
    const PAGE_SIZE = 100;
    const allIndicators = [];
    const firstResp = await safeDhis2Fetch(
      `programIndicators?filter=program.id:eq:${programId}&fields=id,name,expression,filter,analyticsType,aggregationType,analyticsPeriodBoundaries[boundaryTarget,analyticsPeriodBoundaryType]&pageSize=${PAGE_SIZE}&page=1&order=name:asc&totalPages=true`,
      { noTruncate: true }
    );
    if (firstResp._error) return firstResp;
    allIndicators.push(...(firstResp.programIndicators || []));
    const totalCount = firstResp.pager?.total ?? allIndicators.length;
    const pageCount = firstResp.pager?.pageCount ?? 1;
    const fetchedPages = [1];
    const fetchErrors = [];
    const CAP = 100; // safety cap: 10000 indicators
    for (let p = 2; p <= Math.min(pageCount, CAP); p++) {
      const resp = await safeDhis2Fetch(
        `programIndicators?filter=program.id:eq:${programId}&fields=id,name,expression,filter,analyticsType,aggregationType,analyticsPeriodBoundaries[boundaryTarget,analyticsPeriodBoundaryType]&pageSize=${PAGE_SIZE}&page=${p}&order=name:asc`,
        { noTruncate: true }
      );
      if (resp._error) { fetchErrors.push({ page: p, error: resp._error }); continue; }
      allIndicators.push(...(resp.programIndicators || []));
      fetchedPages.push(p);
    }
    const paginationComplete = allIndicators.length >= totalCount && fetchErrors.length === 0;

    // Step 2: Fetch program structure for UID validation
    const progResp = await safeDhis2Fetch(
      `programs/${programId}?fields=programStages[id,programStageDataElements[dataElement[id]]],programTrackedEntityAttributes[trackedEntityAttribute[id]]`,
      { noTruncate: true }
    );

    const validStageIds = new Set();
    const validStageDeIds = new Map(); // stageId -> Set<deId>
    const validTeaIds = new Set();

    if (!progResp._error && !progResp._truncated) {
      for (const stage of (progResp.programStages || [])) {
        validStageIds.add(stage.id);
        const deSet = new Set();
        for (const psde of (stage.programStageDataElements || [])) {
          if (psde.dataElement?.id) deSet.add(psde.dataElement.id);
        }
        validStageDeIds.set(stage.id, deSet);
      }
      for (const ptea of (progResp.programTrackedEntityAttributes || [])) {
        if (ptea.trackedEntityAttribute?.id) validTeaIds.add(ptea.trackedEntityAttribute.id);
      }
    }
    const structureAvailable = validStageIds.size > 0;

    // Known program-indicator expression variables. Anything else inside V{...} is invalid.
    // Ref: https://docs.dhis2.org/master/en/developer/html/dhis2_developer_manual_full.html (Program Indicators)
    const VALID_V_VARS = new Set([
      'event_count', 'tei_count', 'enrollment_count', 'event_date', 'enrollment_date',
      'incident_date', 'due_date', 'completed_date', 'execution_date', 'scheduled_date',
      'value_count', 'zero_pos_value_count', 'org_unit_count', 'current_date',
      'reporting_period_start', 'reporting_period_end', 'enrollment_status', 'event_status',
      'program_stage_id', 'program_stage_name', 'analytics_period_start', 'analytics_period_end',
      'creation_date', 'completed_status', 'sync_date',
    ]);
    const VALID_D2_FUNCS = new Set([
      'condition', 'count', 'countIfValue', 'countIfCondition', 'daysBetween', 'hasValue',
      'maxValue', 'minValue', 'monthsBetween', 'oizp', 'relationshipCount', 'weeksBetween',
      'yearsBetween', 'zing', 'zpvc', 'zScoreHFA', 'zScoreWFA', 'zScoreWFH',
      'addDays', 'ceil', 'floor', 'round', 'modulus', 'validatePattern', 'left', 'right',
      'substring', 'split', 'concatenate', 'length', 'inOrgUnitGroup', 'lastEventDate',
    ]);

    // Step 3: Analyse each indicator for structural issues
    const issues = [];
    for (const pi of allIndicators) {
      const piIssues = [];

      if (!pi.analyticsPeriodBoundaries || pi.analyticsPeriodBoundaries.length === 0) {
        piIssues.push('Missing analyticsPeriodBoundaries — indicator will not compute in analytics');
      }
      if (pi.analyticsType === 'ENROLLMENT'
          && Array.isArray(pi.analyticsPeriodBoundaries) && pi.analyticsPeriodBoundaries.length
          && pi.analyticsPeriodBoundaries.every(b => b.boundaryTarget === 'EVENT_DATE')) {
        piIssues.push('ENROLLMENT indicator with EVENT_DATE-only boundaries — values are distorted: each enrollment is counted in EVERY period containing one of its events, and d2:count()-style filters see only same-period events (often always 0). Recreate the boundaries with boundaryTarget ENROLLMENT_DATE (update the indicator with analytics_type ENROLLMENT after clearing boundaries, or delete + re-create via this tool).');
      }
      if (!pi.expression || !pi.expression.trim()) {
        piIssues.push('Empty expression — indicator has no measure defined');
      }

      const exprStr = pi.expression || '';
      const filterStr = pi.filter || '';

      // Balanced braces/parens (quick syntactic sanity check on the expression and filter)
      for (const [label, s] of [['expression', exprStr], ['filter', filterStr]]) {
        if (!s) continue;
        let depthParen = 0, depthBrace = 0;
        for (const c of s) {
          if (c === '(') depthParen++;
          else if (c === ')') depthParen--;
          else if (c === '{') depthBrace++;
          else if (c === '}') depthBrace--;
          if (depthParen < 0 || depthBrace < 0) break;
        }
        if (depthParen !== 0) piIssues.push(`Unbalanced parentheses in ${label}`);
        if (depthBrace !== 0) piIssues.push(`Unbalanced braces in ${label}`);
      }

      const combined = exprStr + ' ' + filterStr;

      // #{...} references — must be stageId.deId or stageId.deId.optionId form
      const hashRefs = [...combined.matchAll(/#\{([^}]*)\}/g)];
      const seenHash = new Set();
      for (const [, inside] of hashRefs) {
        if (seenHash.has(inside)) continue;
        seenHash.add(inside);
        const parts = inside.split('.');
        if (parts.length < 2) {
          piIssues.push(`Malformed data element reference: #{${inside}} — must be #{stageId.deId}`);
          continue;
        }
        const [stageId, deId] = parts;
        if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(stageId) || !/^[A-Za-z][A-Za-z0-9]{10}$/.test(deId)) {
          piIssues.push(`Invalid UID in #{${inside}} — DHIS2 UIDs are 11 chars, first alphabetic`);
          continue;
        }
        if (structureAvailable) {
          if (!validStageIds.has(stageId)) {
            piIssues.push(`References unknown program stage: ${stageId}`);
          } else if (!validStageDeIds.get(stageId)?.has(deId)) {
            piIssues.push(`Data element ${deId} not found in stage ${stageId}`);
          }
        }
      }

      // A{attrId} references
      const teaRefs = [...combined.matchAll(/A\{([^}]*)\}/g)];
      const seenTea = new Set();
      for (const [, inside] of teaRefs) {
        if (seenTea.has(inside)) continue;
        seenTea.add(inside);
        if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(inside)) {
          piIssues.push(`Invalid TEA reference shape: A{${inside}}`);
          continue;
        }
        if (structureAvailable && !validTeaIds.has(inside)) {
          piIssues.push(`References unknown tracked entity attribute: ${inside}`);
        }
      }

      // V{...} — must be a known program-indicator variable
      const varRefs = [...combined.matchAll(/V\{([^}]*)\}/g)];
      for (const [, v] of varRefs) {
        if (!VALID_V_VARS.has(v)) {
          piIssues.push(`Unknown V{} variable: V{${v}} — not a recognised program-indicator variable`);
        }
      }

      // d2:functionName(...) — must be a known d2 function
      const d2Calls = [...combined.matchAll(/d2:([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
      for (const [, fn] of d2Calls) {
        if (!VALID_D2_FUNCS.has(fn)) {
          piIssues.push(`Unknown d2 function: d2:${fn}( — not a recognised program-indicator function`);
        }
      }

      // Detect ref-shapes that should not appear in program indicators
      if (/\bC\{[^}]+\}/.test(combined)) piIssues.push('C{} (category option combo) references are not valid in program indicators');
      if (/\bI\{[^}]+\}/.test(combined)) piIssues.push('I{} (indicator) references are not valid in program indicators');
      if (/\bOUG\{[^}]+\}/.test(combined)) piIssues.push('OUG{} references are not valid in program indicators');

      if (piIssues.length > 0) {
        issues.push({
          id: pi.id,
          name: pi.name,
          issues: piIssues,
          expression: exprStr.substring(0, 300),
          filter: filterStr ? filterStr.substring(0, 300) : null,
        });
      }
    }

    // Step 3b: Optional server-side validation via /programIndicators/expression/description.
    // Catches everything local rules miss (semantic errors, type mismatches, non-existent IDs we
    // couldn't resolve). Skipped when deep=false to save API calls on very large programs.
    let serverValidated = 0;
    let serverIssuesAdded = 0;
    if (deep && allIndicators.length > 0 && allIndicators.length <= 600) {
      const knownBrokenIds = new Set(issues.map(i => i.id));
      const concurrency = 6;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= allIndicators.length) return;
          const pi = allIndicators[idx];
          const checks = [];
          if (pi.expression && pi.expression.trim()) {
            checks.push(['expression', pi.expression]);
          }
          if (pi.filter && pi.filter.trim()) {
            checks.push(['filter', pi.filter]);
          }
          const newMessages = [];
          for (const [kind, text] of checks) {
            try {
              const res = await validateProgramIndicatorExpression(kind, text, programId);
              serverValidated++;
              // DHIS2 returns { status: "OK"|"ERROR", description, message }
              const status = res?.status;
              const isBad = res?._error
                || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
              if (isBad) {
                const msg = res._error || res.message || res.description || status || 'unknown error';
                newMessages.push(`Server rejected ${kind}: ${String(msg).substring(0, 200)}`);
              }
            } catch { /* ignore transient errors; structural scan already ran */ }
          }
          if (newMessages.length) {
            let entry = issues.find(i => i.id === pi.id);
            if (!entry) {
              entry = {
                id: pi.id,
                name: pi.name,
                issues: [],
                expression: (pi.expression || '').substring(0, 300),
                filter: pi.filter ? pi.filter.substring(0, 300) : null,
              };
              issues.push(entry);
            }
            for (const m of newMessages) {
              if (!entry.issues.includes(m)) { entry.issues.push(m); serverIssuesAdded++; }
            }
            knownBrokenIds.add(pi.id);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    // Detect wrong stage IDs referenced across the broken indicators and build bulk_fix hints
    const wrongStageToIndicators = new Map();
    for (const issue of issues) {
      for (const msg of issue.issues) {
        const m = msg.match(/References unknown program stage: ([A-Za-z][A-Za-z0-9]{10})/);
        if (m) {
          const sid = m[1];
          if (!wrongStageToIndicators.has(sid)) wrongStageToIndicators.set(sid, []);
          wrongStageToIndicators.get(sid).push({ id: issue.id, name: issue.name });
        }
      }
    }
    const stageFixHints = [];
    for (const [wrongStageId, affected] of wrongStageToIndicators.entries()) {
      stageFixHints.push({
        wrong_stage_id: wrongStageId,
        affected_indicator_ids: affected.map(a => a.id),
        affected_indicator_names: affected.map(a => a.name),
        fix_action: `manage_program_indicators(action=bulk_fix, indicator_ids=[${affected.map(a => `"${a.id}"`).join(',')}], replace_stage_id="${wrongStageId}", with_stage_id="<correct_stage_id>")`,
        note: 'Find the correct stage ID from the program structure, then call bulk_fix — it fetches, patches, and saves all indicators in one operation.',
      });
    }

    const serverValidatedNote = deep
      ? (allIndicators.length > 600
        ? 'server validation skipped (program has >600 indicators — pass deep:false or use bulk_fix after local audit)'
        : `server validated ${serverValidated} expression/filter strings, added ${serverIssuesAdded} server-detected issue(s)`)
      : 'server validation skipped (deep:false)';

    return {
      program_id: programId,
      total_indicators_checked: allIndicators.length,
      total_in_program: totalCount,
      pages_fetched: fetchedPages.length,
      total_pages: pageCount,
      pagination_complete: paginationComplete,
      total_with_issues: issues.length,
      structure_validation: structureAvailable ? 'full (stage+DE+TEA references checked)' : 'limited (program structure unavailable, only boundaries/expression checked)',
      server_validation: serverValidatedNote,
      issues: issues.slice(0, 250),
      _has_more_issues: issues.length > 250,
      ...(fetchErrors.length ? { _fetch_errors: fetchErrors } : {}),
      ...(stageFixHints.length > 0 ? { _stage_fix_hints: stageFixHints } : {}),
      _fix_hint: issues.length === 0 ? undefined
        : 'To fix expression/filter issues on one or many indicators in a single batch, use manage_program_indicators(action=bulk_fix_expressions, fixes=[{indicator_id, expression?, filter?}]). For a simple wrong-stage-id swap across many indicators, use action=bulk_fix.',
      summary: issues.length === 0
        ? `All ${allIndicators.length} indicators are structurally valid${deep ? ' (structural + server-side description check)' : ''} — boundaries present, references resolve${paginationComplete ? '' : ' (⚠️ pagination INCOMPLETE: some pages failed — retry)'}.`
        : `Found ${issues.length} of ${allIndicators.length} indicators with issues${paginationComplete ? '' : ' (⚠️ pagination INCOMPLETE: some pages failed — retry)'}. Use bulk_fix_expressions to apply per-indicator fixes, or bulk_fix for wrong-stage-id swaps. NEVER use dhis2_query PUT/PATCH.`,
    };
  }

  // ── bulk_fix ──
  // Replace a wrong stage ID with the correct one across multiple indicators in a single metadata batch.
  // This is the correct approach when audit returns "References unknown program stage" issues.
  if (action === 'bulk_fix') {
    const _gate = requireWriteAuth('manage_program_indicators', 'bulk_fix', { count: (args.indicator_ids || []).length });
    if (_gate) return _gate;
    if (!args.indicator_ids?.length) return { _error: 'indicator_ids array required for bulk_fix' };
    if (!args.replace_stage_id) return { _error: 'replace_stage_id required for bulk_fix' };
    if (!args.with_stage_id) return { _error: 'with_stage_id required for bulk_fix' };

    const wrongId = args.replace_stage_id;
    const rightId = args.with_stage_id;
    const fixStr = s => (s ? s.replace(new RegExp(wrongId, 'g'), rightId) : s);

    const piObjects = [];
    const fetchErrors = [];
    for (const indId of args.indicator_ids) {
      const existing = await safeDhis2Fetch(
        `programIndicators/${indId}?fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id],categoryCombo[id],attributeCombo[id],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType]`
      );
      if (existing._error) { fetchErrors.push({ id: indId, error: existing._error }); continue; }

      const pi = {
        id: existing.id,
        name: existing.name,
        shortName: existing.shortName,
        program: { id: existing.program?.id || programId },
        expression: fixStr(existing.expression),
        filter: fixStr(existing.filter),
        analyticsType: existing.analyticsType || 'EVENT',
        aggregationType: existing.aggregationType || 'COUNT',
        categoryCombo:  { id: existing.categoryCombo?.id  || 'bjDvmb4bfuf' },
        attributeCombo: { id: existing.attributeCombo?.id || 'bjDvmb4bfuf' },
        analyticsPeriodBoundaries: existing.analyticsPeriodBoundaries || [
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
        ],
      };
      if (existing.description !== undefined) pi.description = existing.description;
      if (existing.decimals  !== undefined) pi.decimals  = existing.decimals;
      pi.displayInForm = existing.displayInForm === true;
      piObjects.push(pi);
    }

    if (fetchErrors.length) return { _error: 'Could not fetch some indicators', fetch_errors: fetchErrors };
    if (!piObjects.length)  return { _error: 'No indicators to update after fetch' };

    const backup = await ensureBackupOrBail(
      { operation: 'bulk_fix', tool: 'manage_program_indicators', action: 'bulk_fix', reason: `Replacing stage id ${wrongId} → ${rightId} on ${piObjects.length} indicator(s)` },
      piObjects.map((p) => ({ object_type: 'programIndicators', object_id: p.id, role: 'primary' })),
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload({ programIndicators: piObjects }, false);
    return {
      ...result,
      summary: {
        fixed_count: piObjects.length,
        replaced: `${wrongId} → ${rightId}`,
        indicators: piObjects.map(p => ({ id: p.id, name: p.name })),
      },
      backup: backup.block,
    };
  }

  // ── bulk_fix_expressions ──
  // Apply arbitrary per-indicator expression/filter replacements in a single metadata batch.
  // Supports two shapes per entry in `fixes`:
  //   { indicator_id, expression?, filter? }              — set expression/filter to the given strings
  //   { indicator_id, find, replace, scope? }             — regex replace. scope: "both"|"expression"|"filter" (default both)
  // Optionally set `validate: true` to server-validate each new expression/filter before POSTing;
  // entries that fail validation are rejected and returned in `validation_errors` instead of committed.
  if (action === 'bulk_fix_expressions') {
    const _gate = requireWriteAuth('manage_program_indicators', 'bulk_fix_expressions', { count: (args.fixes || []).length });
    if (_gate) return _gate;
    if (!Array.isArray(args.fixes) || !args.fixes.length) {
      return { _error: 'fixes array required for bulk_fix_expressions — each entry: { indicator_id, expression? | filter? | find+replace+scope? }' };
    }
    const validate = args.validate !== false;

    const piObjects = [];
    const fetchErrors = [];
    const changes = [];

    for (const fix of args.fixes) {
      if (!fix.indicator_id) { fetchErrors.push({ error: 'fix entry missing indicator_id', entry: fix }); continue; }

      const existing = await safeDhis2Fetch(
        `programIndicators/${fix.indicator_id}?fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id],categoryCombo[id],attributeCombo[id],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType]`
      );
      if (existing._error) { fetchErrors.push({ id: fix.indicator_id, error: existing._error }); continue; }

      let newExpression = existing.expression;
      let newFilter = existing.filter;

      if (typeof fix.expression === 'string') newExpression = fix.expression;
      if (typeof fix.filter === 'string')     newFilter     = fix.filter;
      if (fix.find && typeof fix.replace === 'string') {
        const scope = fix.scope || 'both';
        try {
          const re = new RegExp(fix.find, 'g');
          if (scope === 'both' || scope === 'expression') newExpression = (newExpression || '').replace(re, fix.replace);
          if (scope === 'both' || scope === 'filter')     newFilter     = (newFilter || '').replace(re, fix.replace);
        } catch (e) {
          fetchErrors.push({ id: fix.indicator_id, error: `Invalid regex in fix.find: ${e.message}` });
          continue;
        }
      }

      const pi = {
        id: existing.id,
        name: existing.name,
        shortName: existing.shortName,
        program: { id: existing.program?.id || programId },
        expression: newExpression,
        filter: newFilter,
        analyticsType: existing.analyticsType || 'EVENT',
        aggregationType: existing.aggregationType || 'COUNT',
        categoryCombo:  { id: existing.categoryCombo?.id  || 'bjDvmb4bfuf' },
        attributeCombo: { id: existing.attributeCombo?.id || 'bjDvmb4bfuf' },
        analyticsPeriodBoundaries: existing.analyticsPeriodBoundaries || [
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
          { boundaryTarget: 'EVENT_DATE', analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
        ],
      };
      if (existing.description !== undefined) pi.description = existing.description;
      if (existing.decimals !== undefined)    pi.decimals    = existing.decimals;
      pi.displayInForm = existing.displayInForm === true;

      changes.push({
        id: pi.id,
        name: pi.name,
        expression_changed: newExpression !== existing.expression,
        filter_changed: newFilter !== existing.filter,
        before: { expression: existing.expression || null, filter: existing.filter || null },
        after:  { expression: newExpression || null,        filter: newFilter || null },
      });
      piObjects.push(pi);
    }

    if (!piObjects.length) {
      return { _error: 'No indicators to update after fetch', fetch_errors: fetchErrors };
    }

    // Optional server-side validation of the new expressions before committing.
    const validationErrors = [];
    if (validate) {
      for (let i = piObjects.length - 1; i >= 0; i--) {
        const pi = piObjects[i];
        const progIdForCheck = pi.program?.id || programId;
        if (!progIdForCheck) continue;
        for (const [kind, text] of [['expression', pi.expression], ['filter', pi.filter]]) {
          if (!text || !String(text).trim()) continue;
          const res = await validateProgramIndicatorExpression(kind, text, progIdForCheck);
          const status = res?.status;
          const bad = res?._error || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
          if (bad) {
            validationErrors.push({
              id: pi.id,
              name: pi.name,
              kind,
              rejected_value: (text || '').substring(0, 300),
              reason: res._error || res.message || res.description || status || 'unknown error',
            });
            piObjects.splice(i, 1);
            break;
          }
        }
      }
    }

    if (args.dry_run_only) {
      return {
        success: true,
        phase: 'dry_run',
        message: 'Dry run only. No changes committed.',
        would_commit: piObjects.length,
        changes,
        validation_errors: validationErrors,
        fetch_errors: fetchErrors,
      };
    }

    if (!piObjects.length) {
      return {
        _error: 'All fixes were rejected by server-side validation. Pass validate:false to bypass, or supply corrected expressions.',
        validation_errors: validationErrors,
        fetch_errors: fetchErrors,
      };
    }

    const backup = await ensureBackupOrBail(
      { operation: 'bulk_fix_expressions', tool: 'manage_program_indicators', action: 'bulk_fix_expressions', reason: `Bulk-fixing expressions on ${piObjects.length} indicator(s)` },
      piObjects.map((p) => ({ object_type: 'programIndicators', object_id: p.id, role: 'primary' })),
      args
    );
    if (!backup.ok) return backup.error;

    const result = await postMetadataPayload({ programIndicators: piObjects }, false);
    return {
      ...result,
      summary: {
        fixed_count: piObjects.length,
        validation_performed: validate,
        validation_errors_count: validationErrors.length,
        fetch_errors_count: fetchErrors.length,
        indicators: piObjects.map(p => ({ id: p.id, name: p.name })),
      },
      changes,
      ...(validationErrors.length ? { validation_errors: validationErrors } : {}),
      ...(fetchErrors.length ? { fetch_errors: fetchErrors } : {}),
      backup: backup.block,
    };
  }

  // ── get ──
  if (action === 'get') {
    if (!args.indicator_id) return { _error: 'indicator_id required for get' };
    return safeDhis2Fetch(
      `programIndicators/${args.indicator_id}?fields=id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id,displayName],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType],categoryCombo[id,name],attributeCombo[id,name]`
    );
  }

  // ── create ──
  if (action === 'create') {
    const _gate = requireWriteAuth('manage_program_indicators', 'create');
    if (_gate) return _gate;
    if (!programId) return { _error: 'program_id required for create' };
    if (!args.indicator) return { _error: 'indicator object required for create' };
    if (!args.indicator.name) return { _error: 'indicator.name is required' };
    return await _buildAndPostProgramIndicator(programId, null, args.indicator, args.dry_run_only);
  }

  // ── update ──
  if (action === 'update') {
    const _gate = requireWriteAuth('manage_program_indicators', 'update', { indicator_id: args.indicator_id });
    if (_gate) return _gate;
    if (!args.indicator_id) return { _error: 'indicator_id required for update' };
    if (!args.indicator) return { _error: 'indicator object (fields to change) required for update' };

    // Verify the indicator exists BEFORE touching it. 404 → STOP.
    const _verify = await verifyTargetExists('programIndicators', args.indicator_id, 'manage_program_indicators', 'update',
      'id,name,shortName,description,expression,filter,analyticsType,aggregationType,decimals,displayInForm,program[id],categoryCombo[id],attributeCombo[id],analyticsPeriodBoundaries[id,boundaryTarget,analyticsPeriodBoundaryType]');
    if (!_verify.exists) return _verify.refusal;
    const existing = _verify.data;

    if (!args.dry_run_only) {
      const backup = await ensureBackupOrBail(
        { operation: 'update', tool: 'manage_program_indicators', action: 'update', reason: `Updating program indicator ${existing.name || args.indicator_id}` },
        [{ object_type: 'programIndicators', object_id: args.indicator_id, role: 'primary' }],
        args
      );
      if (!backup.ok) return backup.error;
      const updateResult = await _buildAndPostProgramIndicator(existing.program?.id || programId, args.indicator_id, {
        name:             args.indicator.name             ?? existing.name,
        short_name:       args.indicator.short_name       ?? existing.shortName,
        description:      args.indicator.description      ?? existing.description,
        expression:       args.indicator.expression       ?? existing.expression,
        filter:           args.indicator.filter           ?? existing.filter,
        analytics_type:   args.indicator.analytics_type   ?? existing.analyticsType,
        aggregation_type: args.indicator.aggregation_type ?? existing.aggregationType,
        decimals:         args.indicator.decimals         ?? existing.decimals,
        display_in_form:  args.indicator.display_in_form  ?? existing.displayInForm,
        _catComboId:      existing.categoryCombo?.id,
        _attrComboId:     existing.attributeCombo?.id,
        // Changing the analytics type invalidates the old boundary pair — drop
        // it so the type-correct defaults regenerate.
        _boundaries:      (args.indicator.analytics_type && args.indicator.analytics_type !== existing.analyticsType) ? null : existing.analyticsPeriodBoundaries,
      }, args.dry_run_only);
      if (updateResult && typeof updateResult === 'object' && !Array.isArray(updateResult)) {
        updateResult.backup = backup.block;
      }
      return updateResult;
    }

    return await _buildAndPostProgramIndicator(existing.program?.id || programId, args.indicator_id, {
      name:             args.indicator.name             ?? existing.name,
      short_name:       args.indicator.short_name       ?? existing.shortName,
      description:      args.indicator.description      ?? existing.description,
      expression:       args.indicator.expression       ?? existing.expression,
      filter:           args.indicator.filter           ?? existing.filter,
      analytics_type:   args.indicator.analytics_type   ?? existing.analyticsType,
      aggregation_type: args.indicator.aggregation_type ?? existing.aggregationType,
      decimals:         args.indicator.decimals         ?? existing.decimals,
      display_in_form:  args.indicator.display_in_form  ?? existing.displayInForm,
      _catComboId:      existing.categoryCombo?.id,
      _attrComboId:     existing.attributeCombo?.id,
      _boundaries:      (args.indicator.analytics_type && args.indicator.analytics_type !== existing.analyticsType) ? null : existing.analyticsPeriodBoundaries,
    }, args.dry_run_only);
  }

  // ── delete ──
  if (action === 'delete') {
    const _gate = requireWriteAuth('manage_program_indicators', 'delete', { indicator_id: args.indicator_id });
    if (_gate) return _gate;
    if (!args.indicator_id) return { _error: 'indicator_id required for delete' };

    // Verify the indicator exists BEFORE deleting. 404 → STOP.
    const _verify = await verifyTargetExists('programIndicators', args.indicator_id, 'manage_program_indicators', 'delete');
    if (!_verify.exists) return _verify.refusal;

    const backup = await ensureBackupOrBail(
      { operation: 'delete', tool: 'manage_program_indicators', action: 'delete', reason: `Deleting program indicator ${args.indicator_id}` },
      [{ object_type: 'programIndicators', object_id: args.indicator_id, role: 'primary' }],
      args
    );
    if (!backup.ok) return backup.error;

    const resp = await safeDhis2Fetch(`programIndicators/${args.indicator_id}`, { method: 'DELETE' });
    if (resp._error) return { ...resp, backup: backup.block };
    return { success: true, deleted_indicator_id: args.indicator_id, backup: backup.block };
  }

  return { _error: `Unknown action: ${action}. Use: list, get, create, update, delete, audit, bulk_fix, bulk_fix_expressions, discover, rank_ou` };
}

// Build and POST a program indicator object.
// indicator_id=null → create new; indicator_id=string → update existing.
async function _buildAndPostProgramIndicator(programId, indicatorId, indicator, dryRun) {
  // Resolve default categoryCombo once
  const catComboId = indicator._catComboId
    || (await safeDhis2Fetch('categoryCombos?filter=name:eq:default&fields=id&pageSize=1'))?.categoryCombos?.[0]?.id
    || 'bjDvmb4bfuf';

  const uid = indicatorId || generateDhis2Uid();
  // Boundary target MUST follow the analytics type. An ENROLLMENT indicator
  // with EVENT_DATE boundaries silently corrupts the numbers (verified live on
  // play 2.42.5.1, 2026-07-10): each enrollment is counted in EVERY period
  // that contains one of its events (massive over-count), and d2:count()
  // filters see only same-period events, so "4+ ANC visits" style indicators
  // return 0 forever. The Maintenance app uses ENROLLMENT_DATE for enrollment
  // PIs — mirror that.
  const analyticsType = indicator.analytics_type || 'EVENT';
  const boundaryTarget = analyticsType === 'ENROLLMENT' ? 'ENROLLMENT_DATE' : 'EVENT_DATE';
  const pi = {
    id: uid,
    name: indicator.name,
    shortName: clampShortName(indicator.short_name, indicator.name, null, 'Indicator'),
    program: { id: programId },
    expression: indicator.expression || 'V{event_count}',
    filter: indicator.filter || '',
    analyticsType,
    aggregationType: indicator.aggregation_type || 'COUNT',
    categoryCombo:  { id: catComboId },
    attributeCombo: { id: indicator._attrComboId || catComboId },
    // Preserve existing boundaries on update; generate the type-correct pair on create
    analyticsPeriodBoundaries: indicator._boundaries || [
      { boundaryTarget, analyticsPeriodBoundaryType: 'AFTER_START_OF_REPORTING_PERIOD' },
      { boundaryTarget, analyticsPeriodBoundaryType: 'BEFORE_END_OF_REPORTING_PERIOD' },
    ],
  };
  if (indicator.description !== undefined) pi.description = indicator.description;
  if (indicator.decimals !== undefined) pi.decimals = indicator.decimals;
  // Always serialize displayInForm: the metadata import replaces the FULL
  // object, so omitting it on update would silently reset a widget-visible
  // indicator back to hidden. Callers thread existing.displayInForm through.
  pi.displayInForm = indicator.display_in_form === true;

  // Pre-flight validation. DHIS2 happily returns 201 on a syntactically broken
  // filter (e.g. d2:contains is a program-rule fn, not a PI fn) — but analytics
  // then returns 409 forever after. Lint locally first, then ask DHIS2's own
  // /expression/description and /filter/description endpoints. Fail fast with a
  // structured hint so the model can self-correct in the next loop iteration.
  const exprLint = lintProgramIndicatorExpression(pi.expression, 'expression');
  if (exprLint) {
    return {
      _error: `Program indicator ${indicatorId ? 'update' : 'create'} blocked by expression lint. ${exprLint.error}`,
      _hint: exprLint.hint || 'Fix the expression and retry.',
      expression: pi.expression,
    };
  }
  if (pi.filter && pi.filter.trim()) {
    const filterLint = lintProgramIndicatorExpression(pi.filter, 'filter');
    if (filterLint) {
      return {
        _error: `Program indicator ${indicatorId ? 'update' : 'create'} blocked by filter lint. ${filterLint.error}`,
        _hint: filterLint.hint || 'Fix the filter and retry.',
        filter: pi.filter,
      };
    }
  }

  // Server-side validation — authoritative. Catches semantic errors the local
  // lint can't (unresolved DE/stage/TEA IDs, type mismatches, parser quirks).
  const exprChecks = [];
  exprChecks.push(['expression', pi.expression]);
  if (pi.filter && pi.filter.trim()) exprChecks.push(['filter', pi.filter]);
  const validationResults = await Promise.all(
    exprChecks.map(([kind, text]) =>
      validateProgramIndicatorExpression(kind, text, programId).then(r => ({ kind, text, r }))
    )
  );
  for (const { kind, text, r } of validationResults) {
    const status = r?.status;
    const isBad = r?._error || (status && status !== 'OK' && status !== 'VALID' && status !== 'SUCCESS');
    if (isBad) {
      const msg = r._error || r.message || r.description || status || 'invalid';
      const hint = (kind === 'filter' && /d2:contains|Invalid string token 'd'/.test(String(msg)))
        ? 'Likely cause: `d2:contains(...)` was used in a PI filter. d2:contains exists only in Program Rules, not Program Indicators. There is NO contains operator in DHIS2 2.41 PI grammar — `==` is exact match, even for MULTI_TEXT. For "MULTI_TEXT contains both X and Y": split the multi-select into separate BOOLEAN data elements and filter `#{stage.dm} == true && #{stage.htn} == true`. Or use the Line Listing app for ad-hoc analysis.'
        : (kind === 'filter'
          ? 'Fix the filter using only PI grammar: ==, !=, <, >, <=, >=, &&, ||, +, -, *, / and supported d2:* functions. No LIKE/IN/regex/subExpression.'
          : 'Fix the expression using only PI grammar and supported d2:* functions.');
      return {
        _error: `Program indicator ${kind} rejected by DHIS2 server: ${String(msg).substring(0, 300)}`,
        _server_description: r.description,
        _hint: hint,
        [kind]: text,
      };
    }
  }

  if (dryRun) {
    return { success: true, phase: 'dry_run', message: 'Dry run only. No changes committed.', would_save: pi };
  }

  // For CREATE, pre-probe the server for shortName collisions. UPDATE keeps
  // its existing shortName (the same row), so skip when indicatorId is set.
  if (!indicatorId) {
    await disambiguateShortNamesAgainstServer([pi], 'programIndicators', 'programIndicators');

    // NAME is also globally unique on programIndicators. A collision (e.g. the
    // same indicator set created earlier for another program on a shared
    // server) fails the whole POST with "Property `name` … already exists" —
    // auto-suffix with the program's short name (then a UID shard), same
    // convention as stage-name disambiguation. Observed live on play 2.40.12
    // (2026-07-07) re-running the MCH scenario.
    const nameProbe = await safeDhis2Fetch(`programIndicators?filter=name:eq:${encodeURIComponent(pi.name)}&fields=id&pageSize=1`);
    if (nameProbe?.programIndicators?.length) {
      const progMeta = await safeDhis2Fetch(`programs/${programId}?fields=shortName,name`);
      const suffix = String(progMeta?.shortName || progMeta?.name || '').trim();
      let candidate = suffix ? `${indicator.name} - ${suffix}`.substring(0, 230) : '';
      if (candidate) {
        const probe2 = await safeDhis2Fetch(`programIndicators?filter=name:eq:${encodeURIComponent(candidate)}&fields=id&pageSize=1`);
        if (probe2?.programIndicators?.length) candidate = '';
      }
      if (!candidate) candidate = `${indicator.name} ${generateDhis2Uid().slice(-4)}`.substring(0, 230);
      pi._renamedFrom = indicator.name;
      pi.name = candidate;
    }
  }

  const renamedFrom = pi._renamedFrom;
  delete pi._renamedFrom;
  const result = await postMetadataPayload({ programIndicators: [pi] }, false);
  const out = {
    ...result,
    summary: {
      indicator: { id: uid, name: pi.name },
      ...(renamedFrom ? { name_auto_disambiguated: { from: renamedFrom, to: pi.name, reason: 'a program indicator with the requested name already exists (names are globally unique)' } } : {}),
    },
  };
  // Mirror the top-level *_id convention every other write tool already exposes
  // (manage_indicators → indicator_id, manage_dashboards → visualization_id /
  // dashboard_id, manage_org_units → org_unit_id, manage_datasets → dataset_id)
  // so a multi-step caller can chain this program indicator's UID STRAIGHT into
  // the next tool — e.g. a dashboard visualization's data_items, where it is
  // auto-resolved as PROGRAM_INDICATOR — without having to dig into the nested
  // summary object. Purely additive: summary.indicator.id is preserved for any
  // existing reader. Only surfaced on a successful import so a failed create can
  // never yield a chainable-but-nonexistent UID.
  if (result && result.success) out.program_indicator_id = uid;
  return out;
}

async function createStandaloneOptionSet(args) {
  if (!args.option_set_name) return { _error: 'Missing option_set_name' };
  if (!args.options?.length) return { _error: 'Missing options array' };

  const { optionSet, options } = buildOptionSetAndOptions({
    name: args.option_set_name,
    options: args.options,
  });

  const payload = { options, optionSets: [optionSet] };
  const result = await postMetadataPayload(payload, args.dry_run_only);

  return {
    ...result,
    summary: {
      optionSet: { id: optionSet.id, name: optionSet.name },
      options: options.map(o => ({ id: o.id, name: o.name, code: o.code })),
    },
  };
}

// Resolve an EXISTING option set for a data element that references one by UID
// or exact name (as opposed to bundling a brand-new inline option_set). Returns
// { id, valueType, name } on success or { _error } if it cannot be resolved — so
// a DE never silently points at a non-existent set (which would fail the import
// with an opaque message). Purely additive: DEs that pass only an inline
// option_set (or none) never reach this path. This is what lets the
// manage_option_sets(create) → create_data_elements chain compose — the DE step
// can attach the just-created set by option_set_id instead of duplicating it.
async function resolveExistingOptionSetRef(optionSetId, optionSetName) {
  if (optionSetId) {
    const id = String(optionSetId).trim();
    const resp = await safeDhis2Fetch(`optionSets/${id}?fields=id,name,valueType`);
    if (resp?._error || resp?._status === 404 || !resp?.id) {
      return {
        _error: `option_set_id "${id}" does not exist on this server.`,
        _hint: 'Chain the option_set_id returned by manage_option_sets(action="create"), or pass an inline option_set:{name,options:[...]} to create a new one.',
      };
    }
    return { id: resp.id, valueType: resp.valueType || 'TEXT', name: resp.name || id };
  }
  const nm = String(optionSetName || '').trim();
  if (!nm) return { _error: 'option_set reference is empty (no option_set_id or option_set_name).' };
  const probe = await safeDhis2Fetch(`optionSets?filter=name:eq:${encodeURIComponent(nm)}&fields=id,name,valueType&pageSize=2`);
  const hits = probe?.optionSets || [];
  if (!hits.length) return {
    _error: `option_set_name "${nm}" not found on this server.`,
    _hint: 'Create it first with manage_option_sets(action="create") and chain the returned option_set_id, or pass an inline option_set:{name,options:[...]}.',
  };
  if (hits.length > 1) return { _error: `option_set_name "${nm}" is ambiguous (${hits.length} matches). Pass option_set_id instead.` };
  return { id: hits[0].id, valueType: hits[0].valueType || 'TEXT', name: hits[0].name || nm };
}

async function createStandaloneDataElements(args, defaultCatComboId) {
  if (!args.data_elements?.length) return { _error: 'Missing data_elements array' };

  const allOptions = [];
  const allOptionSets = [];
  const allDataElements = [];
  const optionSetUidMap = {};
  const seenDEShortNames = new Set();

  // Batch defaults — applied to every DE that doesn't override.
  const batchDomain = args.domain_type || args.domainType || null;
  const batchAgg = args.aggregation_type || args.aggregationType || null;

  // ── Inline category combo support ─────────────────────────────────────
  // The chatbot's most common disaggregation request is "create a categoryCombo
  // and attach these data elements to it" (HTS-by-Sex, OPV-by-Dose, etc.).
  // Without first-class support, the model splits this into raw /metadata POSTs
  // and trips on dependency ordering or missing dataDimensionType. This branch
  // bundles the entire payload (options + categories + combo + DEs) into ONE
  // atomic POST, then triggers CoC regen so the DEs are immediately enterable.
  let comboBundle = null;
  let comboPayload = {};
  let inlineComboUid = null;
  let resolvedComboName = null;
  if (args.category_combo && typeof args.category_combo === 'object') {
    comboBundle = await buildCategoryComboBundle(args.category_combo);
    if (comboBundle?._error) return { _error: `category_combo build failed: ${comboBundle._error}` };
    inlineComboUid = comboBundle.uid;
    resolvedComboName = comboBundle.name;
    comboPayload = comboBundle.payload || {};
  }

  // OR: model passed a pre-existing combo by id/name.
  let existingComboId = args.category_combo_id || args.categoryComboId || null;
  if (!existingComboId && args.category_combo_name && !comboBundle) {
    const probe = await safeDhis2Fetch(
      `categoryCombos?filter=name:eq:${encodeURIComponent(args.category_combo_name)}&fields=id,name&pageSize=1`
    );
    const hit = probe?.categoryCombos?.[0];
    if (hit?.id) existingComboId = hit.id;
    else return {
      _error: `category_combo_name "${args.category_combo_name}" not found on this server. Pass category_combo_id, an inline category_combo:{...} definition, or omit to use default.`,
    };
  }

  // The cc UID applied to DEs that opt into the combo. Order: per-DE override
  // > inline-bundle UID > looked-up existing UID > batch default > system default.
  const batchComboId = inlineComboUid || existingComboId || null;

  for (const de of args.data_elements) {
    const hasInlineOptionSet = !!(de.option_set && de.option_set.name && de.option_set.options?.length);
    const refIdRaw = de.option_set_id || de.optionSetId || null;
    const refNameRaw = de.option_set_name || de.optionSetName || null;
    // Reference an EXISTING option set by UID/name (the chaining path). Mutually
    // exclusive with an inline option_set so intent is never ambiguous.
    if ((refIdRaw || refNameRaw) && hasInlineOptionSet) {
      return {
        _error: `Data element "${de.name || '(unnamed)'}" specifies BOTH an inline option_set and an existing option_set_id/option_set_name.`,
        _hint: 'Use inline option_set:{name,options} to CREATE a new set, OR option_set_id/option_set_name to REFERENCE an existing one — not both.',
      };
    }
    if (refIdRaw || refNameRaw) {
      const ref = await resolveExistingOptionSetRef(refIdRaw, refNameRaw);
      if (ref._error) return ref;
      de._optionSetRef = { id: ref.id, valueType: ref.valueType };
    }
    // Inline option set bundling (existing behavior — preserved verbatim).
    if (hasInlineOptionSet) {
      if (!optionSetUidMap[de.option_set.name]) {
        const { optionSet, options, osUid } = buildOptionSetAndOptions(de.option_set, de.value_type);
        allOptions.push(...options);
        allOptionSets.push(optionSet);
        optionSetUidMap[de.option_set.name] = osUid;
      }
    }
    // Resolve effective categoryCombo for this DE.
    //   • per-DE category_combo_id wins
    //   • use_category_combo:true binds to the inline combo / batch combo
    //   • use_default_combo:true forces the system default (overrides batch combo)
    //   • otherwise falls through to the batch / system default
    let perDeCcId = de.category_combo_id || de.categoryComboId || null;
    if (!perDeCcId && de.use_category_combo === true && batchComboId) {
      perDeCcId = batchComboId;
    }
    if (de.use_default_combo === true) {
      perDeCcId = defaultCatComboId;
    }
    const opts = {
      domainType: de.domain_type || batchDomain || undefined,
      aggregationType: de.aggregation_type || batchAgg || undefined,
      categoryComboId: perDeCcId || batchComboId || undefined,
    };
    const { elem } = buildDataElement(de, defaultCatComboId, optionSetUidMap, seenDEShortNames, opts);
    allDataElements.push(elem);
  }

  // Pre-probe the server for shortName collisions on these new DEs.
  await disambiguateShortNamesAgainstServer(allDataElements, 'dataElements', 'dataElements');

  const payload = {
    ...comboPayload, // categoryOptions / categories / categoryCombos (if inline)
  };
  if (allOptions.length) payload.options = allOptions;
  if (allOptionSets.length) payload.optionSets = allOptionSets;
  payload.dataElements = allDataElements;

  const result = await postMetadataPayload(payload, args.dry_run_only);

  // If we bundled a brand-new categoryCombo, trigger CoC regeneration so the
  // DEs are immediately enterable in any dataset/form. Without this the form
  // renders no disaggregation columns.
  let cocUpdate = null;
  if (result?.success && !args.dry_run_only && inlineComboUid && comboBundle?.payload?.categoryCombos?.length) {
    const t = await triggerCategoryOptionComboUpdate();
    cocUpdate = t.ok ? { ok: true, note: 'CategoryOptionCombos regenerated.' } : { ok: false, error: t.error };
  }

  // Optional sharing application via legacy /api/sharing on the new combo + DEs.
  let sharingResult = null;
  if (result?.success && !args.dry_run_only && args.sharing) {
    const items = [];
    if (inlineComboUid) items.push({ type: 'categoryCombo', id: inlineComboUid });
    for (const cat of (comboBundle?.payload?.categories || [])) items.push({ type: 'category', id: cat.id });
    for (const opt of (comboBundle?.payload?.categoryOptions || [])) items.push({ type: 'categoryOption', id: opt.id });
    for (const de of allDataElements) items.push({ type: 'dataElement', id: de.id });
    if (items.length) sharingResult = await applySharingViaLegacyEndpoint(items, args.sharing);
  }

  return {
    ...result,
    summary: {
      dataElements: allDataElements.map(de => ({
        id: de.id,
        name: de.name,
        valueType: de.valueType,
        domainType: de.domainType,
        aggregationType: de.aggregationType,
        categoryComboId: de.categoryCombo?.id,
        optionSetId: de.optionSet?.id || null,
      })),
      optionSets: Object.entries(optionSetUidMap).map(([name, id]) => ({ name, id })),
      categoryCombo: inlineComboUid
        ? { id: inlineComboUid, name: resolvedComboName, ...(comboBundle?.summary || {}) }
        : (existingComboId ? { id: existingComboId, reused: true } : null),
      cocUpdate,
      sharing: sharingResult,
    },
  };
}

// Standalone categoryCombo (with optional inline categories/options). Atomic
// /metadata POST + maintenance/CoC regen + optional legacy sharing application.
async function createStandaloneCategoryCombo(args) {
  const combo = args.category_combo || args;
  if (!combo?.name) {
    return {
      _error: 'category_combo.name (or top-level name) is required',
      _hint: 'Call shape: create_metadata(action="create_category_combo", category_combo:{name, categories:[{name, options:[...]} | {id}]}, sharing?)',
    };
  }
  if (!combo.categories || !combo.categories.length) {
    return {
      _error: 'category_combo.categories[] required',
      _hint: 'Each item is { id } to reuse an existing category, or { name, options:[...] } to create a new one. Existing options/categories are auto-detected by exact name and reused.',
    };
  }

  const bundle = await buildCategoryComboBundle(combo);
  if (bundle?._error) return { _error: bundle._error };

  const result = await postMetadataPayload(bundle.payload, args.dry_run_only);

  let cocUpdate = null;
  if (result?.success && !args.dry_run_only) {
    const t = await triggerCategoryOptionComboUpdate();
    cocUpdate = t.ok ? { ok: true, note: 'CategoryOptionCombos regenerated.' } : { ok: false, error: t.error };
  }

  // Optional sharing via legacy endpoint (works for metadata-only-shareable
  // categoryCombo / category / categoryOption).
  let sharingResult = null;
  if (result?.success && !args.dry_run_only && args.sharing) {
    const items = [{ type: 'categoryCombo', id: bundle.uid }];
    for (const cat of (bundle.payload?.categories || [])) items.push({ type: 'category', id: cat.id });
    for (const opt of (bundle.payload?.categoryOptions || [])) items.push({ type: 'categoryOption', id: opt.id });
    sharingResult = await applySharingViaLegacyEndpoint(items, args.sharing);
  }

  return {
    ...result,
    summary: {
      categoryCombo: { id: bundle.uid, name: bundle.name },
      ...bundle.summary,
      cocUpdate,
      sharing: sharingResult,
    },
    _next_steps: [
      'Use create_metadata(action="create_data_elements", category_combo_id="' + bundle.uid + '", domain_type="AGGREGATE", data_elements:[...]) to attach data elements to this combo.',
      'Or pass category_combo_id="' + bundle.uid + '" to manage_datasets(action="create" or "add_data_elements") for dataset-level attribute disaggregation.',
    ],
  };
}

// ── Meta-Architect Agent Engine ──────────────────────────────────────────────

async function executeArchitectMetadata(args) {
  const action = args.action;
  if (!action) return { _error: 'Missing required parameter: action' };

  try {
    switch (action) {

      // ── lookup_schema: introspect DHIS2 API schema for any metadata type ──
      case 'lookup_schema': {
        const schemaType = args.schema_type;
        if (!schemaType) return { _error: 'Missing schema_type for lookup_schema action.' };

        const schema = await safeDhis2Fetch(`schemas/${schemaType}.json?fields=name,plural,klass,properties[name,fieldName,propertyType,itemPropertyType,required,writable,constants,persisted,owner,description]`);
        if (!schema || schema._error) {
          return { _error: `Failed to fetch schema for "${schemaType}": ${schema?._error || 'unknown error'}` };
        }

        // Extract the most useful info: required writable fields, optional writable fields, value type enums
        const props = schema.properties || [];
        const requiredFields = props.filter(p => p.required && p.writable).map(p => ({
          name: p.name || p.fieldName,
          type: p.propertyType,
          itemType: p.itemPropertyType || undefined,
          description: p.description || undefined,
        }));
        const optionalWritable = props.filter(p => !p.required && p.writable && p.persisted).map(p => ({
          name: p.name || p.fieldName,
          type: p.propertyType,
          itemType: p.itemPropertyType || undefined,
          constants: p.constants?.length ? p.constants : undefined,
        }));

        return {
          schema_type: schemaType,
          plural: schema.plural || schemaType + 's',
          required_fields: requiredFields,
          optional_writable_fields: optionalWritable.slice(0, 40), // limit to keep response manageable
          total_properties: props.length,
          hint: 'Use required_fields to understand what must be supplied when creating this object type. constants arrays show allowed enum values (e.g. valueType constants for dataElement).',
        };
      }

      // ── check_existing: search for existing metadata to avoid duplicates ──
      case 'check_existing': {
        const objectType = args.object_type;
        const nameFilter = args.name_filter;
        if (!objectType) return { _error: 'Missing object_type for check_existing action.' };
        if (!nameFilter) return { _error: 'Missing name_filter for check_existing action.' };

        const encodedFilter = encodeURIComponent(nameFilter);
        const resp = await safeDhis2Fetch(
          `${objectType}?filter=name:ilike:${encodedFilter}&fields=id,name,shortName,created,lastUpdated&pageSize=25`
        );
        if (!resp || resp._error) {
          return { _error: `Failed to search ${objectType}: ${resp?._error || 'unknown error'}` };
        }

        const items = resp[objectType] || [];
        return {
          object_type: objectType,
          search_term: nameFilter,
          found: items.length,
          items: items,
          hint: items.length > 0
            ? `Found ${items.length} existing ${objectType} matching "${nameFilter}". Reuse existing IDs to avoid duplicates.`
            : `No existing ${objectType} found matching "${nameFilter}". Safe to create new.`,
        };
      }

      // ── verify: confirm created objects exist and are correctly configured ──
      case 'verify': {
        const results = [];

        // Verify individual objects by ID
        if (args.verify_ids?.length) {
          for (const item of args.verify_ids) {
            try {
              const obj = await safeDhis2Fetch(`${item.type}/${item.id}?fields=id,name,displayName,created`);
              const exists = !!(obj && obj.id);
              const nameMatch = item.expected_name ? (obj?.name === item.expected_name || obj?.displayName === item.expected_name) : null;
              results.push({
                type: item.type,
                id: item.id,
                exists,
                name: obj?.name || obj?.displayName || null,
                name_matches: nameMatch,
                status: exists ? (nameMatch === false ? '⚠️ EXISTS but name mismatch' : '✅ VERIFIED') : '❌ NOT FOUND',
              });
            } catch (e) {
              results.push({ type: item.type, id: item.id, exists: false, status: '❌ ERROR', error: e.message });
            }
          }
        }

        // Deep verify a full program structure
        if (args.verify_program_id) {
          try {
            // NOTE: rules + rule variables are fetched via the programRules /
            // programRuleVariables endpoints with a program filter, NOT as
            // program fields — `programs/{id}?fields=programRules[...]` returns
            // an EMPTY collection on DHIS2 2.40 even when rules exist (verified
            // live on play 2.40.12, 2026-07-07), which silently made this
            // verify skip every rule check.
            const [prog, rulesResp, prvsResp] = await Promise.all([
              safeDhis2Fetch(
                `programs/${args.verify_program_id}?fields=id,name,programType,programStages[id,name,sortOrder,programStageDataElements[dataElement[id,name,valueType,optionSet[id,name]]]],trackedEntityType[id,name],organisationUnits[id,name]`
              ),
              safeDhis2Fetch(
                `programRules?filter=program.id:eq:${args.verify_program_id}&fields=id,name,condition,programRuleActions[id,programRuleActionType,content,data,dataElement[id,name],programStage[id]]&paging=false`
              ),
              safeDhis2Fetch(
                `programRuleVariables?filter=program.id:eq:${args.verify_program_id}&fields=id,name,programRuleVariableSourceType,useCodeForOptionSet,dataElement[id],trackedEntityAttribute[id]&paging=false`
              ),
            ]);
            if (!prog || prog._error) {
              results.push({ program_verify: args.verify_program_id, status: '❌ NOT FOUND', error: prog?._error });
            } else {
              const stages = prog.programStages || [];
              const rules = rulesResp?.programRules || [];
              const prvs = prvsResp?.programRuleVariables || [];
              const ous = prog.organisationUnits || [];

              // Rule-quality advisories the pure existence checks can't see.
              // (a) An option-set-backed PRV with useCodeForOptionSet=false that a
              //     condition compares to a quoted literal → the variable yields the
              //     option NAME while conditions conventionally use CODES, so the
              //     rule silently never fires (exact MCH failure, play 2.40.12).
              // (b) HIDEPROGRAMSTAGE reminder — in the new Capture web app it only
              //     blocks adding events; the stage card stays visible.
              const ruleAdvisories = [];
              {
                const optionSetDeIds = new Set();
                for (const s of stages) {
                  for (const psde of (s.programStageDataElements || [])) {
                    if (psde.dataElement?.optionSet) optionSetDeIds.add(psde.dataElement.id);
                  }
                }
                for (const v of prvs) {
                  const bound = v.dataElement?.id;
                  if (!bound || !optionSetDeIds.has(bound) || v.useCodeForOptionSet === true) continue;
                  for (const r of rules) {
                    const esc = String(v.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    if (new RegExp(`#\\{${esc}\\}\\s*(==|!=)\\s*'[^']+'`).test(r.condition || '')) {
                      ruleAdvisories.push(`Rule "${r.name}" compares #{${v.name}} to a quoted literal, but that variable has useCodeForOptionSet=false (it yields the option NAME, not the CODE) — if the literal is an option code the rule NEVER fires. Fix: set useCodeForOptionSet=true on the variable via manage_program_rules, or compare against the option name.`);
                    }
                  }
                }
                if (rules.some(r => (r.programRuleActions || []).some(a => a.programRuleActionType === 'HIDEPROGRAMSTAGE'))) {
                  ruleAdvisories.push('This program uses HIDEPROGRAMSTAGE: in the NEW Capture web app that only disables adding events to the stage (the stage card stays visible on the enrollment dashboard); the legacy Tracker Capture / Android apps hide the stage entirely. Expected behavior — mention it to the user.');
                }
              }

              results.push({
                program_verify: args.verify_program_id,
                status: '✅ PROGRAM VERIFIED',
                name: prog.name,
                programType: prog.programType,
                trackedEntityType: prog.trackedEntityType ? { id: prog.trackedEntityType.id, name: prog.trackedEntityType.name } : null,
                organisationUnits: ous.length,
                stages: stages.map(s => ({
                  id: s.id,
                  name: s.name,
                  sortOrder: s.sortOrder,
                  dataElements: (s.programStageDataElements || []).map(psde => ({
                    id: psde.dataElement?.id,
                    name: psde.dataElement?.name,
                    valueType: psde.dataElement?.valueType,
                    hasOptionSet: !!psde.dataElement?.optionSet,
                  })),
                })),
                programRuleVariables: prvs.map(v => ({ id: v.id, name: v.name, sourceType: v.programRuleVariableSourceType })),
                programRules: rules.map(r => ({
                  id: r.id,
                  name: r.name,
                  condition: r.condition,
                  actions: (r.programRuleActions || []).map(a => ({
                    type: a.programRuleActionType,
                    content: a.content || null,
                    data: a.data || null,
                    dataElement: a.dataElement ? { id: a.dataElement.id, name: a.dataElement.name } : null,
                  })),
                })),
                integrity_checks: {
                  has_tracked_entity_type: !!prog.trackedEntityType,
                  has_org_units: ous.length > 0,
                  all_stages_have_data_elements: stages.every(s => (s.programStageDataElements || []).length > 0),
                  rule_count: rules.length,
                  prv_count: prvs.length,
                  rule_quality_ok: ruleAdvisories.length === 0,
                },
                ...(ruleAdvisories.length ? { rule_advisories: ruleAdvisories } : {}),
              });
            }
          } catch (e) {
            results.push({ program_verify: args.verify_program_id, status: '❌ ERROR', error: e.message });
          }
        }

        if (results.length === 0) {
          return { _error: 'Provide verify_ids array and/or verify_program_id to verify.' };
        }
        return { verification_results: results };
      }

      // ── browse_dhis2_docs: search official DHIS2 docs via Tavily ──
      case 'browse_dhis2_docs': {
        const query = args.docs_query;
        if (!query) return { _error: 'Missing docs_query for browse_dhis2_docs action.' };

        try {
          const stored = await chrome.storage.local.get(['tavilyApiKey']);
          const tavilyKey = stored.tavilyApiKey;
          if (!tavilyKey) {
            return { _error: 'No Tavily API key configured. Open settings to add your Tavily API key. Alternatively, use browse_web tool directly.' };
          }

          const resp = await fetch(TAVILY_SEARCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: `DHIS2 ${query}`,
              search_depth: 'advanced',
              include_domains: ['docs.dhis2.org', 'community.dhis2.org', 'developers.dhis2.org'],
              max_results: 5,
              include_answer: true,
            }),
          });
          const data = await resp.json();
          return {
            answer: data.answer || null,
            results: (data.results || []).map(r => ({
              title: r.title,
              url: r.url,
              snippet: r.content?.substring(0, 500),
            })),
            hint: 'Use these docs to understand DHIS2 metadata structures, API payloads, program rules syntax, etc.',
          };
        } catch (e) {
          return { _error: `Docs search failed: ${e.message}. You can also try the browse_web tool directly.` };
        }
      }

      // ── inspect_program: deep inspection of an existing program ──
      case 'inspect_program': {
        const pid = args.program_id;
        if (!pid) return { _error: 'Missing program_id for inspect_program action.' };

        const prog = await safeDhis2Fetch(
          `programs/${pid}?fields=id,name,displayName,shortName,programType,enrollmentDateLabel,incidentDateLabel,` +
          `trackedEntityType[id,name],` +
          `organisationUnits[id,name],` +
          `programTrackedEntityAttributes[trackedEntityAttribute[id,name,valueType,optionSet[id,name,options[id,name,code]]],mandatory,searchable,displayInList],` +
          `programStages[id,name,displayName,sortOrder,repeatable,` +
            `programStageDataElements[compulsory,dataElement[id,name,valueType,optionSet[id,name,options[id,name,code]]]]],` +
          `programRuleVariables[id,name,programRuleVariableSourceType,dataElement[id,name],trackedEntityAttribute[id,name],programStage[id,name]],` +
          `programRules[id,name,description,condition,priority,` +
            `programRuleActions[id,programRuleActionType,content,data,location,` +
              `dataElement[id,name],trackedEntityAttribute[id,name],programStage[id,name],` +
              `programStageSection[id,name],option[id,name],optionGroup[id,name]]],` +
          `programIndicators[id,name,expression,filter,analyticsType]`
        );

        if (!prog || prog._error) {
          return { _error: `Failed to fetch program "${pid}": ${prog?._error || 'not found'}` };
        }

        const ctxStageId = dhis2.pageContext?.stageId || null;
        return {
          _currentStageId: ctxStageId,
          _currentStageName: ctxStageId ? (prog.programStages || []).find(s => s.id === ctxStageId)?.name || null : null,
          program: {
            id: prog.id,
            name: prog.name,
            shortName: prog.shortName,
            programType: prog.programType,
            enrollmentDateLabel: prog.enrollmentDateLabel,
            incidentDateLabel: prog.incidentDateLabel,
            trackedEntityType: prog.trackedEntityType || null,
            organisationUnits: (prog.organisationUnits || []).length,
            orgUnitSample: (prog.organisationUnits || []).slice(0, 5).map(o => ({ id: o.id, name: o.name })),
          },
          trackedEntityAttributes: (prog.programTrackedEntityAttributes || []).map(ptea => ({
            id: ptea.trackedEntityAttribute?.id,
            name: ptea.trackedEntityAttribute?.name,
            valueType: ptea.trackedEntityAttribute?.valueType,
            mandatory: ptea.mandatory,
            searchable: ptea.searchable,
            displayInList: ptea.displayInList,
            hasOptionSet: !!ptea.trackedEntityAttribute?.optionSet,
            optionSetName: ptea.trackedEntityAttribute?.optionSet?.name || null,
          })),
          stages: (prog.programStages || []).map(s => ({
            id: s.id,
            name: s.name,
            sortOrder: s.sortOrder,
            repeatable: s.repeatable,
            dataElements: (s.programStageDataElements || []).map(psde => ({
              id: psde.dataElement?.id,
              name: psde.dataElement?.name,
              valueType: psde.dataElement?.valueType,
              compulsory: psde.compulsory,
              hasOptionSet: !!psde.dataElement?.optionSet,
              optionSetName: psde.dataElement?.optionSet?.name || null,
              options: psde.dataElement?.optionSet?.options?.map(o => ({ name: o.name, code: o.code })) || [],
            })),
          })),
          programRuleVariables: (prog.programRuleVariables || []).map(v => ({
            id: v.id,
            name: v.name,
            sourceType: v.programRuleVariableSourceType,
            dataElement: v.dataElement ? { id: v.dataElement.id, name: v.dataElement.name } : null,
            attribute: v.trackedEntityAttribute ? { id: v.trackedEntityAttribute.id, name: v.trackedEntityAttribute.name } : null,
            stage: v.programStage ? { id: v.programStage.id, name: v.programStage.name } : null,
          })),
          programRules: (prog.programRules || []).map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
            condition: r.condition,
            priority: r.priority,
            actions: (r.programRuleActions || []).map(a => ({
              type: a.programRuleActionType,
              content: a.content,
              data: a.data,
              location: a.location,
              dataElement: a.dataElement ? `${a.dataElement.name} (${a.dataElement.id})` : null,
              attribute: a.trackedEntityAttribute ? `${a.trackedEntityAttribute.name} (${a.trackedEntityAttribute.id})` : null,
              stage: a.programStage ? `${a.programStage.name} (${a.programStage.id})` : null,
            })),
          })),
          programIndicators: (prog.programIndicators || []).map(pi => ({
            id: pi.id, name: pi.name, expression: pi.expression, filter: pi.filter,
          })),
          hint: 'Use this detailed structure to understand what exists before making modifications. Cross-reference stage DEs and PRVs when adding rules.',
        };
      }

      default:
        return { _error: `Unknown architect_metadata action: "${action}". Valid actions: lookup_schema, check_existing, verify, browse_dhis2_docs, inspect_program.` };
    }
  } catch (err) {
    return { _error: `architect_metadata(${action}) failed: ${err.message}` };
  }
}

