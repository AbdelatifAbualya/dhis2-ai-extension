// Scenario 2 — KPI dashboard plugin (plugin_type DASHBOARD).
// Four KPI tiles from analytics that follow the dashboard ou / pe filters.
// IDs are real metadata on the test instance (WQ indicators + data element,
// Malaria program events).
const { useRef, useEffect } = React;
const { Provider, useDataQuery } = D2Runtime;
const { CircularLoader, NoticeBox } = D2UI;

const TITLE = 'Water quality KPIs';
const TILES = [
  { id: 'KBYLkbgmzBN', label: 'Non-compliance rate', suffix: '%' },
  { id: 'Eoof9sGAqcT', label: 'Sample rejection rate', suffix: '%' },
  { id: 'QUZ9qYLWPCU', label: 'Planned samples', suffix: '' },
  { id: 'l0NXObayGhi', label: 'Malaria events', suffix: '', events: true },
];
const DX = TILES.filter((t) => !t.events).map((t) => t.id).join(';');
const EVENT_PROGRAM = TILES.find((t) => t.events).id;

const KPIS = {
  values: {
    resource: 'analytics',
    params: ({ ou, pe }) => ({ dimension: [`dx:${DX}`], filter: [`ou:${ou}`, `pe:${pe}`], displayProperty: 'NAME' }),
  },
  events: {
    resource: `analytics/events/aggregate/${EVENT_PROGRAM}`,
    params: ({ ou, pe }) => ({ filter: [`ou:${ou}`, `pe:${pe}`], outputType: 'EVENT' }),
  },
};

function readValues(response) {
  const col = (name) => response.headers.findIndex((h) => h.name === name);
  const dx = col('dx');
  const value = col('value');
  const out = {};
  for (const row of response.rows) out[row[dx]] = Number(row[value]);
  return out;
}

function Tile({ label, value, suffix }) {
  const has = value != null && !Number.isNaN(value);
  return (
    <div style={{
      background: '#fff', border: '1px solid var(--colors-grey300)', borderRadius: 4, padding: '10px 12px',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', minWidth: 0,
    }}>
      <div style={{ fontSize: 13, color: 'var(--colors-grey700)', lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontSize: has ? 'clamp(24px, 10vmin, 44px)' : 20, fontWeight: 500, color: has ? 'var(--colors-grey900)' : 'var(--colors-grey500)', marginTop: 6, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
        {has ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}` : 'No data'}
      </div>
    </div>
  );
}

function Kpis({ ou, pe, ouName, peName }) {
  const { loading, error, data } = useDataQuery(KPIS, { variables: { ou, pe } });
  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CircularLoader small /></div>;
  if (error) return <NoticeBox error title="Could not load the KPIs">{error.message}</NoticeBox>;
  const values = readValues(data.values);
  const evRows = data.events.rows;
  const events = evRows.length ? Number(evRows[0][evRows[0].length - 1]) : null;
  const shown = TILES.map((t) => ({ ...t, value: t.events ? events : values[t.id] }));
  // Event counts are 0 (not missing) when nothing was recorded.
  const empty = shown.every((t) => t.value == null || (t.events && t.value === 0));
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--colors-grey700)', marginBottom: 8 }}>
        {TITLE} · {ouName} · {peName}
      </div>
      {empty ? (
        <NoticeBox title="No data">There is no data for {ouName} ({peName}). Try another organisation unit or period.</NoticeBox>
      ) : (
        <div style={{ flex: 1, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gridAutoRows: '1fr' }}>
          {shown.map((t) => <Tile key={t.id} label={t.label} value={t.value} suffix={t.suffix} />)}
        </div>
      )}
    </>
  );
}

function Plugin({ dashboardItemFilters = {}, setPluginHeight }) {
  const ouF = dashboardItemFilters.ou || [];
  const peF = dashboardItemFilters.pe || [];
  const ou = ouF.map((o) => o.id).join(';') || 'USER_ORGUNIT';
  const pe = peF.map((p) => p.id).join(';') || 'THIS_YEAR';
  const ouName = ouF.map((o) => o.name).join(', ') || 'Your organisation units';
  const peName = peF.map((p) => p.name).join(', ') || 'This year';
  const ref = useRef(null);
  useEffect(() => {
    if (typeof setPluginHeight !== 'function' || !ref.current) return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(ref.current.scrollHeight)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return (
    <div ref={ref} style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 10, boxSizing: 'border-box', background: 'var(--colors-grey050)' }}>
      <Kpis key={`${ou}|${pe}`} ou={ou} pe={pe} ouName={ouName} peName={peName} />
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
// plugin + parentAlertsAdd: useAlert() messages are shown by the dashboard.
const render = (props) => root.render(
  <Provider config={CONFIG} plugin parentAlertsAdd={props.alertsAdd}>
    <Plugin {...props} />
  </Provider>
);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
