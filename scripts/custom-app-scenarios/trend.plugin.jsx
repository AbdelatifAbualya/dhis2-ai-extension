// Scenario 3 — chart dashboard plugin (plugin_type DASHBOARD, uses echarts).
// Monthly Malaria case events over the last 12 months for the filtered org unit.
const { useRef, useEffect, useMemo } = React;
const { Provider, useDataQuery } = D2Runtime;
const { CircularLoader, NoticeBox } = D2UI;

const PROGRAM = 'l0NXObayGhi';
const TREND = {
  months: {
    resource: `analytics/events/aggregate/${PROGRAM}`,
    params: ({ ou }) => ({ dimension: ['pe:LAST_12_MONTHS'], filter: [`ou:${ou}`], outputType: 'EVENT' }),
  },
};

function Chart({ option }) {
  const el = useRef(null);
  useEffect(() => {
    const chart = echarts.init(el.current);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); chart.dispose(); };
  }, []);
  useEffect(() => {
    const chart = echarts.getInstanceByDom(el.current);
    if (chart) chart.setOption(option, true);
  }, [option]);
  return <div ref={el} style={{ flex: 1, minHeight: 160, width: '100%' }} />;
}

function Trend({ ou, ouName }) {
  const { loading, error, data } = useDataQuery(TREND, { variables: { ou } });
  const series = useMemo(() => {
    if (!data) return null;
    const r = data.months;
    const pe = r.headers.findIndex((h) => h.name === 'pe');
    const value = r.headers.findIndex((h) => h.name === 'value');
    const byMonth = {};
    for (const row of r.rows) byMonth[row[pe]] = Number(row[value]);
    const months = r.metaData.dimensions.pe;
    return {
      // "202510" → "Oct 25" (short enough for narrow items)
      labels: months.map((m) => `${new Date(Number(m.slice(0, 4)), Number(m.slice(4)) - 1, 1).toLocaleString('en', { month: 'short' })} ${m.slice(2, 4)}`),
      values: months.map((m) => byMonth[m] || 0),
      total: r.rows.reduce((n, row) => n + Number(row[value]), 0),
    };
  }, [data]);
  const option = useMemo(() => series && ({
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: series.labels, axisLabel: { hideOverlap: true, fontSize: 11 }, axisTick: { alignWithLabel: true } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 11 } },
    series: [{ name: 'Malaria events', type: 'bar', data: series.values, itemStyle: { color: '#147cd7' }, barMaxWidth: 28 }],
  }), [series]);
  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CircularLoader small /></div>;
  if (error) return <NoticeBox error title="Could not load the trend">{error.message}</NoticeBox>;
  if (!series.total) {
    return <NoticeBox title="No data">No Malaria case events were recorded in {ouName} in the last 12 months.</NoticeBox>;
  }
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--colors-grey700)', marginBottom: 4 }}>
        Malaria case events per month · {ouName} · last 12 months · {series.total.toLocaleString()} in total
      </div>
      <Chart option={option} />
    </>
  );
}

function Plugin({ dashboardItemFilters = {}, setPluginHeight }) {
  const ouF = dashboardItemFilters.ou || [];
  const ou = ouF.map((o) => o.id).join(';') || 'USER_ORGUNIT';
  const ouName = ouF.map((o) => o.name).join(', ') || 'your organisation units';
  const ref = useRef(null);
  useEffect(() => {
    if (typeof setPluginHeight !== 'function' || !ref.current) return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(ref.current.scrollHeight)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return (
    <div ref={ref} style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 10, boxSizing: 'border-box' }}>
      <Trend key={ou} ou={ou} ouName={ouName} />
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
