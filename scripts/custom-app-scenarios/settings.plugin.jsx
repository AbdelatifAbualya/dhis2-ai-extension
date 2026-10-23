// Scenario 4 — plugin: shows one indicator chosen per dashboard item.
// Edit mode = settings view (pick the indicator, saved per dashboardItemId).
const { useState, useRef, useEffect } = React;
const { Provider, useDataQuery, useDataEngine, useAlert } = D2Runtime;
const { CircularLoader, NoticeBox, SingleSelectField, SingleSelectOption, Button } = D2UI;

const INDICATORS = {
  list: { resource: 'indicators', params: { fields: 'id,displayName', order: 'displayName:asc', paging: false } },
};
const VALUE = {
  a: {
    resource: 'analytics',
    params: ({ dx, ou, pe }) => ({ dimension: [`dx:${dx}`], filter: [`ou:${ou}`, `pe:${pe}`] }),
  },
};

function Settings({ itemId, saved, onSaved }) {
  const engine = useDataEngine();
  const { show } = useAlert(({ msg }) => msg, ({ ok }) => (ok ? { success: true } : { critical: true }));
  const { loading, error, data } = useDataQuery(INDICATORS);
  const [picked, setPicked] = useState(saved ? saved.indicatorId : '');
  const [state, setState] = useState(null);
  if (loading) return <CircularLoader small />;
  if (error) return <NoticeBox error title="Could not load indicators">{error.message}</NoticeBox>;
  const options = data.list.indicators;
  const save = async () => {
    const ind = options.find((o) => o.id === picked);
    setState('saving');
    try {
      await engine.mutate({
        resource: `dataStore/${NS}/${itemId}`,
        type: saved ? 'update' : 'create',
        data: { indicatorId: ind.id, indicatorName: ind.displayName, savedAt: new Date().toISOString() },
      });
      setState('saved');
      show({ msg: `Widget will show ${ind.displayName}`, ok: true });
      onSaved();
    } catch (e) {
      setState(`error:${e.message}`);
      show({ msg: `Could not save the widget settings: ${e.message}`, ok: false });
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420 }}>
      <div style={{ fontSize: 14, fontWeight: 500 }}>Widget settings</div>
      <SingleSelectField
        label="Indicator to show"
        selected={picked || undefined}
        onChange={({ selected }) => { setPicked(selected); setState(null); }}
        filterable
        noMatchText="No indicator matches"
        placeholder="Choose an indicator"
        dense
      >
        {options.map((o) => <SingleSelectOption key={o.id} value={o.id} label={o.displayName} />)}
      </SingleSelectField>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button primary small disabled={!picked || state === 'saving'} loading={state === 'saving'} onClick={save}>Save settings</Button>
        {state === 'saved' && <span style={{ color: 'var(--colors-green700)', fontSize: 13 }}>Saved</span>}
      </div>
      {state && state.startsWith('error:') && <NoticeBox error title="Could not save">{state.slice(6)}</NoticeBox>}
    </div>
  );
}

function Value({ settings, ou, pe, ouName, peName }) {
  const { loading, error, data } = useDataQuery(VALUE, { variables: { dx: settings.indicatorId, ou, pe } });
  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CircularLoader small /></div>;
  if (error) return <NoticeBox error title="Could not load the indicator">{error.message}</NoticeBox>;
  const r = data.a;
  const vi = r.headers.findIndex((h) => h.name === 'value');
  const value = r.rows.length ? Number(r.rows[0][vi]) : null;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: 6 }}>
      <div style={{ fontSize: 13, color: 'var(--colors-grey700)' }}>{settings.indicatorName}</div>
      <div data-test="indicator-value" style={{ fontSize: value == null ? 20 : 'clamp(28px, 12vmin, 52px)', fontWeight: 500, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', color: value == null ? 'var(--colors-grey500)' : 'var(--colors-grey900)' }}>
        {value == null ? 'No data' : value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
      </div>
      <div style={{ fontSize: 12, color: 'var(--colors-grey600)' }}>{ouName} · {peName}</div>
    </div>
  );
}

function Widget({ itemId, mode, ou, pe, ouName, peName }) {
  const { loading, error, data, refetch } = useDataQuery(ITEM_SETTINGS, { variables: { id: itemId } });
  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CircularLoader small /></div>;
  if (error) return <NoticeBox error title="Could not load the widget settings">{error.message}</NoticeBox>;
  const entry = data.s.entries[0];
  const saved = entry ? entry.value : null;
  if (mode === 'edit') return <Settings itemId={itemId} saved={saved} onSaved={() => refetch()} />;
  if (!saved) {
    return (
      <NoticeBox title="Not configured yet">
        Edit the dashboard to choose the indicator this widget shows.
      </NoticeBox>
    );
  }
  return <Value key={`${saved.indicatorId}|${ou}|${pe}`} settings={saved} ou={ou} pe={pe} ouName={ouName} peName={peName} />;
}

function Plugin({ dashboardItemId, dashboardMode, dashboardItemFilters = {}, setPluginHeight }) {
  const ouF = dashboardItemFilters.ou || [];
  const peF = dashboardItemFilters.pe || [];
  const ou = ouF.map((o) => o.id).join(';') || 'USER_ORGUNIT';
  const pe = peF.map((p) => p.id).join(';') || 'THIS_YEAR';
  const ref = useRef(null);
  useEffect(() => {
    if (typeof setPluginHeight !== 'function' || !ref.current) return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(ref.current.scrollHeight)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return (
    <div ref={ref} style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box' }}>
      {dashboardItemId
        ? <Widget itemId={dashboardItemId} mode={dashboardMode} ou={ou} pe={pe}
            ouName={ouF.map((o) => o.name).join(', ') || 'Your organisation units'}
            peName={peF.map((p) => p.name).join(', ') || 'This year'} />
        : <NoticeBox title="Dashboard widget">Add this plugin to a dashboard to use it.</NoticeBox>}
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
