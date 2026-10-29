// Scenario 4 — shared code for the "indicator widget" app + plugin.
// Loaded before app.js / plugin.js: these top-level names are visible in both.
const NS = D2_APP_CONFIG.namespace;

// One saved settings entry per dashboard item: dataStore/<ns>/<dashboardItemId>.
// Read through the query API — HTTP 200 with entries [] when nothing is saved
// yet (a direct GET of the key would be a 404 on first use).
const ITEM_SETTINGS = {
  s: {
    resource: `dataStore/${NS}`,
    params: ({ id }) => ({ fields: '.', filter: `_:eq:${id}` }),
  },
};
const ALL_SETTINGS = {
  s: { resource: `dataStore/${NS}`, params: { fields: '.', pageSize: 100 } },
};

function formatSavedAt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
