// ── Placing AI-built plugins where users see them ───────────────────────────
// manage_custom_app(action = "place" | "unplace" | "placements").
//
// Dashboard plugins go onto dashboards through manage_dashboards (which backs
// the dashboard up and appends). Capture plugins are written into the Capture
// app's own configuration — exactly what the Tracker Plugin Configurator
// writes — in the "capture" dataStore namespace:
//   enrollmentOverviewLayout | enrollmentEventNewLayout | enrollmentEventEditLayout
//     → { <programId>: { leftColumn: [...], rightColumn: [...] } }
//   dataEntryForms
//     → { <programStageId | programId>: [ { id, name?, elements: [...] } ] }
// Verified 2026-10-22 against the Capture 106.2.2 bundle on DHIS2 2.42.5.1 and
// the configs the Configurator (3.0.2) saved on that server:
//   - a plain form element is matched by its id (the Configurator writes
//     type "TrackedEntityAttribute" for data elements too); fields the config
//     leaves out still appear, in a trailing "leftovers" section;
//   - only fieldMap entries with objectType "TrackedEntityAttribute" become
//     plugin fields, exposed to the plugin under IdFromPlugin;
//   - Capture reads these keys when it loads, so changes show after a reload.

const CAPTURE_NAMESPACE = 'capture';
const CAPTURE_FORMS_KEY = 'dataEntryForms';
const CAPTURE_LAYOUT_TARGETS = Object.freeze({
  enrollment_dashboard: 'enrollmentOverviewLayout',
  enrollment_event_new: 'enrollmentEventNewLayout',
  enrollment_event_edit: 'enrollmentEventEditLayout',
});
const PLACEMENT_TARGETS = ['dashboard', ...Object.keys(CAPTURE_LAYOUT_TARGETS), 'form'];
const PLUGIN_FIELD_ALIAS_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Capture 106's built-in page layouts (from its bundle): what a program with
// no entry shows. A program entry REPLACES the default, so a plugin is added
// to a copy of this, not to an empty page.
const captureWidget = (name, settings) => (settings ? { type: 'component', name, settings } : { type: 'component', name });
const CAPTURE_DEFAULT_LAYOUTS = Object.freeze({
  enrollmentOverviewLayout: {
    leftColumn: [captureWidget('StagesAndEvents')],
    rightColumn: [
      captureWidget('QuickActions'), captureWidget('ErrorWidget'), captureWidget('WarningWidget'),
      captureWidget('EnrollmentNote'), captureWidget('FeedbackWidget'), captureWidget('IndicatorWidget'),
      captureWidget('TrackedEntityRelationship'), captureWidget('ProfileWidget', { readOnlyMode: false }),
      captureWidget('EnrollmentWidget', { readOnlyMode: false }),
    ],
  },
  enrollmentEventNewLayout: {
    leftColumn: [captureWidget('NewEventWorkspace')],
    rightColumn: [
      captureWidget('TrackedEntityRelationship'), captureWidget('ErrorWidget'), captureWidget('WarningWidget'),
      captureWidget('FeedbackWidget'), captureWidget('IndicatorWidget'),
      captureWidget('ProfileWidget', { readOnlyMode: true }), captureWidget('EnrollmentWidget', { readOnlyMode: true }),
    ],
  },
  enrollmentEventEditLayout: {
    leftColumn: [captureWidget('EditEventWorkspace'), captureWidget('RelatedStagesWorkspace')],
    rightColumn: [
      captureWidget('AssigneeWidget'), captureWidget('ErrorWidget'), captureWidget('WarningWidget'),
      captureWidget('EventNote'), captureWidget('FeedbackWidget'), captureWidget('IndicatorWidget'),
      captureWidget('TrackedEntityRelationship'), captureWidget('ProfileWidget', { readOnlyMode: true }),
      captureWidget('EnrollmentWidget', { readOnlyMode: true }),
    ],
  },
});

// DHIS2 stores dataStore values as jsonb, which reorders object keys — compare
// with sorted keys, never with the raw JSON text.
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// "/api/apps/<key>/" with the slash, so ai-kpi never matches ai-kpi-2.
function isPluginSourceOf(key, src) {
  return typeof src === 'string' && src.includes(`/api/apps/${key}/`);
}

// ── Layout pages (enrollment dashboard, add event, edit event) ──────────────

function captureDefaultLayout(dsKey) {
  return cloneJson(CAPTURE_DEFAULT_LAYOUTS[dsKey]);
}

// → { layout, already } — the plugin is added once; a re-place leaves it put.
function layoutWithPlugin(layout, key, source, column, position) {
  const out = cloneJson(layout || {});
  out.leftColumn = Array.isArray(out.leftColumn) ? out.leftColumn : [];
  out.rightColumn = Array.isArray(out.rightColumn) ? out.rightColumn : [];
  if ([...out.leftColumn, ...out.rightColumn].some((w) => w && w.type === 'plugin' && isPluginSourceOf(key, w.source))) {
    return { layout: out, already: true };
  }
  const col = column === 'left' ? out.leftColumn : out.rightColumn;
  const entry = { type: 'plugin', source };
  if (position === 'bottom') col.push(entry);
  else col.unshift(entry);
  return { layout: out, already: false };
}

function layoutWithoutPlugin(layout, key) {
  const out = cloneJson(layout || {});
  let removed = 0;
  for (const col of ['leftColumn', 'rightColumn']) {
    if (!Array.isArray(out[col])) continue;
    const before = out[col].length;
    out[col] = out[col].filter((w) => !(w && w.type === 'plugin' && isPluginSourceOf(key, w.source)));
    removed += before - out[col].length;
  }
  return { layout: out, removed };
}

function isDefaultCaptureLayout(layout, dsKey) {
  const def = CAPTURE_DEFAULT_LAYOUTS[dsKey];
  return !!layout && canonicalJson({ leftColumn: layout.leftColumn || [], rightColumn: layout.rightColumn || [] }) === canonicalJson(def);
}

// ── Data entry forms (form-field plugins) ───────────────────────────────────

// The form a context shows without a config, written the way the Configurator
// writes it: one section per metadata section, else one untitled section.
function defaultCaptureFormConfig(ctx) {
  if (ctx.customForm) return [];
  const el = (id) => ({ id, type: 'TrackedEntityAttribute' });
  if (ctx.sections.length) {
    return ctx.sections.map((s) => ({ id: s.id, name: s.name, elements: s.fieldIds.map(el) }));
  }
  return [{ id: `main-${ctx.id}`, elements: ctx.fieldIds.map(el) }];
}

function formPluginElements(sections, key) {
  const out = [];
  for (const s of sections || []) for (const e of s.elements || []) if (e && e.type === 'plugin' && isPluginSourceOf(key, e.pluginSource)) out.push({ section: s, element: e });
  return out;
}

// Removes this app's plugin elements. Fields a plugin had taken out of the form
// go back exactly where the plugin was; a section that held nothing but the
// plugin goes too. → { sections, removed }
function formWithoutPlugin(sections, key) {
  const out = cloneJson(sections || []);
  let removed = 0;
  const plainIds = () => new Set(out.flatMap((s) => (s.elements || []).filter((e) => e && e.type !== 'plugin').map((e) => e.id)));
  const otherMapped = () => new Set(out.flatMap((s) => (s.elements || [])
    .filter((e) => e && e.type === 'plugin' && !isPluginSourceOf(key, e.pluginSource))
    .flatMap((e) => (e.fieldMap || []).map((f) => f.IdFromApp))));
  const emptied = new Set();
  for (const s of out) {
    const next = [];
    for (const e of s.elements || []) {
      if (e && e.type === 'plugin' && isPluginSourceOf(key, e.pluginSource)) {
        removed++;
        const present = plainIds();
        const mappedElsewhere = otherMapped();
        for (const f of e.fieldMap || []) {
          if (f && f.IdFromApp && !present.has(f.IdFromApp) && !mappedElsewhere.has(f.IdFromApp) && !next.some((n) => n.id === f.IdFromApp)) {
            next.push({ id: f.IdFromApp, type: 'TrackedEntityAttribute' });
          }
        }
        continue;
      }
      next.push(e);
    }
    if (!next.length && (s.elements || []).length) emptied.add(s);
    s.elements = next;
  }
  return { sections: out.filter((s) => !emptied.has(s)), removed };
}

// → { sections } | { _error }. Upsert: an earlier placement of the same app in
// this form is taken out first, so placing again just updates the mapping.
function formWithPlugin(sections, ctx, opts) {
  const { key, name, source, fieldMap, section, sectionName, position } = opts;
  const base = formWithoutPlugin(sections, key).sections;
  const element = {
    id: `${key}-${generateDhis2Uid().slice(0, 6)}`,
    name,
    type: 'plugin',
    pluginSource: source,
    fieldMap: fieldMap.map((f) => ({ IdFromApp: f.field_id, IdFromPlugin: f.plugin_field, objectType: 'TrackedEntityAttribute' })),
  };
  // Fields the plugin replaces leave their normal place in the form.
  const replaced = new Set(fieldMap.filter((f) => f.replace_field === true).map((f) => f.field_id));
  for (const s of base) s.elements = (s.elements || []).filter((e) => !(e && e.type !== 'plugin' && replaced.has(e.id)));
  if (section) {
    const want = String(section).trim().toLowerCase();
    const hit = base.find((s) => s.id === section || String(s.name || '').trim().toLowerCase() === want
      || String((ctx.sections.find((m) => m.id === s.id) || {}).name || '').trim().toLowerCase() === want);
    if (!hit) {
      const names = base.map((s) => s.name || (ctx.sections.find((m) => m.id === s.id) || {}).name || s.id);
      return { _error: `No section "${section}" in this form.`, _hint: `Sections: ${names.join(', ') || '(none)'}. Omit section to add the plugin in its own section.` };
    }
    if (position === 'top') hit.elements.unshift(element);
    else hit.elements.push(element);
  } else {
    const own = { id: `${key}-section-${generateDhis2Uid().slice(0, 6)}`, name: sectionName || name, elements: [element] };
    if (position === 'top') base.unshift(own);
    else base.push(own);
  }
  return { sections: base };
}

// Aliases the plugin source reads (values.x / values['x']) and writes
// (setFieldValue({ fieldId: 'x' })), checked against the field map: Capture
// rejects a write to an unmapped alias and gives the plugin nothing for an
// unmapped read.
function pluginFieldAliasProblems(pluginSource, fieldMap) {
  const src = String(pluginSource || '');
  const mapped = new Set(fieldMap.map((f) => f.plugin_field));
  const written = new Set([...src.matchAll(/fieldId\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
  const read = new Set([
    ...[...src.matchAll(/\bvalues\s*(?:\?\.)?\[\s*['"]([^'"]+)['"]\s*\]/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bvalues\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  ]);
  const errors = [];
  const warnings = [];
  for (const a of written) if (!mapped.has(a)) errors.push(`The plugin writes "${a}" (setFieldValue) but field_map has no plugin_field "${a}" — Capture would reject that write.`);
  for (const a of read) if (!mapped.has(a) && !written.has(a)) warnings.push(`The plugin reads values.${a} but field_map has no plugin_field "${a}" — it will always be empty.`);
  for (const a of mapped) if (!written.has(a) && !read.has(a) && !src.includes(a)) warnings.push(`plugin_field "${a}" is mapped but the plugin code never uses it.`);
  return { errors, warnings, writes: [...written] };
}

// ── Server reads / writes ───────────────────────────────────────────────────

// Lists namespaces/keys first (a GET on a missing key is a 404), once per
// action: pass the same `memo` object to every read of one action.
async function captureKeyList(memo) {
  if (memo && memo.keys) return memo.keys;
  const namespaces = await safeDhis2Fetch('dataStore', { noTruncate: true });
  if (namespaces && namespaces._error) return { _error: `Could not list dataStore namespaces: ${namespaces._error}` };
  let keys = [];
  if (Array.isArray(namespaces) && namespaces.includes(CAPTURE_NAMESPACE)) {
    const k = await safeDhis2Fetch(`dataStore/${CAPTURE_NAMESPACE}`, { noTruncate: true });
    if (k && k._error) return { _error: `Could not list dataStore/${CAPTURE_NAMESPACE}: ${k._error}` };
    keys = Array.isArray(k) ? k : [];
  }
  if (memo) memo.keys = keys;
  return keys;
}

async function readCaptureConfig(dsKey, memo) {
  const keys = await captureKeyList(memo);
  if (keys._error) return keys;
  if (!keys.includes(dsKey)) return { exists: false, value: {} };
  const value = await safeDhis2Fetch(`dataStore/${CAPTURE_NAMESPACE}/${dsKey}`, { noTruncate: true });
  if (value && value._error) return { _error: `Could not read dataStore/${CAPTURE_NAMESPACE}/${dsKey}: ${value._error}` };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { _error: `dataStore/${CAPTURE_NAMESPACE}/${dsKey} is not a JSON object — refusing to edit it.`, _hint: 'Open the Tracker Plugin Configurator to repair it.' };
  }
  return { exists: true, value };
}

async function writeCaptureConfig(dsKey, value, exists) {
  const path = `dataStore/${CAPTURE_NAMESPACE}/${dsKey}`;
  const w = await safeDhis2Fetch(path, { method: exists ? 'PUT' : 'POST', body: value, allowEmptyBody: true });
  if (w && w._error) return { _error: `Could not write ${path}: ${w._error}` };
  const back = await safeDhis2Fetch(path, { noTruncate: true });
  if (back && back._error) return { _error: `Wrote ${path} but could not read it back: ${back._error}` };
  if (canonicalJson(back) !== canonicalJson(value)) return { _error: `Wrote ${path} but it reads back different from what was sent.`, _hint: 'Check the configuration in the Tracker Plugin Configurator; the backup can restore the previous one.' };
  return { ok: true };
}

function captureBackupKey(dsKey) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `backup-${ts}-capture-${dsKey}-${generateDhis2Uid().slice(0, 6)}`;
}

async function backupCaptureConfig(dsKey, existed, value, action, reason) {
  const backupKey = captureBackupKey(dsKey);
  const entry = {
    version: BACKUP_KEY_VERSION,
    created_at: new Date().toISOString(),
    retention_days: BACKUP_RETENTION_DAYS,
    operation: 'capture_config_update',
    tool: 'manage_custom_app',
    action,
    reason: reason || null,
    origin_server: dhis2.baseUrl || null,
    objects: [],
    capture_config: { namespace: CAPTURE_NAMESPACE, key: dsKey, existed, value: existed ? value : null },
  };
  const put = await safeDhis2Fetch(`dataStore/${encodeURIComponent(BACKUP_NAMESPACE)}/${encodeURIComponent(backupKey)}`, { method: 'POST', body: entry });
  if (put && put._error) {
    return {
      _error: `Could not back up dataStore/${CAPTURE_NAMESPACE}/${dsKey} before changing it: ${put._error}`,
      _requires_user_confirmation: true,
      _hint: 'Nothing was changed. Retry with skip_backup:true only if the user accepts changing the Capture configuration without a backup.',
    };
  }
  return { backup_key: backupKey };
}

// core.restoreFromBackup hands capture_config entries here (manage_backups restore).
async function restoreCaptureConfigFromBackup(backupKey, entry) {
  const c = entry.capture_config || {};
  if (c.namespace !== CAPTURE_NAMESPACE || !c.key) return { _error: `Backup ${backupKey} is not a Capture configuration backup.` };
  const gate = requireWriteAuth('manage_backups', 'restore', { backup_key: backupKey });
  if (gate) return gate;
  const cur = await readCaptureConfig(c.key);
  if (cur._error) return cur;
  if (c.existed) {
    const w = await writeCaptureConfig(c.key, c.value, cur.exists);
    if (w._error) return w;
  } else if (cur.exists) {
    const d = await safeDhis2Fetch(`dataStore/${CAPTURE_NAMESPACE}/${c.key}`, { method: 'DELETE', allowEmptyBody: true });
    if (d && d._error) return { _error: `Could not remove dataStore/${CAPTURE_NAMESPACE}/${c.key}: ${d._error}` };
  }
  return { success: true, action: 'restore', backup_key: backupKey, restored: `dataStore/${CAPTURE_NAMESPACE}/${c.key}`, _note: 'Reload the Capture app to see the restored configuration.' };
}

// ── Context metadata ────────────────────────────────────────────────────────

async function captureProgram(programId) {
  const p = await safeDhis2Fetch(`programs/${encodeURIComponent(programId)}?fields=id,displayName,programType,`
    + 'programTrackedEntityAttributes[trackedEntityAttribute[id,displayName,valueType]],programSections[id,displayName,sortOrder,trackedEntityAttributes[id]]', { noTruncate: true });
  if (p && p._status === 404) return { _error: `Program ${programId} does not exist.`, _hint: 'Find it with search_metadata(object_type="programs").' };
  if (p && p._error) return { _error: `Could not read program ${programId}: ${p._error}` };
  if (p.programType !== 'WITH_REGISTRATION') return { _error: `"${p.displayName}" is an event program; Capture plugins on enrollment pages and registration forms need a tracker program.` };
  return p;
}

async function captureFormContext(args) {
  if (args.program_stage_id) {
    const st = await safeDhis2Fetch(`programStages/${encodeURIComponent(args.program_stage_id)}?fields=id,displayName,formType,dataEntryForm[id],program[id,displayName,programType],`
      + 'programStageDataElements[dataElement[id,displayName,valueType]],programStageSections[id,displayName,sortOrder,dataElements[id]]', { noTruncate: true });
    if (st && st._status === 404) return { _error: `Program stage ${args.program_stage_id} does not exist.` };
    if (st && st._error) return { _error: `Could not read program stage ${args.program_stage_id}: ${st._error}` };
    if (!st.program || st.program.programType !== 'WITH_REGISTRATION') {
      return { _error: `"${st.displayName}" belongs to an event program; form-field plugins are supported on tracker program stages here.` };
    }
    const fields = (st.programStageDataElements || []).map((p) => p.dataElement).filter(Boolean);
    return {
      id: st.id,
      kind: 'program_stage',
      name: st.displayName,
      programId: st.program.id,
      programName: st.program.displayName,
      customForm: st.formType === 'CUSTOM' || !!(st.dataEntryForm && st.dataEntryForm.id),
      fieldIds: fields.map((f) => f.id),
      fields: Object.fromEntries(fields.map((f) => [f.id, f])),
      sections: [...(st.programStageSections || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .map((s) => ({ id: s.id, name: s.displayName, fieldIds: (s.dataElements || []).map((d) => d.id) })),
    };
  }
  const p = await captureProgram(args.program_id);
  if (p._error) return p;
  const fields = (p.programTrackedEntityAttributes || []).map((x) => x.trackedEntityAttribute).filter(Boolean);
  return {
    id: p.id,
    kind: 'program',
    name: `${p.displayName} — registration form`,
    programId: p.id,
    programName: p.displayName,
    customForm: false,
    fieldIds: fields.map((f) => f.id),
    fields: Object.fromEntries(fields.map((f) => [f.id, f])),
    sections: [...(p.programSections || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((s) => ({ id: s.id, name: s.displayName, fieldIds: (s.trackedEntityAttributes || []).map((t) => t.id) })),
  };
}

// → { app, summary, pluginType, source } for an installed assistant-built plugin.
async function placementApp(key) {
  if (!key) return { _error: 'Pass key (the plugin to place).' };
  const problem = customAppKeyProblem(key);
  if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
  const apps = await listInstalledApps();
  if (apps._error) return apps;
  const app = apps.find((a) => a.key === key);
  if (!app) return { _error: `No app with key "${key}" is installed.`, _hint: 'Install it first (preview → create), or check manage_custom_app(action="list").' };
  if (!isAssistantBuiltApp(app)) return { _error: `Refused: "${key}" was not built by the DHIS2 AI Assistant; place it with the Tracker Plugin Configurator or the Dashboard app.`, _refused_not_managed: true };
  const summary = summarizeInstalledApp(app);
  if (!summary.plugin_launch_url) return { _error: `"${key}" is an app without a plugin, so there is nothing to place.`, _hint: 'Update it with kind "app_and_plugin" or "plugin" first.' };
  return { app, summary, pluginType: summary.plugin_type, source: summary.plugin_launch_url, apps };
}

function normalizeFieldMap(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  return raw.map((f) => ({
    plugin_field: String((f && (f.plugin_field ?? f.IdFromPlugin)) || '').trim(),
    field_id: String((f && (f.field_id ?? f.IdFromApp)) || '').trim(),
    replace_field: !!(f && f.replace_field === true),
  }));
}

function fieldMapProblem(fieldMap, ctx) {
  if (!fieldMap.length) return { _error: 'A form-field plugin needs field_map: [{ plugin_field: "<alias the plugin uses>", field_id: "<data element / attribute UID>" }, …].' };
  const seenAlias = new Set();
  const seenField = new Set();
  for (const f of fieldMap) {
    if (!PLUGIN_FIELD_ALIAS_RE.test(f.plugin_field)) return { _error: `plugin_field "${f.plugin_field}" must start with a letter and use letters, digits, - or _ (max 64).` };
    if (seenAlias.has(f.plugin_field)) return { _error: `plugin_field "${f.plugin_field}" is mapped twice.` };
    if (seenField.has(f.field_id)) return { _error: `field ${f.field_id} is mapped twice.` };
    seenAlias.add(f.plugin_field);
    seenField.add(f.field_id);
    if (!ctx.fields[f.field_id]) {
      const what = ctx.kind === 'program_stage' ? `a data element of stage "${ctx.name}"` : `an attribute of program "${ctx.programName}"`;
      return { _error: `field_id ${f.field_id} is not ${what}.`, _hint: `Valid fields: ${Object.values(ctx.fields).slice(0, 40).map((x) => `${x.displayName} (${x.id})`).join(', ')}` };
    }
  }
  return null;
}

// ── Placement listing ───────────────────────────────────────────────────────

async function listPluginPlacements(key) {
  const out = { dashboards: [], capture_pages: [], forms: [] };
  const memo = {};
  const dash = await safeDhis2Fetch(`dashboards?filter=${encodeURIComponent(`dashboardItems.appKey:eq:${key}`)}&fields=id,displayName,dashboardItems[id,type,appKey]&paging=false`, { noTruncate: true });
  if (dash && dash._error) return { _error: `Could not list dashboards: ${dash._error}` };
  for (const d of (dash && dash.dashboards) || []) {
    out.dashboards.push({ dashboard_id: d.id, dashboard_name: d.displayName, item_ids: (d.dashboardItems || []).filter((i) => i.appKey === key).map((i) => i.id) });
  }
  for (const [target, dsKey] of Object.entries(CAPTURE_LAYOUT_TARGETS)) {
    const cfg = await readCaptureConfig(dsKey, memo);
    if (cfg._error) return cfg;
    for (const [programId, layout] of Object.entries(cfg.value || {})) {
      for (const col of ['leftColumn', 'rightColumn']) {
        const idx = ((layout && layout[col]) || []).findIndex((w) => w && w.type === 'plugin' && isPluginSourceOf(key, w.source));
        if (idx !== -1) out.capture_pages.push({ target, program_id: programId, column: col === 'leftColumn' ? 'left' : 'right', index: idx });
      }
    }
  }
  const forms = await readCaptureConfig(CAPTURE_FORMS_KEY, memo);
  if (forms._error) return forms;
  for (const [ctxId, sections] of Object.entries(forms.value || {})) {
    for (const { section, element } of formPluginElements(sections, key)) {
      out.forms.push({ context_id: ctxId, section_id: section.id, section_name: section.name || null, field_map: (element.fieldMap || []).map((f) => ({ plugin_field: f.IdFromPlugin, field_id: f.IdFromApp })) });
    }
  }
  return out;
}

// ── Was a placement asked for? ──────────────────────────────────────────────
// Installing is not placing. Asked only to build a dashboard widget and then
// "yes, install it", GLM-5.3-flash also created a dashboard nobody asked for
// and put the widget on it (live 2026-10-22). place therefore needs the user
// to have asked for a place — in this message or a recent one — or to be
// answering the assistant's own "where should it go?" question.
const PLACE_INTENT_RES = [
  /\b(?:add|put|place|pin|show|display|insert|embed|attach)\b[^.?!]{0,80}\b(?:on|to|in|into|onto)\b[^.?!]{0,50}\b(?:dashboards?|enrol?lments?|forms?|pages?|stages?|capture|registration)\b/,
  /\b(?:widget|plugin)s?\s+(?:on|in|to|into|onto)\s+(?:the|this|my|a|an|our)?\s*(?:[\w-]+\s+){0,3}(?:dashboards?|forms?|pages?)\b/,
  /\b(?:widget|plugin)s?\s+here\b|\bas\s+a\s+widget\s+here\b/,
  /\b(?:new|existing)\s+dashboard\s+(?:called|named)\b/,
  /\b(?:place|pin|put)\s+(?:it|them|the\s+(?:widget|plugin))\b/,
  /\btracker\s+plugin\s+configurator\b/,
];
function userAskedToPlace(texts) {
  return texts.some((t) => PLACE_INTENT_RES.some((re) => re.test(String(t || '').toLowerCase())));
}
const messageText = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '');
function placementWasRequested() {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const recentUser = history.filter((m) => m && m.role === 'user').slice(-3).map(messageText);
  if (userAskedToPlace([lastUserText, ...recentUser])) return true;
  const lastAssistant = [...history].reverse().find((m) => m && m.role === 'assistant' && messageText(m).trim());
  // A question that offers a PLACE ("Should I add it to the ANC dashboard?"),
  // not any question that happens to say "dashboard widget".
  const offered = !!lastAssistant && /\b(?:add|put|place|pin|show|display)\b[^?.]{0,120}\b(?:on|to|in|into|onto)\b[^?.]{0,80}\b(?:dashboards?|enrol?lment|forms?|capture|page)\b[^?.]{0,80}\?/i.test(messageText(lastAssistant));
  const agreed = /^\s*(?:yes|yep|yeah|ok(?:ay)?|sure|please|go\s+ahead|do\s+it|add\s+it|put\s+it|place\s+it)\b/i.test(lastUserText || '') || /\bdashboard\b/i.test(lastUserText || '');
  return offered && agreed;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function placeCustomAppPlugin(args) {
  const target = args.target;
  if (!PLACEMENT_TARGETS.includes(target)) return { _error: `target must be one of: ${PLACEMENT_TARGETS.join(', ')}.` };
  if (!placementWasRequested()) {
    return {
      _error: 'Not placed: the user has not asked for this plugin to be put on a dashboard or in Capture.',
      _hint: 'Installing is not placing. Tell the user it is installed, and ASK where they want it (which dashboard, or which Capture page / form). Call place after they answer. Do not route around this with manage_dashboards (it applies the same rule), and never create a dashboard nobody asked for.',
      _awaiting_approval: true,
    };
  }
  const pa = await placementApp(args.key);
  if (pa._error) return pa;
  const { summary, pluginType, source } = pa;
  const appName = summary.name;

  if (target === 'dashboard') {
    if (pluginType !== 'DASHBOARD') return { _error: `"${args.key}" is a ${pluginType || 'non-dashboard'} plugin; only DASHBOARD plugins go on dashboards.` };
    const gate = requireWriteAuth('manage_custom_app', 'place', { key: args.key, target, dashboard_id: args.dashboard_id || null });
    if (gate) return gate;
    const item = { type: 'APP', app_key: args.key };
    if (Number.isFinite(Number(args.width))) item.width = Number(args.width);
    if (Number.isFinite(Number(args.height))) item.height = Number(args.height);
    let r;
    if (args.dashboard_id) {
      r = await executeManageDashboards({ action: 'add_items', dashboard_id: args.dashboard_id, items: [item], skip_backup: args.skip_backup });
    } else if (args.dashboard_name) {
      r = await executeManageDashboards({ action: 'create_dashboard', dashboard: { name: String(args.dashboard_name) }, items: [item] });
    } else {
      return { _error: 'Pass dashboard_id (add to an existing dashboard) or dashboard_name (create a new dashboard with the plugin).' };
    }
    if (r && r._error) return r;
    const dashboardId = args.dashboard_id || (r && (r.dashboard_id || r.id || (r.dashboard && r.dashboard.id)));
    return {
      success: true,
      action: 'place',
      key: args.key,
      target,
      dashboard: r,
      where_to_find: dashboardId ? `Open ${dhis2.baseUrl}/dhis-web-dashboard/#/${dashboardId} — the plugin "${appName}" is on it.` : `Open the dashboard "${args.dashboard_name}" in the Dashboard app.`,
    };
  }

  // Capture targets
  if (pluginType !== 'CAPTURE') return { _error: `"${args.key}" is a ${pluginType || 'non-Capture'} plugin; only CAPTURE plugins go into the Capture app.`, _hint: target === 'dashboard' ? undefined : 'Rebuild it with plugin_type "CAPTURE" (update), or place it on a dashboard.' };
  const src = await loadCustomAppSource(args.key, pa.app);
  const pluginCode = src && !src._error ? `${src.sources['plugin.jsx'] || ''}\n${src.sources['shared.jsx'] || ''}` : '';
  const warnings = [];

  if (CAPTURE_LAYOUT_TARGETS[target]) {
    if (!args.program_id) return { _error: `target "${target}" needs program_id (the tracker program whose ${target.replace(/_/g, ' ')} page shows the plugin).` };
    const program = await captureProgram(args.program_id);
    if (program._error) return program;
    if (pluginCode && /\bsetFieldValue\b/.test(pluginCode) && !/\b(?:enrollmentId|teiId)\b/.test(pluginCode)) {
      warnings.push('This looks like a form-field plugin (it calls setFieldValue); on an enrollment page it gets no form values — place it with target "form" instead.');
    }
    const dsKey = CAPTURE_LAYOUT_TARGETS[target];
    const column = args.column === 'left' ? 'left' : 'right';
    const position = args.position === 'bottom' ? 'bottom' : 'top';
    const gate = requireWriteAuth('manage_custom_app', 'place', { key: args.key, target, program_id: program.id });
    if (gate) return gate;
    const cfg = await readCaptureConfig(dsKey);
    if (cfg._error) return cfg;
    const current = cfg.value[program.id];
    const startedFromDefault = !current;
    const { layout, already } = layoutWithPlugin(current || captureDefaultLayout(dsKey), args.key, source, column, position);
    if (already) {
      return { success: true, action: 'place', key: args.key, target, program_id: program.id, already_placed: true, _note: `"${appName}" is already on the ${target.replace(/_/g, ' ')} page of ${program.displayName}.` };
    }
    let backup = null;
    if (args.skip_backup !== true) {
      backup = await backupCaptureConfig(dsKey, cfg.exists, cfg.value, 'place', `place ${args.key} on ${target} of ${program.displayName}`);
      if (backup._error) return backup;
    }
    const next = { ...cloneJson(cfg.value), [program.id]: layout };
    const w = await writeCaptureConfig(dsKey, next, cfg.exists);
    if (w._error) return { ...w, backup };
    return {
      success: true,
      action: 'place',
      key: args.key,
      target,
      program_id: program.id,
      program_name: program.displayName,
      column,
      position,
      started_from_capture_default: startedFromDefault,
      datastore_key: `${CAPTURE_NAMESPACE}/${dsKey}`,
      backup: backup ? { key: backup.backup_key, restore_hint: `manage_backups(action="restore", backup_key="${backup.backup_key}")` } : { skipped: true },
      warnings: warnings.length ? warnings : undefined,
      where_to_find: `Capture → ${program.displayName} → open an enrollment${target === 'enrollment_dashboard' ? '' : target === 'enrollment_event_new' ? ' → add an event' : ' → open an event'}: "${appName}" is in the ${column} column. Capture reads its layout when it loads — reload the Capture tab once.`,
    };
  }

  // target === 'form'
  if (!!args.program_stage_id === !!args.program_id) {
    return { _error: 'target "form" needs exactly one of program_stage_id (the stage\'s event form) or program_id (the program\'s registration form).' };
  }
  const ctx = await captureFormContext(args);
  if (ctx._error) return ctx;
  const fieldMap = normalizeFieldMap(args.field_map);
  if (fieldMap === null) return { _error: 'field_map must be a list of { plugin_field, field_id } objects.' };
  const fmBad = fieldMapProblem(fieldMap, ctx);
  if (fmBad) return fmBad;
  const aliases = pluginFieldAliasProblems(pluginCode, fieldMap);
  if (aliases.errors.length) return { _error: aliases.errors.join(' '), _hint: 'Make field_map cover every alias the plugin writes (or change the plugin with update first).' };
  warnings.push(...aliases.warnings);
  if (pluginCode && !/\b(?:values|setFieldValue)\b/.test(pluginCode)) {
    warnings.push('This plugin neither reads values nor calls setFieldValue — a form-field plugin gets its data through those props.');
  }
  const gate = requireWriteAuth('manage_custom_app', 'place', { key: args.key, target, context_id: ctx.id });
  if (gate) return gate;
  const cfg = await readCaptureConfig(CAPTURE_FORMS_KEY);
  if (cfg._error) return cfg;
  const current = cfg.value[ctx.id];
  const startedFromDefault = !Array.isArray(current);
  const built = formWithPlugin(startedFromDefault ? defaultCaptureFormConfig(ctx) : current, ctx, {
    key: args.key,
    name: appName,
    source,
    fieldMap,
    section: args.section || null,
    sectionName: args.section_name || null,
    position: args.position === 'top' ? 'top' : 'bottom',
  });
  if (built._error) return built;
  let backup = null;
  if (args.skip_backup !== true) {
    backup = await backupCaptureConfig(CAPTURE_FORMS_KEY, cfg.exists, cfg.value, 'place', `place ${args.key} in the form of ${ctx.name}`);
    if (backup._error) return backup;
  }
  const next = { ...cloneJson(cfg.value), [ctx.id]: built.sections };
  const w = await writeCaptureConfig(CAPTURE_FORMS_KEY, next, cfg.exists);
  if (w._error) return { ...w, backup };
  return {
    success: true,
    action: 'place',
    key: args.key,
    target,
    form: { context_id: ctx.id, context: ctx.kind, name: ctx.name, program_id: ctx.programId, program_name: ctx.programName, custom_html_form: ctx.customForm || undefined },
    field_map: fieldMap.map((f) => ({ plugin_field: f.plugin_field, field_id: f.field_id, field_name: (ctx.fields[f.field_id] || {}).displayName, value_type: (ctx.fields[f.field_id] || {}).valueType, replaced_in_form: f.replace_field })),
    started_from_capture_default: startedFromDefault,
    datastore_key: `${CAPTURE_NAMESPACE}/${CAPTURE_FORMS_KEY}`,
    backup: backup ? { key: backup.backup_key, restore_hint: `manage_backups(action="restore", backup_key="${backup.backup_key}")` } : { skipped: true },
    warnings: warnings.length ? warnings : undefined,
    where_to_find: ctx.kind === 'program_stage'
      ? `Capture → ${ctx.programName} → open an enrollment → add a "${ctx.name}" event: "${appName}" is in the form. Reload the Capture tab once (it reads form configs when it loads).`
      : `Capture → ${ctx.programName} → register / enroll a person: "${appName}" is in the registration form. Reload the Capture tab once.`,
  };
}

// Removes the app from dashboards and Capture pages/forms. A Capture entry left
// identical to Capture's default is removed entirely, so the page goes back to
// following Capture's own default. Filters: target, program_id,
// program_stage_id, dashboard_id.
async function unplaceCustomAppPlugin(args, opts = {}) {
  const key = args.key;
  if (!opts.internal) {
    if (!key) return { _error: 'Pass key (the plugin to remove).' };
    const problem = customAppKeyProblem(key);
    if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
    const apps = await listInstalledApps();
    if (apps._error) return apps;
    const app = apps.find((a) => a.key === key);
    // An uninstalled ai- key may still have stale placements to clean up.
    if (app && !isAssistantBuiltApp(app)) return { _error: `Refused: "${key}" was not built by the DHIS2 AI Assistant.`, _refused_not_managed: true };
    const gate = requireWriteAuth('manage_custom_app', 'unplace', { key, target: args.target || 'all' });
    if (gate) return gate;
  }
  const removed = [];
  const backups = [];
  const memo = {};
  const want = (t) => !args.target || args.target === t;

  if (want('dashboard')) {
    const dash = await safeDhis2Fetch(`dashboards?filter=${encodeURIComponent(`dashboardItems.appKey:eq:${key}`)}&fields=id,displayName,dashboardItems[id,appKey]&paging=false`, { noTruncate: true });
    if (dash && dash._error) return { _error: `Could not list dashboards: ${dash._error}` };
    for (const d of (dash && dash.dashboards) || []) {
      if (args.dashboard_id && d.id !== args.dashboard_id) continue;
      for (const item of (d.dashboardItems || []).filter((i) => i.appKey === key)) {
        const r = await executeManageDashboards({ action: 'remove_item', dashboard_id: d.id, item_id: item.id, skip_backup: args.skip_backup });
        if (r && r._error) return { _error: `Could not remove the plugin from dashboard "${d.displayName}": ${r._error}`, removed };
        removed.push({ target: 'dashboard', dashboard_id: d.id, dashboard_name: d.displayName, item_id: item.id });
      }
    }
  }
  for (const [target, dsKey] of Object.entries(CAPTURE_LAYOUT_TARGETS)) {
    if (!want(target)) continue;
    const cfg = await readCaptureConfig(dsKey, memo);
    if (cfg._error) return { ...cfg, removed };
    const next = cloneJson(cfg.value);
    const touched = [];
    for (const [programId, layout] of Object.entries(cfg.value)) {
      if (args.program_id && programId !== args.program_id) continue;
      const r = layoutWithoutPlugin(layout, key);
      if (!r.removed) continue;
      if (isDefaultCaptureLayout(r.layout, dsKey)) delete next[programId];
      else next[programId] = r.layout;
      touched.push({ target, program_id: programId, entry_removed: !next[programId] });
    }
    if (!touched.length) continue;
    if (args.skip_backup !== true) {
      const b = await backupCaptureConfig(dsKey, cfg.exists, cfg.value, 'unplace', `unplace ${key}`);
      if (b._error) return { ...b, removed };
      backups.push(b.backup_key);
    }
    const w = await writeCaptureConfig(dsKey, next, cfg.exists);
    if (w._error) return { ...w, removed, backups };
    removed.push(...touched);
  }
  if (want('form')) {
    const cfg = await readCaptureConfig(CAPTURE_FORMS_KEY, memo);
    if (cfg._error) return { ...cfg, removed };
    const next = cloneJson(cfg.value);
    const touched = [];
    for (const [ctxId, sections] of Object.entries(cfg.value)) {
      if (args.program_stage_id && ctxId !== args.program_stage_id) continue;
      if (args.program_id && !args.program_stage_id && ctxId !== args.program_id) continue;
      const r = formWithoutPlugin(sections, key);
      if (!r.removed) continue;
      // Left exactly as Capture would draw it without a config → drop the
      // entry so the form follows the metadata again.
      const ctx = await captureFormContext(await formContextArgs(ctxId));
      const entryRemoved = !ctx._error && canonicalJson(r.sections) === canonicalJson(defaultCaptureFormConfig(ctx));
      if (entryRemoved) delete next[ctxId];
      else next[ctxId] = r.sections;
      touched.push({ target: 'form', context_id: ctxId, entry_removed: entryRemoved });
    }
    if (touched.length) {
      if (args.skip_backup !== true) {
        const b = await backupCaptureConfig(CAPTURE_FORMS_KEY, cfg.exists, cfg.value, 'unplace', `unplace ${key}`);
        if (b._error) return { ...b, removed };
        backups.push(b.backup_key);
      }
      const w = await writeCaptureConfig(CAPTURE_FORMS_KEY, next, cfg.exists);
      if (w._error) return { ...w, removed, backups };
      removed.push(...touched);
    }
  }
  return {
    success: true,
    action: 'unplace',
    key,
    removed,
    backups: backups.length ? backups : undefined,
    _note: !removed.length
      ? 'The plugin was not placed anywhere matching these filters.'
      : removed.some((r) => r.target !== 'dashboard') ? 'Reload the Capture tab to see the change.' : undefined,
  };
}

// A dataEntryForms key is a program stage or a program id — find out which.
async function formContextArgs(ctxId) {
  const st = await safeDhis2Fetch(`programStages?filter=id:eq:${ctxId}&fields=id&paging=false`, { noTruncate: true });
  if (st && !st._error && Array.isArray(st.programStages) && st.programStages.length) return { program_stage_id: ctxId };
  return { program_id: ctxId };
}

async function executeCustomAppPlacement(args) {
  if (args.action === 'placements') {
    if (!args.key) return { _error: 'Pass key.' };
    const problem = customAppKeyProblem(args.key);
    if (problem) return { _error: `Refused: ${problem}.`, _refused_not_managed: true };
    const list = await listPluginPlacements(args.key);
    if (list._error) return list;
    const total = list.dashboards.length + list.capture_pages.length + list.forms.length;
    return { key: args.key, total, ...list, _note: total ? undefined : 'Not placed anywhere yet.' };
  }
  if (args.action === 'place') return placeCustomAppPlugin(args);
  return unplaceCustomAppPlugin(args);
}
