// Scenario 1 — standalone metadata browser (kind: app).
// Searchable, paginated table of programs with stage and data-element counts.
const { useState, useEffect } = React;
const { Provider, useDataQuery } = D2Runtime;
const {
  InputField, CircularLoader, NoticeBox, Pagination, Tag,
  DataTable, DataTableHead, DataTableRow, DataTableColumnHeader, DataTableBody, DataTableCell, DataTableFoot,
} = D2UI;

const PAGE_SIZE = 10;
const PROGRAMS = {
  programs: {
    resource: 'programs',
    params: ({ page, q }) => ({
      fields: 'id,displayName,programType,programStages[id,programStageDataElements~size]',
      order: 'displayName:asc',
      page,
      pageSize: PAGE_SIZE,
      ...(q ? { filter: `displayName:ilike:${q}` } : {}),
    }),
  },
};

function useNarrow(limit) {
  const [narrow, setNarrow] = useState(window.innerWidth < limit);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < limit);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [limit]);
  return narrow;
}

function ProgramTable({ q, page, onPage }) {
  const narrow = useNarrow(600);
  const { loading, error, data } = useDataQuery(PROGRAMS, { variables: { q, page } });
  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><CircularLoader /></div>;
  if (error) return <NoticeBox error title="Could not load programs">{error.message}</NoticeBox>;
  const { programs, pager } = data.programs;
  const columns = narrow ? 3 : 4;
  return (
    <DataTable layout="fixed">
      <DataTableHead>
        <DataTableRow>
          <DataTableColumnHeader>Program</DataTableColumnHeader>
          {!narrow && <DataTableColumnHeader width="190px">Type</DataTableColumnHeader>}
          <DataTableColumnHeader width={narrow ? '64px' : '96px'} align="right">Stages</DataTableColumnHeader>
          <DataTableColumnHeader width={narrow ? '84px' : '130px'} align="right">Data elements</DataTableColumnHeader>
        </DataTableRow>
      </DataTableHead>
      <DataTableBody>
        {!programs.length && (
          <DataTableRow>
            <DataTableCell colSpan={String(columns)}>
              <span style={{ color: 'var(--colors-grey700)' }}>No program name contains “{q}”.</span>
            </DataTableCell>
          </DataTableRow>
        )}
        {programs.map((p) => {
          const stages = p.programStages || [];
          const des = stages.reduce((n, s) => n + (s.programStageDataElements || 0), 0);
          return (
            <DataTableRow key={p.id}>
              <DataTableCell>
                <span style={{ overflowWrap: 'anywhere' }}>{p.displayName}</span>
                {narrow && <div style={{ marginTop: 4 }}><Tag>{p.programType === 'WITH_REGISTRATION' ? 'Tracker' : 'Event'}</Tag></div>}
              </DataTableCell>
              {!narrow && (
                <DataTableCell>
                  <Tag>{p.programType === 'WITH_REGISTRATION' ? 'Tracker program' : 'Event program'}</Tag>
                </DataTableCell>
              )}
              <DataTableCell align="right">{stages.length}</DataTableCell>
              <DataTableCell align="right">{des.toLocaleString()}</DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
      {programs.length > 0 && (
        <DataTableFoot>
          <DataTableRow>
            <DataTableCell colSpan={String(columns)}>
              <Pagination
                page={pager.page}
                pageCount={pager.pageCount}
                pageSize={pager.pageSize}
                total={pager.total}
                onPageChange={onPage}
                hidePageSizeSelect
                hidePageSelect={narrow}
              />
            </DataTableCell>
          </DataTableRow>
        </DataTableFoot>
      )}
    </DataTable>
  );
}

function App() {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => { setQ(input.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [input]);
  return (
    <div style={{ padding: 'clamp(12px, 4vw, 24px)', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, margin: '0 0 4px' }}>Program browser</h1>
      <p style={{ margin: '0 0 16px', color: 'var(--colors-grey700)' }}>Every program on this server, with its stages and data elements.</p>
      <div style={{ maxWidth: 360, marginBottom: 16 }}>
        <InputField
          label="Search programs"
          placeholder="Type part of a program name"
          value={input}
          onChange={({ value }) => setInput(value)}
          dense
        />
      </div>
      <ProgramTable key={`${q}|${page}`} q={q} page={page} onPage={setPage} />
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
ReactDOMClient.createRoot(document.getElementById('root')).render(
  <Provider config={CONFIG}>
    <App />
  </Provider>
);
