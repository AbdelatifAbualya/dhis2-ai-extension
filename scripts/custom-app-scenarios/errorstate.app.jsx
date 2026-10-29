// Error-state scenario — one query deliberately targets a resource that does
// not exist, to prove the generated pattern shows a NoticeBox, never a blank page.
const { Provider, useDataQuery } = D2Runtime;
const { CircularLoader, NoticeBox, Card } = D2UI;

const BROKEN = { x: { resource: 'aiTestResourceThatDoesNotExist' } };
const PROGRAMS = { p: { resource: 'programs', params: { fields: 'id', pageSize: 1 } } };

function Section({ title, query, render }) {
  const { loading, error, data } = useDataQuery(query);
  return (
    <Card>
      <div style={{ padding: 16 }}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>{title}</div>
        {loading && <CircularLoader small />}
        {error && <NoticeBox error title="Could not load this section">{error.message}</NoticeBox>}
        {data && render(data)}
      </div>
    </Card>
  );
}

function App() {
  return (
    <div style={{ padding: 'clamp(12px, 4vw, 24px)', maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Error handling check</h1>
      <Section title="Programs on this server" query={PROGRAMS} render={(d) => `${d.p.pager.total} programs`} />
      <Section title="A source that does not exist" query={BROKEN} render={() => 'unexpected data'} />
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
ReactDOMClient.createRoot(document.getElementById('root')).render(
  <Provider config={CONFIG}>
    <App />
  </Provider>
);
