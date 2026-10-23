// Scenario 4 — standalone app: every saved widget configuration.
const { Provider, useDataQuery } = D2Runtime;
const {
  CircularLoader, NoticeBox, Tag,
  DataTable, DataTableHead, DataTableRow, DataTableColumnHeader, DataTableBody, DataTableCell,
} = D2UI;

const DASHBOARDS = {
  d: {
    resource: 'dashboards',
    params: ({ ids }) => ({ fields: 'id,displayName,dashboardItems[id]', filter: `dashboardItems.id:in:[${ids.join(',')}]`, paging: false }),
  },
};

function ConfigTable({ entries }) {
  const ids = entries.map((e) => e.key);
  const { loading, error, data } = useDataQuery(DASHBOARDS, { variables: { ids } });
  if (loading) return <CircularLoader small />;
  if (error) return <NoticeBox error title="Could not load dashboards">{error.message}</NoticeBox>;
  const dashOf = {};
  for (const d of data.d.dashboards) for (const it of d.dashboardItems) dashOf[it.id] = d.displayName;
  return (
    <DataTable layout="fixed">
      <DataTableHead>
        <DataTableRow>
          <DataTableColumnHeader>Dashboard</DataTableColumnHeader>
          <DataTableColumnHeader>Indicator shown</DataTableColumnHeader>
          <DataTableColumnHeader width="30%">Saved</DataTableColumnHeader>
        </DataTableRow>
      </DataTableHead>
      <DataTableBody>
        {entries.map((e) => (
          <DataTableRow key={e.key}>
            <DataTableCell>
              <div style={{ overflowWrap: 'anywhere' }}>{dashOf[e.key] || <Tag neutral>Item no longer on a dashboard</Tag>}</div>
              <div style={{ fontSize: 12, color: 'var(--colors-grey600)', marginTop: 2 }}>Item {e.key}</div>
            </DataTableCell>
            <DataTableCell><span style={{ overflowWrap: 'anywhere' }}>{e.value.indicatorName}</span></DataTableCell>
            <DataTableCell>{formatSavedAt(e.value.savedAt)}</DataTableCell>
          </DataTableRow>
        ))}
      </DataTableBody>
    </DataTable>
  );
}

function App() {
  const { loading, error, data } = useDataQuery(ALL_SETTINGS);
  return (
    <div style={{ padding: 'clamp(12px, 4vw, 24px)', maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, margin: '0 0 4px' }}>Indicator widgets</h1>
      <p style={{ margin: '0 0 16px', color: 'var(--colors-grey700)' }}>
        Every dashboard item that uses the indicator widget, and the indicator it is set to show.
      </p>
      {loading && <CircularLoader />}
      {error && <NoticeBox error title="Could not load the saved settings">{error.message}</NoticeBox>}
      {data && (data.s.entries.length
        ? <ConfigTable key={data.s.entries.map((e) => e.key).join(',')} entries={data.s.entries} />
        : <NoticeBox title="No widgets configured yet">Add the plugin to a dashboard and pick an indicator in edit mode.</NoticeBox>)}
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
ReactDOMClient.createRoot(document.getElementById('root')).render(
  <Provider config={CONFIG}>
    <App />
  </Provider>
);
