// Scenario 6 — Arabic / right-to-left org-unit summary (kind: app).
// Labels follow the user's UI locale: Arabic + RTL for "ar", English otherwise.
const { useMemo } = React;
const { Provider, useDataQuery } = D2Runtime;
const {
  CircularLoader, NoticeBox,
  DataTable, DataTableHead, DataTableRow, DataTableColumnHeader, DataTableBody, DataTableCell,
} = D2UI;

const TEXT = {
  ar: {
    title: 'ملخص الوحدات التنظيمية',
    intro: 'الوحدات التنظيمية المسندة إليك وعدد الوحدات التابعة لكل منها.',
    unit: 'الوحدة التنظيمية', level: 'المستوى', direct: 'الوحدات الفرعية المباشرة', below: 'إجمالي الوحدات التابعة',
    none: 'لا توجد وحدات تنظيمية مسندة إلى حسابك.', failed: 'تعذر تحميل البيانات',
  },
  en: {
    title: 'Organisation unit summary',
    intro: 'The organisation units assigned to you and how many units sit below each one.',
    unit: 'Organisation unit', level: 'Level', direct: 'Direct sub-units', below: 'All units below',
    none: 'No organisation units are assigned to your account.', failed: 'Could not load the data',
  },
};
const RTL = /^(ar|fa|ur|he|ps|ckb|dv|yi)(?:[_-]|$)/;

const ME = { me: { resource: 'me', params: { fields: 'settings,organisationUnits[id,displayName,level,children~size]' } } };
const BELOW = {
  c: { resource: 'organisationUnits', params: ({ id }) => ({ filter: `path:like:${id}`, fields: 'id', pageSize: 1 }) },
};

function BelowCount({ id, locale }) {
  const { loading, error, data } = useDataQuery(BELOW, { variables: { id } });
  if (loading) return <CircularLoader extrasmall />;
  if (error) return '—';
  return (data.c.pager.total - 1).toLocaleString(locale);
}

function App() {
  const { loading, error, data } = useDataQuery(ME);
  const locale = (data && data.me.settings && data.me.settings.keyUiLocale) || 'en';
  const t = TEXT[locale.split(/[_-]/)[0]] || TEXT.en;
  const dir = RTL.test(locale) ? 'rtl' : 'ltr';
  const units = useMemo(() => (data ? [...data.me.organisationUnits].sort((a, b) => a.displayName.localeCompare(b.displayName, locale)) : []), [data, locale]);
  return (
    <div dir={dir} lang={locale} style={{ padding: 'clamp(12px, 4vw, 24px)', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, margin: '0 0 4px' }}>{t.title}</h1>
      <p style={{ margin: '0 0 16px', color: 'var(--colors-grey700)' }}>{t.intro}</p>
      {loading && <CircularLoader />}
      {error && <NoticeBox error title={t.failed}>{error.message}</NoticeBox>}
      {data && !units.length && <NoticeBox title={t.none} />}
      {units.length > 0 && (
        <DataTable layout="fixed">
          <DataTableHead>
            <DataTableRow>
              <DataTableColumnHeader>{t.unit}</DataTableColumnHeader>
              <DataTableColumnHeader width="16%">{t.level}</DataTableColumnHeader>
              <DataTableColumnHeader width="24%">{t.direct}</DataTableColumnHeader>
              <DataTableColumnHeader width="24%">{t.below}</DataTableColumnHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {units.map((u) => (
              <DataTableRow key={u.id}>
                <DataTableCell><span style={{ overflowWrap: 'anywhere' }}>{u.displayName}</span></DataTableCell>
                <DataTableCell>{u.level.toLocaleString(locale)}</DataTableCell>
                <DataTableCell dataTest="direct">{u.children.toLocaleString(locale)}</DataTableCell>
                <DataTableCell dataTest="below"><BelowCount id={u.id} locale={locale} /></DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
ReactDOMClient.createRoot(document.getElementById('root')).render(
  <Provider config={CONFIG}>
    <App />
  </Provider>
);
