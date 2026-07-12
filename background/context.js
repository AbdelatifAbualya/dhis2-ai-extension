/*
 * DHIS2 AI Assistant background module: DHIS2 URL context, initialization, active-tab synchronization, and line-listing assets.
 * Loaded synchronously by background.js with importScripts(); classic-script
 * global bindings intentionally preserve the original service-worker runtime.
 */

// ── URL Parsing ──────────────────────────────────────────────────────────────

function extractBaseUrl(url) {
  try {
    const m = url.match(/(https?:\/\/[^/]+(?:\/[^/]+)*?)\/(?:dhis-web-|api\/|apps\/)/);
    if (m) return m[1];
    const u = new URL(url);
    // chrome://, chrome-extension://, about:, file:, devtools:// etc. cannot
    // host a DHIS2 instance and Fetch refuses them anyway. Returning null here
    // stops syncFromTab/initializeFromUrl from issuing the impossible
    // "Fetch API cannot load chrome://.../api/system/info" call when the user
    // briefly focuses chrome://extensions or chrome://newtab.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? `${u.origin}/${parts[0]}` : u.origin;
  } catch { return null; }
}

function extractContext(url) {
  const ctx = {};
  try {
    const u = new URL(url);
    const hash = u.hash;
    // Read identifiers from BOTH location.hash (HashRouter apps like
    // Aggregate Data Entry) AND location.search (BrowserRouter apps and the
    // legacy /dhis-web-dataentry endpoint), so we catch the OU/dataset/period
    // regardless of which router the app uses. Order matters: hash query
    // wins because in HashRouter apps location.search is often stale.
    const sources = [];
    if (hash && hash.includes('?')) sources.push(new URLSearchParams(hash.split('?')[1]));
    sources.push(u.searchParams);
    const trackerKeys = ['programId','orgUnitId','teiId','enrollmentId','stageId','eventId','trackedEntityTypeId'];
    for (const src of sources) {
      for (const k of trackerKeys) {
        if (ctx[k]) continue;
        const v = src.get(k);
        if (v && v !== 'null') ctx[k] = v;
      }
    }
    if (hash) {
      const routePath = hash.split('?')[0] || '';
      if (routePath.startsWith('#/')) {
        const firstSeg = decodeURIComponent(routePath.slice(2)).split('/')[0];
        if (firstSeg) ctx.route = firstSeg;
      }
    }
    const apps = {
      'apps/capture':'Capture','dhis-web-capture':'Capture',
      'apps/tracker-capture':'Tracker Capture','dhis-web-tracker-capture':'Tracker Capture',
      'apps/data-entry':'Data Entry','dhis-web-data-entry':'Data Entry','dhis-web-dataentry':'Data Entry',
      'apps/maintenance':'Maintenance','dhis-web-maintenance':'Maintenance',
      'apps/dashboard':'Dashboard','dhis-web-dashboard':'Dashboard',
      'apps/data-visualizer':'Data Visualizer','dhis-web-data-visualizer':'Data Visualizer',
      'apps/aggregate-data-entry':'Aggregate Data Entry','dhis-web-aggregate-data-entry':'Aggregate Data Entry',
      'apps/dataset-report':'Dataset Report','dhis-web-dataset-report':'Dataset Report',
      'apps/reporting':'Reporting',
      'apps/line-listing':'Line Listing','dhis-web-line-listing':'Line Listing',
      'apps/pivot':'Pivot Table','dhis-web-pivot':'Pivot Table',
      'apps/maps':'Maps','dhis-web-maps':'Maps',
    };
    for (const [pat, name] of Object.entries(apps)) {
      if (url.includes(pat)) { ctx.appType = name; break; }
    }

    // Data Visualizer routes often look like: .../apps/data-visualizer#/XGcG2PFIvOU
    // URL-structural positions use the looser hasUidShape — DHIS2 serves these IDs
    // directly, so we don't need the entropy check that guards free-text scans.
    if (ctx.appType === 'Data Visualizer') {
      if (hasUidShape(ctx.route)) ctx.visualizationId = ctx.route;
      if (!ctx.visualizationId && hash) {
        const routePath = hash.split('?')[0] || '';
        const segs = routePath.replace(/^#\/?/, '').split('/').filter(Boolean);
        for (const seg of segs) {
          const s = decodeURIComponent(seg);
          if (hasUidShape(s)) {
            ctx.visualizationId = s;
            break;
          }
        }
      }
      if (!ctx.visualizationId && hash && hash.includes('?')) {
        const p = new URLSearchParams(hash.split('?')[1]);
        const idFromHash = p.get('id') || p.get('visualization');
        if (hasUidShape(idFromHash)) ctx.visualizationId = idFromHash;
      }
      if (!ctx.visualizationId) {
        const idFromQuery = u.searchParams.get('id') || u.searchParams.get('visualization');
        if (hasUidShape(idFromQuery)) ctx.visualizationId = idFromQuery;
      }
    }

    // Maps routes look like: .../apps/maps#/voX07ulo2Bq
    if (ctx.appType === 'Maps') {
      if (hasUidShape(ctx.route)) ctx.mapId = ctx.route;
      if (!ctx.mapId && hash) {
        const routePath = hash.split('?')[0] || '';
        const segs = routePath.replace(/^#\/?/, '').split('/').filter(Boolean);
        for (const seg of segs) {
          const s = decodeURIComponent(seg);
          if (hasUidShape(s)) {
            ctx.mapId = s;
            break;
          }
        }
      }
      if (!ctx.mapId && hash && hash.includes('?')) {
        const p = new URLSearchParams(hash.split('?')[1]);
        const idFromHash = p.get('id') || p.get('map');
        if (hasUidShape(idFromHash)) ctx.mapId = idFromHash;
      }
      if (!ctx.mapId) {
        const idFromQuery = u.searchParams.get('id') || u.searchParams.get('map');
        if (hasUidShape(idFromQuery)) ctx.mapId = idFromQuery;
      }
    }

    // ── Dataset / Aggregate-program detection ────────────────────────────
    // Aggregate "programs" in DHIS2 are dataSets — `programType:WITHOUT_REGISTRATION`
    // is the Event-Program (still tracker schema). Users say "aggregate program"
    // to mean a dataSet, so we surface the dataset UID to the chatbot.
    //
    // URL shapes seen in the wild:
    //   /apps/aggregate-data-entry/#/?dataSetId=<uid>&orgUnitId=<uid>&periodId=...
    //   /dhis-web-data-entry/index.action#... (dataSetId in hash query, sometimes ?ds=)
    //   /apps/dataset-report/#/?ds=<uid> or #/<uid>
    //   /apps/maintenance/#/list/dataSetSection/dataSet/<uid> (edit screen)
    //   /apps/maintenance/#/edit/dataSetSection/dataSet/<uid>
    //   /apps/maintenance/#/list/programSection/program/<uid> (used to detect program edit too)
    const isDatasetApp = ctx.appType === 'Aggregate Data Entry'
      || ctx.appType === 'Data Entry'
      || ctx.appType === 'Dataset Report'
      || ctx.appType === 'Reporting';
    if (isDatasetApp || ctx.appType === 'Maintenance') {
      // sources already covers hash-query + URL search params (set up at the top
      // of this function). Use the same precedence: hash wins.
      // 1. dataSet UID
      for (const src of sources) {
        if (ctx.datasetId) break;
        for (const k of ['dataSetId', 'dataSet', 'ds']) {
          const v = src.get(k);
          if (hasUidShape(v)) { ctx.datasetId = v; break; }
        }
      }
      // 2. periodId (period code like "202604" — not a UID)
      for (const src of sources) {
        if (ctx.periodId) break;
        const pe = src.get('periodId') || src.get('pe') || src.get('period');
        if (pe && pe !== 'null') ctx.periodId = pe;
      }
      // 3. attributeOptionComboSelection — JSON-encoded { categoryId: optionId }
      //    (Aggregate Data Entry app uses this exact key per dhis2/aggregate-data-entry-app.)
      //    Surfaces non-default attribute disaggregation so the chatbot knows
      //    which attribute combo the user is editing.
      for (const src of sources) {
        if (ctx.attributeOptionComboSelection) break;
        const aoc = src.get('attributeOptionComboSelection');
        if (aoc) {
          try {
            const parsed = JSON.parse(aoc);
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
              ctx.attributeOptionComboSelection = parsed;
            }
          } catch {}
        }
      }
      // 4. sectionFilter (UID of the active section in the form)
      for (const src of sources) {
        if (ctx.sectionFilter) break;
        const sf = src.get('sectionFilter');
        if (hasUidShape(sf)) ctx.sectionFilter = sf;
      }
      // 5. Maintenance app: hash route segments after /dataSet/
      //    e.g. #/list/dataSetSection/dataSet/<uid>/section/<uid>
      if (!ctx.datasetId && hash) {
        const routePath = hash.split('?')[0] || '';
        const segs = routePath.replace(/^#\/?/, '').split('/').filter(Boolean);
        for (let i = 0; i < segs.length - 1; i++) {
          if (/^dataset$/i.test(segs[i]) && hasUidShape(decodeURIComponent(segs[i + 1]))) {
            ctx.datasetId = decodeURIComponent(segs[i + 1]);
            ctx.maintainedObjectType = 'dataSet';
            break;
          }
        }
        if (!ctx.programId && ctx.appType === 'Maintenance') {
          for (let i = 0; i < segs.length - 1; i++) {
            if (/^program$/i.test(segs[i]) && hasUidShape(decodeURIComponent(segs[i + 1]))) {
              ctx.programId = decodeURIComponent(segs[i + 1]);
              ctx.maintainedObjectType = 'program';
              break;
            }
          }
        }
      }
    }
  } catch {}
  return ctx;
}

// ── DHIS2 Initialization ─────────────────────────────────────────────────────

// True only if the user has granted host access to this URL's origin. Every
// credentialed DHIS2 fetch is gated on this so we never issue a cross-origin
// request the browser would reject with a noisy CORS error before the user has
// approved that server. Once granted, the same fetch is privileged (no CORS).
async function hasHostPermissionForUrl(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch { return false; }
}

async function initializeFromUrl(url) {
  const baseUrl = extractBaseUrl(url);
  if (!baseUrl) return { error: 'Not a DHIS2 page' };

  // Gate on host permission. The auto-init listeners (tab updates, focus
  // changes, SPA fragment changes) fire on any DHIS2-looking URL; without this
  // guard they'd hit /api/system/info on an origin we have no access to yet and
  // log a CORS error. The side panel surfaces an "Allow access" prompt instead.
  if (!(await hasHostPermissionForUrl(url))) {
    return { error: 'Host access not granted for this server' };
  }

  // Detect a real cross-server switch so we can purge ALL server-tied caches —
  // otherwise the next tool call may reuse program metadata, OU contexts, or
  // per-turn UID/icon registries from the previous instance and probes (e.g.
  // create_program's name-collision check) hit the wrong server.
  const previousBaseUrl = dhis2.baseUrl;
  const baseUrlChanged = !!previousBaseUrl && previousBaseUrl !== baseUrl;
  if (baseUrlChanged) {
    // Conversation history contains server-scoped UIDs too. Reset it together
    // with metadata caches before attempting the new connection, so even a
    // failed login cannot later resurrect identifiers from the old server.
    resetForServerSwitch();
    console.log(`[initializeFromUrl] Server switched: ${previousBaseUrl} → ${baseUrl}. Cleared server-scoped state.`);
  }

  if (dhis2.baseUrl !== baseUrl || !dhis2.connected) {
    try {
      dhis2.baseUrl = baseUrl;
      // `redirect: 'manual'` so a "not logged in" 302 to the login page surfaces as an
      // opaque redirect instead of being followed into a noisy CORS error. Common on the
      // DHIS2 playground: every instance shares one host (so the host permission, granted
      // once, already covers them all) but each instance needs its own login.
      const resp = await fetch(`${baseUrl}/api/system/info`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      if (resp.type === 'opaqueredirect' || resp.status === 0) {
        dhis2.baseUrl = null;
        dhis2.apiVersion = null;
        dhis2.systemInfo = null;
        dhis2.connected = false;
        await saveState();
        return { error: 'Not signed in to this DHIS2 instance. Log in to this server in the tab, then reopen the panel.' };
      }
      if (!resp.ok) throw new Error(resp.status);
      const info = await resp.json();
      dhis2.apiVersion = info.version.split('.')[1];
      dhis2.systemInfo = info;
      dhis2.connected = true;
      dhis2.ouMaxLevel = null;
    } catch {
      if (dhis2.baseUrl === baseUrl) dhis2.baseUrl = null;
      dhis2.apiVersion = null;
      dhis2.systemInfo = null;
      dhis2.connected = false;
      await saveState();
      return { error: 'Could not connect to DHIS2' };
    }
  }

  const ctx = extractContext(url);
  dhis2.pageContext = ctx;

  // Clear stale metadata when navigating away from a program or org unit
  if (!ctx.programId) {
    dhis2.programMetadata = null;
    dhis2.programRulesCount = null;
  }
  if (!ctx.orgUnitId) {
    dhis2.ouContext = null;
  }

  // Resolve event context if needed (also resolve stageId when missing)
  if (ctx.eventId && (!ctx.programId || !ctx.stageId)) {
    try {
      const ev = await dhis2Fetch(apiUrl(
        `tracker/events/${ctx.eventId}?fields=program,programStage,enrollment,trackedEntity`
      ));
      if (!ctx.programId)    ctx.programId = ev.program;
      if (!ctx.stageId)      ctx.stageId = ev.programStage;
      if (!ctx.enrollmentId) ctx.enrollmentId = ev.enrollment;
      if (!ctx.teiId)        ctx.teiId = ev.trackedEntity;
    } catch {}
  }

  // Fetch program metadata
  if (ctx.programId && (!dhis2.programMetadata || dhis2.programMetadata.id !== ctx.programId)) {
    // Never expose the previous program while a replacement fetch is pending
    // or fails. The URL context remains authoritative.
    dhis2.programMetadata = null;
    dhis2.programRulesCount = null;
    try {
      const fields = [
        'id,displayName,description,programType',
        'programStages[id,displayName,description,sortOrder',
          ',programStageSections[id,displayName,sortOrder,dataElements[id]]',
          ',programStageDataElements[compulsory,displayInReports',
            ',dataElement[id,displayName,displayFormName,valueType,description',
              ',optionSetValue,optionSet[id,displayName,options[id,displayName,code]]]]]',
        'programTrackedEntityAttributes[displayInList,searchable,mandatory',
          ',trackedEntityAttribute[id,displayName,displayFormName,valueType,description',
            ',optionSetValue,unique,optionSet[id,displayName,options[id,displayName,code]]]]',
        'programIndicators[id,displayName,description,expression,filter]',
        'trackedEntityType[id,displayName]',
        'categoryCombo[id,displayName,isDefault]',
      ].join(',');
      dhis2.programMetadata = await dhis2Fetch(apiUrl(`programs/${ctx.programId}?fields=${fields}`));
    } catch (e) { console.warn('Metadata fetch failed:', e); }

    // Also get program rules count
    try {
      const rulesResp = await dhis2Fetch(apiUrl(
        `programRules?filter=program.id:eq:${ctx.programId}&paging=true&pageSize=1&totalPages=true&fields=id`
      ));
      dhis2.programRulesCount = rulesResp.pager?.total ?? null;
    } catch { dhis2.programRulesCount = null; }
  }

  // Fetch OU context
  if (ctx.orgUnitId && (!dhis2.ouContext || dhis2.ouContext.id !== ctx.orgUnitId)) {
    // As above, a failed lookup must not leave the old OU attached to the new
    // page context.
    dhis2.ouContext = null;
    try {
      dhis2.ouContext = await dhis2Fetch(apiUrl(
        `organisationUnits/${ctx.orgUnitId}?fields=id,displayName,code,path,level,ancestors[id,displayName,level],children[id,displayName]`
      ));
      await getMaxOuLevel();
      rememberFacilityOu(dhis2.ouContext);
    } catch {}
  }

  // Fetch lightweight visualization context when in Data Visualizer route
  if (ctx.visualizationId && (!dhis2.visualizationContext || dhis2.visualizationContext.id !== ctx.visualizationId)) {
    try {
      const viz = await dhis2Fetch(apiUrl(
        `visualizations/${ctx.visualizationId}.json?fields=id,displayName,name,type,lastUpdated,user[displayName]`
      ));
      dhis2.visualizationContext = {
        id: viz.id,
        name: viz.displayName || viz.name || viz.id,
        type: viz.type || null,
        lastUpdated: viz.lastUpdated || null,
        owner: viz.user?.displayName || null,
      };
    } catch {
      dhis2.visualizationContext = {
        id: ctx.visualizationId,
        name: ctx.visualizationId,
        type: null,
      };
    }
  } else if (!ctx.visualizationId) {
    dhis2.visualizationContext = null;
  }

  // Fetch lightweight map context when in Maps route
  if (ctx.mapId && (!dhis2.mapContext || dhis2.mapContext.id !== ctx.mapId)) {
    try {
      const mapMeta = await dhis2Fetch(apiUrl(
        `maps/${ctx.mapId}.json?fields=id,displayName,name,basemap,longitude,latitude,zoom,lastUpdated,user[displayName],mapViews[id,layer,displayName]`
      ));
      dhis2.mapContext = {
        id: mapMeta.id,
        name: mapMeta.displayName || mapMeta.name || mapMeta.id,
        basemap: mapMeta.basemap || null,
        layerCount: mapMeta.mapViews?.length || 0,
        layers: (mapMeta.mapViews || []).map(mv => ({
          id: mv.id,
          layer: mv.layer,
          name: mv.displayName || mv.layer,
        })),
        lastUpdated: mapMeta.lastUpdated || null,
        owner: mapMeta.user?.displayName || null,
      };
    } catch {
      dhis2.mapContext = {
        id: ctx.mapId,
        name: ctx.mapId,
        layerCount: 0,
        layers: [],
      };
    }
  } else if (!ctx.mapId) {
    dhis2.mapContext = null;
  }

  // Fetch lightweight dataset context when in Data Entry / Aggregate Data Entry /
  // Dataset Report / Maintenance > dataSet. Surfaces the dataset name, period type,
  // form type, DE/section/OU counts so the chatbot can answer "what dataset am I
  // in?" without an extra tool call, and reason about the right inputs for
  // create/update operations.
  if (ctx.datasetId && (!dhis2.datasetContext || dhis2.datasetContext.id !== ctx.datasetId)) {
    try {
      const ds = await dhis2Fetch(apiUrl(
        `dataSets/${ctx.datasetId}.json?fields=id,displayName,name,shortName,periodType,formType,categoryCombo[id,displayName,isDefault],` +
        `openFuturePeriods,expiryDays,timelyDays,renderAsTabs,renderHorizontally,validCompleteOnly,compulsoryFieldsCompleteOnly,` +
        `dataSetElements~size,sections~size,organisationUnits~size,indicators~size,access`
      ));
      dhis2.datasetContext = {
        id: ds.id,
        name: ds.displayName || ds.name || ds.id,
        shortName: ds.shortName || null,
        periodType: ds.periodType || null,
        formType: ds.formType || 'DEFAULT',
        categoryCombo: ds.categoryCombo?.displayName || null,
        categoryComboId: ds.categoryCombo?.id || null,
        isDefaultCombo: !!ds.categoryCombo?.isDefault,
        openFuturePeriods: ds.openFuturePeriods ?? null,
        expiryDays: ds.expiryDays ?? null,
        timelyDays: ds.timelyDays ?? null,
        dataElementsCount: ds.dataSetElements ?? 0,
        sectionsCount: ds.sections ?? 0,
        orgUnitsCount: ds.organisationUnits ?? 0,
        indicatorsCount: ds.indicators ?? 0,
        canRead: !!ds.access?.read,
        canWrite: !!ds.access?.write,
        canWriteData: !!ds.access?.data?.write,
      };
    } catch {
      dhis2.datasetContext = { id: ctx.datasetId, name: ctx.datasetId };
    }
  } else if (!ctx.datasetId) {
    dhis2.datasetContext = null;
  }

  await saveState();
  return { success: true, state: getSerializableState() };
}

// Reconcile the single background context with an active-tab URL. Identity
// changes (including dataset and OU changes) go through initializeFromUrl so
// their metadata caches are refreshed; lightweight changes such as period,
// stage, TEI, or section selection update and persist without extra API calls.
async function performPageContextSync(url) {
  // A queued request may have become stale while an earlier metadata fetch was
  // running. Re-read the authoritative tab at execution time and always sync
  // its newest URL.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.url) url = activeTab.url;

  const freshBaseUrl = extractBaseUrl(url);
  if (!freshBaseUrl) return { error: 'Not a DHIS2 page' };

  const previous = dhis2.pageContext || {};
  const fresh = extractContext(url);
  const preservedStageId = !fresh.stageId
    && fresh.programId
    && fresh.programId === previous.programId
    ? previous.stageId || null
    : null;
  if (preservedStageId) fresh.stageId = preservedStageId;

  const cacheMissing =
    (!!fresh.programId && dhis2.programMetadata?.id !== fresh.programId) ||
    (!!fresh.orgUnitId && dhis2.ouContext?.id !== fresh.orgUnitId) ||
    (!!fresh.datasetId && dhis2.datasetContext?.id !== fresh.datasetId) ||
    (!!fresh.visualizationId && dhis2.visualizationContext?.id !== fresh.visualizationId) ||
    (!!fresh.mapId && dhis2.mapContext?.id !== fresh.mapId);

  if (
    !dhis2.connected ||
    freshBaseUrl !== dhis2.baseUrl ||
    cacheMissing ||
    contextIdentityChanged(previous, fresh)
  ) {
    const result = await initializeFromUrl(url);
    if (result.success && preservedStageId && !dhis2.pageContext?.stageId) {
      dhis2.pageContext.stageId = preservedStageId;
      await saveState();
      return { success: true, state: getSerializableState() };
    }
    return result;
  }

  dhis2.pageContext = fresh;
  await saveState();
  return { success: true, state: getSerializableState() };
}

// SPA navigation, tab activation, and a chat send can all request a refresh at
// nearly the same time. Serialize them so a slower stale request cannot finish
// last and overwrite the newest active-tab context.
let pageContextSyncQueue = Promise.resolve();
function syncPageContextFromUrl(url) {
  const task = pageContextSyncQueue.then(() => performPageContextSync(url));
  pageContextSyncQueue = task.catch(() => {});
  return task;
}

function getSerializableState() {
  return {
    baseUrl: dhis2.baseUrl,
    apiVersion: dhis2.apiVersion,
    version: dhis2.systemInfo?.version,
    pageContext: dhis2.pageContext,
    programName: dhis2.programMetadata?.displayName,
    programId: dhis2.programMetadata?.id,
    programType: dhis2.programMetadata?.programType,
    visualizationId: dhis2.pageContext?.visualizationId || dhis2.visualizationContext?.id || null,
    visualizationName: dhis2.visualizationContext?.name || null,
    visualizationType: dhis2.visualizationContext?.type || null,
    mapId: dhis2.pageContext?.mapId || dhis2.mapContext?.id || null,
    mapName: dhis2.mapContext?.name || null,
    mapLayerCount: dhis2.mapContext?.layerCount || null,
    datasetId: dhis2.pageContext?.datasetId || dhis2.datasetContext?.id || null,
    datasetName: dhis2.datasetContext?.name || null,
    datasetPeriodType: dhis2.datasetContext?.periodType || null,
    datasetFormType: dhis2.datasetContext?.formType || null,
    datasetDataElementsCount: dhis2.datasetContext?.dataElementsCount ?? null,
    datasetSectionsCount: dhis2.datasetContext?.sectionsCount ?? null,
    datasetOrgUnitsCount: dhis2.datasetContext?.orgUnitsCount ?? null,
    datasetCanWriteData: dhis2.datasetContext?.canWriteData ?? null,
    periodId: dhis2.pageContext?.periodId || null,
    attributeOptionComboSelection: dhis2.pageContext?.attributeOptionComboSelection || null,
    sectionFilter: dhis2.pageContext?.sectionFilter || null,
    ouName: dhis2.ouContext?.displayName,
    ouId: dhis2.ouContext?.id,
    ouLevel: dhis2.ouContext?.level,
    ouMaxLevel: dhis2.ouMaxLevel || null,
    lastFacilityOu: dhis2.lastFacilityOu || null,
    ouAncestors: dhis2.ouContext?.ancestors?.map(a => a.displayName),
    stageId: dhis2.pageContext?.stageId || null,
    stageName: (dhis2.pageContext?.stageId && dhis2.programMetadata?.programStages)
      ? (dhis2.programMetadata.programStages.find(s => s.id === dhis2.pageContext.stageId)?.displayName || null)
      : null,
    stagesCount: dhis2.programMetadata?.programStages?.length,
    attributesCount: dhis2.programMetadata?.programTrackedEntityAttributes?.length,
    indicatorsCount: dhis2.programMetadata?.programIndicators?.length,
    programRulesCount: dhis2.programRulesCount,
    trackedEntityType: dhis2.programMetadata?.trackedEntityType?.displayName,
    connected: dhis2.connected,
  };
}

const LINE_LISTING_KEYWORD_ROUTES = Object.freeze({
  'what is line listing': ['B00'],
  'what does this app do': ['B00'],
  purpose: ['B00'],
  start: ['B01'],
  'new line list': ['B01'],
  blank: ['B01'],
  open: ['B01'],
  create: ['B01'],
  begin: ['B01'],
  'from scratch': ['B01'],
  display: ['B02'],
  show: ['B02'],
  column: ['B02'],
  'add data': ['B02'],
  'data element': ['B02'],
  attribute: ['B02'],
  indicator: ['B02'],
  'organisation unit': ['B03'],
  'org unit': ['B03'],
  facility: ['B03'],
  district: ['B03'],
  region: ['B03'],
  hospital: ['B03'],
  level: ['B03'],
  'health center': ['B03'],
  period: ['B04'],
  time: ['B04'],
  date: ['B04'],
  month: ['B04'],
  year: ['B04'],
  quarter: ['B04'],
  'last 12': ['B04'],
  'this year': ['B04'],
  filter: ['B05'],
  condition: ['B05'],
  narrow: ['B05'],
  'only show': ['B05'],
  exclude: ['B05'],
  'greater than': ['B05'],
  equals: ['B05'],
  enrollment: ['B06'],
  'cross-stage': ['B06'],
  'multiple stages': ['B06'],
  'across stages': ['B06'],
  repeat: ['B07'],
  repeatable: ['B07'],
  'multiple visits': ['B07'],
  'repeated event': ['B07'],
  color: ['B08'],
  legend: ['B08'],
  scorecard: ['B08'],
  highlight: ['B08'],
  save: ['B09'],
  download: ['B09'],
  export: ['B09'],
  share: ['B09'],
  csv: ['B09'],
  excel: ['B09'],
  rounding: ['B10'],
  decimal: ['B10'],
  hierarchy: ['B10'],
  'full screen': ['B10'],
  options: ['B10'],
  empty: ['B11'],
  error: ['B11'],
  'not working': ['B11'],
  missing: ['B11'],
  'no data': ['B11'],
  broken: ['B11'],
  'greyed out': ['B11'],
  boolean: ['B13'],
  'data type': ['B13'],
  operator: ['B13'],
  'option set': ['B13'],
});

async function ensureLineListingAssetsLoaded() {
  if (lineListingAssets.loaded && lineListingAssets.toolJson) return true;
  try {
    const [jsonResp, mdResp] = await Promise.all([
      fetch(chrome.runtime.getURL(LINE_LISTING_JSON_PATH)),
      fetch(chrome.runtime.getURL(LINE_LISTING_SYSTEM_PROMPT_PATH)),
    ]);
    if (!jsonResp.ok) throw new Error(`Could not load ${LINE_LISTING_JSON_PATH}`);
    lineListingAssets.toolJson = await jsonResp.json();
    lineListingAssets.systemPromptMd = mdResp.ok ? await mdResp.text() : '';
    lineListingAssets.loaded = true;
    return true;
  } catch (e) {
    console.warn('Line listing assets failed to load:', e);
    return false;
  }
}

function routeLineListingBlocks(userMessage, isScreenshot = false) {
  const msg = String(userMessage || '').toLowerCase();
  const matched = new Set();
  for (const [keyword, blockIds] of Object.entries(LINE_LISTING_KEYWORD_ROUTES)) {
    if (msg.includes(keyword)) {
      for (const id of blockIds) matched.add(id);
    }
  }
  if (isScreenshot) matched.add('B12');
  if (!matched.size) matched.add('B01');
  if (isScreenshot && matched.size === 1 && matched.has('B12')) matched.add('B01');
  if (
    (matched.has('B02') || matched.has('B03') || matched.has('B04')) &&
    (msg.includes('how do i') || msg.includes('i want to') || msg.includes('help me'))
  ) {
    matched.add('B01');
  }
  return [...matched].sort();
}

function loadLineListingBlocks(blockIds) {
  const blocksObj = lineListingAssets.toolJson?.blocks || {};
  return blockIds.map(id => blocksObj[id]).filter(Boolean);
}
