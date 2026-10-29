// Capture enrollment widget: every value flagged in any stage of the
// enrollment, as red warning cards. Reads the events' flag storage field
// (__FLAG_DE__ — the scenario substitutes the data element it creates) and
// refetches because Capture shows the dashboard before an event save lands.
const { useEffect } = React;
const { Provider, useDataQuery } = D2Runtime;
const { Button, CircularLoader, NoticeBox } = D2UI;

const FLAG_DE = '__FLAG_DE__';
const EVENTS = {
  ev: {
    resource: 'tracker/events',
    params: ({ enrollment }) => ({ enrollments: enrollment, order: 'occurredAt:desc', pageSize: 100, fields: 'event,programStage,occurredAt,dataValues[dataElement,value]' }),
  },
  program: {
    resource: 'programs',
    id: ({ program }) => program,
    params: { fields: 'programStages[id,displayName]' },
  },
};

function parseFlags(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function Flags({ enrollmentId, programId }) {
  const { data, loading, error, refetch } = useDataQuery(EVENTS, { variables: { enrollment: enrollmentId, program: programId } });
  useEffect(() => {
    const again = () => refetch({ enrollment: enrollmentId, program: programId });
    // A save Capture just started can take seconds to land: re-read a few times.
    const timers = [2000, 5000, 10000, 20000].map((ms) => setTimeout(again, ms));
    const onVisible = () => { if (document.visibilityState === 'visible') again(); };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', onVisible); };
  }, [enrollmentId, programId]);
  if (loading && !data) return <CircularLoader small />;
  if (error) return <NoticeBox error title="Could not load flagged values">{error.message}</NoticeBox>;
  const stageName = Object.fromEntries(((data.program && data.program.programStages) || []).map((s) => [s.id, s.displayName]));
  const cards = [];
  for (const ev of data.ev.events || []) {
    const store = (ev.dataValues || []).find((dv) => dv.dataElement === FLAG_DE);
    for (const f of parseFlags(store && store.value)) cards.push({ key: `${ev.event}-${f.id}`, ...f, stage: stageName[ev.programStage] || 'Stage', date: String(ev.occurredAt || '').slice(0, 10) });
  }
  return (
    <div>
      {cards.length ? cards.map((c) => (
        <div key={c.key} style={{ borderInlineStart: '4px solid var(--colors-red600)', background: 'var(--colors-red050)', borderRadius: 3, padding: '6px 10px', marginBottom: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--colors-red800)', overflowWrap: 'anywhere' }}>{c.label}: {c.value || 'no value'}</div>
          <div style={{ fontSize: 12, color: 'var(--colors-grey700)' }}>{c.stage} · {c.date}</div>
        </div>
      )) : <div style={{ fontSize: 13, color: 'var(--colors-grey700)' }}>No flagged values in this enrollment.</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
        <span style={{ flex: 1, fontSize: 11, color: 'var(--colors-grey600)' }}>Showing saved events</span>
        <Button small onClick={() => refetch({ enrollment: enrollmentId, program: programId })}>Refresh</Button>
      </div>
    </div>
  );
}

function Plugin({ enrollmentId, programId, setPluginHeight }) {
  useEffect(() => {
    const root = document.getElementById('root');
    if (typeof setPluginHeight !== 'function') return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(root.getBoundingClientRect().height)));
    ro.observe(root);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return (
    <div style={{ background: '#fff', border: '1px solid var(--colors-grey400)', borderRadius: 3 }}>
      <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', padding: '8px 8px 8px 12px', fontSize: 15, fontWeight: 500, color: 'var(--colors-grey800)' }}>Flagged values</div>
      <div style={{ padding: '0 12px 12px' }}>
        {enrollmentId && programId ? <Flags enrollmentId={enrollmentId} programId={programId} /> : <NoticeBox title="Open an enrollment">Flagged values appear here.</NoticeBox>}
      </div>
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Provider config={CONFIG} plugin parentAlertsAdd={props.alertsAdd}><Plugin {...props} /></Provider>);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
