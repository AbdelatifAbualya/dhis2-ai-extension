// Capture enrollment widget: every medication ordered in the Specialized
// Clinics Drug Order stage for the open enrollment. One entry per "Drug N"
// section that has a drug name: the name (option code → displayName), then
// the section's other values on a smaller line.
const { useEffect } = React;
const { Provider, useDataQuery } = D2Runtime;
const { CircularLoader, NoticeBox, Tag } = D2UI;

const STAGE = 'pHbLWI4CaxD';
const META = { stage: { resource: `programStages/${STAGE}`, params: { fields: 'displayName,programStageSections[displayName,sortOrder,dataElements[id,displayFormName,optionSet[id]]]' } } };
const EVENTS = { ev: { resource: 'tracker/events', params: ({ enrollment }) => ({ enrollments: enrollment, programStage: STAGE, order: 'occurredAt:desc', pageSize: 50, fields: 'event,occurredAt,status,dataValues[dataElement,value]' }) } };
const OPTIONS = { os: { resource: 'optionSets', params: ({ ids }) => ({ filter: `id:in:[${ids.join(',')}]`, fields: 'id,options[code,displayName]', paging: false }) } };

function Orders({ enrollment }) {
  const meta = useDataQuery(META);
  const ev = useDataQuery(EVENTS, { variables: { enrollment } });
  const opts = useDataQuery(OPTIONS, { lazy: true });
  const sections = meta.data ? [...meta.data.stage.programStageSections].sort((a, b) => a.sortOrder - b.sortOrder) : [];
  const setIds = [...new Set(sections.flatMap((s) => s.dataElements).filter((d) => d.optionSet).map((d) => d.optionSet.id))];
  useEffect(() => { if (setIds.length) opts.refetch({ ids: setIds }); }, [setIds.join(',')]);
  if (meta.error || ev.error || opts.error) return <NoticeBox error title="Could not load the orders">{(meta.error || ev.error || opts.error).message}</NoticeBox>;
  if (meta.loading || ev.loading || (setIds.length && !opts.data)) return <CircularLoader small />;
  const names = {};
  for (const os of opts.data ? opts.data.os.optionSets : []) for (const o of os.options) names[`${os.id}|${o.code}`] = o.displayName;
  const events = (ev.data.ev.events || ev.data.ev.instances || []).map((e) => {
    const v = Object.fromEntries((e.dataValues || []).map((d) => [d.dataElement, d.value]));
    const drugs = [];
    for (const s of sections) {
      const nameDe = s.dataElements.find((d) => d.optionSet && v[d.id]);
      if (!nameDe) continue;
      const details = s.dataElements.filter((d) => d !== nameDe && v[d.id]).map((d) => `${d.displayFormName} ${v[d.id]}`);
      drugs.push({ key: s.displayName, name: names[`${nameDe.optionSet.id}|${v[nameDe.id]}`] || v[nameDe.id], details: details.join(' · ') });
    }
    return { id: e.event, date: (e.occurredAt || '').slice(0, 10), status: e.status, drugs };
  });
  const withDrugs = events.filter((e) => e.drugs.length);
  const empty = events.length - withDrugs.length;
  const total = withDrugs.reduce((n, e) => n + e.drugs.length, 0);
  if (!withDrugs.length) return <NoticeBox title="No medications ordered yet">{empty ? `${empty} order(s) with nothing recorded yet.` : 'This enrollment has no Specialized Clinics Drug Order events.'}</NoticeBox>;
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--colors-grey700)', marginBottom: 8 }}>{total} medication(s) in {withDrugs.length} order(s){empty ? ` · ${empty} order(s) with nothing recorded yet` : ''}</div>
      {withDrugs.map((e) => (
        <div key={e.id} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <strong style={{ fontSize: 13 }}>{e.date || 'No date'}</strong>
            <Tag positive={e.status === 'COMPLETED'}>{e.status === 'COMPLETED' ? 'Completed' : e.status === 'ACTIVE' ? 'Open' : e.status}</Tag>
          </div>
          {e.drugs.map((d) => (
            <div key={d.key} style={{ padding: '6px 8px', borderBottom: '1px solid var(--colors-grey300)' }}>
              <div style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{d.name}</div>
              {d.details ? <div style={{ fontSize: 12, color: 'var(--colors-grey700)' }}>{d.details}</div> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Plugin({ enrollmentId, setPluginHeight }) {
  useEffect(() => {
    const root = document.getElementById('root');
    if (typeof setPluginHeight !== 'function') return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(root.getBoundingClientRect().height)));
    ro.observe(root);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  // Same card as Capture's own widgets: white, 1px grey400 border, 3px radius,
  // 44px header in 15px/500 grey800.
  return (
    <div style={{ background: 'white', border: '1px solid var(--colors-grey400)', borderRadius: 3 }}>
      <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', padding: '8px 8px 8px 12px', fontWeight: 500, fontSize: 15, color: 'var(--colors-grey800)' }}>Medications ordered</div>
      <div style={{ padding: '0 12px 12px' }}>
        {enrollmentId ? <Orders key={enrollmentId} enrollment={enrollmentId} /> : <NoticeBox title="Open an enrollment">This widget lists the medications of the enrollment that is open in Capture.</NoticeBox>}
      </div>
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Provider config={CONFIG}><Plugin {...props} /></Provider>);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
