/*
 * Canonical presentation metadata for tool activity.
 *
 * background.js uses resultLabel after a tool completes; panel.js uses the
 * same record for the progress card. Keeping this in one classic-script module
 * prevents new tools from silently falling back to generic or mismatched UI.
 */
(function exposeDhis2ToolCatalog(root, factory) {
  'use strict';

  const catalog = factory();
  root.Dhis2ToolCatalog = catalog;
  if (typeof module === 'object' && module.exports) module.exports = catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const entries = {
    dhis2_query: ['tool-icon-api', '\u{1F50D}', 'Querying DHIS2 API', 'Processing API response'],
    count_records: ['tool-icon-count', '\u{1F522}', 'Counting records', 'Analyzing count results'],
    get_event_analytics: ['tool-icon-analytics', '\u{1F4C8}', 'Fetching analytics', 'Interpreting analytics data'],
    get_program_info: ['tool-icon-info', '\u{2139}\uFE0F', 'Loading program info', 'Reviewing program structure'],
    get_program_recent_changes: ['tool-icon-info', '\u{1F4DD}', 'Loading recent changes', 'Reviewing recent program changes'],
    search_metadata: ['tool-icon-search', '\u{1F50E}', 'Searching metadata', 'Reviewing search results'],
    resolve_option_codes: ['tool-icon-search', '\u{1F3F7}', 'Resolving codes to names', 'Resolving display names'],
    detect_enrollment_abnormalities: ['tool-icon-warning', '\u26A0\uFE0F', 'Scanning abnormalities', 'Analyzing abnormalities'],
    cross_stage_entity_intersection: ['tool-icon-analytics', '\u{1F517}', 'Intersecting conditions', 'Matching conditions'],
    line_listing_guide: ['tool-icon-info', '\u{1F5FA}\uFE0F', 'Loading line-listing guide', 'Preparing guidance'],
    get_visualization_details: ['tool-icon-chart', '\u{1F4CA}', 'Loading visualization details', 'Interpreting visualization'],
    get_map_details: ['tool-icon-map', '\u{1F5FA}\uFE0F', 'Loading map details', 'Interpreting map layers'],
    browse_web: ['tool-icon-search', '\u{1F30D}', 'Browsing the web', 'Processing web results'],
    render_chart: ['tool-icon-chart', '\u{1F4CA}', 'Rendering chart', 'Preparing chart'],
    create_metadata: ['tool-icon-create', '\u{1F3D7}\uFE0F', 'Creating metadata', 'Processing metadata creation'],
    architect_metadata: ['tool-icon-architect', '\u{1F9E0}', 'Architecting metadata', 'Reviewing architecture'],
    manage_program_rules: ['tool-icon-info', '\u{1F4CB}', 'Managing program rules', 'Processing program rules'],
    manage_program_indicators: ['tool-icon-analytics', '\u{1F4CF}', 'Managing program indicators', 'Processing program indicators'],
    manage_metadata: ['tool-icon-create', '\u{1F527}', 'Managing metadata', 'Processing metadata changes'],
    manage_program_notifications: ['tool-icon-notification', '\u{1F4E8}', 'Managing program notifications', 'Reviewing notification changes'],
    manage_datasets: ['tool-icon-dataset', '\u{1F4D1}', 'Managing datasets', 'Reviewing dataset changes'],
    manage_custom_forms: ['tool-icon-create', '\u{1F4DD}', 'Designing custom form', 'Reviewing custom form changes'],
    manage_custom_translations: ['tool-icon-create', '\u{1F310}', 'Managing custom translations', 'Reviewing translation changes'],
    manage_growth_chart_plugin: ['tool-icon-create', '\u{1F4C8}', 'Setting up growth chart plugin', 'Reviewing growth chart setup'],
    manage_validation_rules: ['tool-icon-info', '\u{2705}', 'Managing validation rules', 'Reviewing validation rules'],
    manage_org_units: ['tool-icon-create', '\u{1F3E2}', 'Managing org units', 'Reviewing organisation-unit changes'],
    manage_indicators: ['tool-icon-create', '\u{1F4CA}', 'Managing indicators', 'Reviewing indicator changes'],
    manage_option_sets: ['tool-icon-create', '\u{1F5C2}', 'Managing option sets', 'Reviewing option-set changes'],
    manage_legend_sets: ['tool-icon-create', '\u{1F3A8}', 'Managing legend sets', 'Reviewing legend-set changes'],
    manage_dashboards: ['tool-icon-create', '\u{1F4CA}', 'Building dashboards', 'Reviewing dashboard changes'],
    manage_maps: ['tool-icon-create', '\u{1F5FA}', 'Building maps', 'Reviewing map changes'],
    manage_backups: ['tool-icon-backup', '\u{1F4BE}', 'Managing backups', 'Reviewing backup results'],

    // Internal progress operation, not an LLM-callable tool.
    diagnose_save_error: ['tool-icon-warning', '\u{1F50D}', 'Diagnosing save error', 'Reviewing diagnosis'],
  };

  return Object.freeze(Object.fromEntries(
    Object.entries(entries).map(([name, [iconClass, icon, activeLabel, resultLabel]]) => [
      name,
      Object.freeze({ iconClass, icon, activeLabel, resultLabel }),
    ])
  ));
});
