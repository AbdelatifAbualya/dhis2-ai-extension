// Capture form-field plugin: a red FLAG button next to every mapped field.
// Flags are plugin STATE kept in the event's own storage field (alias "flags",
// a LONG_TEXT data element placed with replace_field:true), so they are saved
// with the event and inherit the program's access control.
// Aliases: flags (written, JSON) · every other mapped field (read).
const { useEffect, useState } = React;
const { Provider } = D2Runtime;
const { Button } = D2UI;

const STORE = 'flags';

function parseFlags(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function shownValue(meta, raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const options = meta && meta.optionSet && meta.optionSet.options;
  const hit = Array.isArray(options) ? options.find((o) => o.code === raw) : null;
  if (hit) return hit.text;
  if (raw === 'true') return 'Yes';
  if (raw === 'false') return 'No';
  return String(raw);
}

function Plugin({ values = {}, fieldsMetadata = {}, setFieldValue, viewMode, setPluginHeight }) {
  const [status, setStatus] = useState('');
  const flags = parseFlags(values[STORE]);
  const canWrite = !!fieldsMetadata[STORE] && typeof setFieldValue === 'function';
  const fields = Object.keys(fieldsMetadata).filter((alias) => alias !== STORE);

  useEffect(() => {
    const root = document.getElementById('root');
    if (typeof setPluginHeight !== 'function') return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(root.getBoundingClientRect().height)));
    ro.observe(root);
    return () => ro.disconnect();
  }, [setPluginHeight]);

  const toggle = (alias) => {
    if (viewMode) return;
    if (!canWrite) {
      setStatus('The flag storage field is not in this form — reload Capture, or ask an administrator to place the plugin again.');
      return;
    }
    const meta = fieldsMetadata[alias] || {};
    const on = flags.some((f) => f.id === alias);
    const next = on
      ? flags.filter((f) => f.id !== alias)
      : flags.concat([{ id: alias, label: meta.formName || meta.name || alias, value: shownValue(meta, values[alias]), at: new Date().toISOString() }]);
    setFieldValue({ fieldId: STORE, value: next.length ? JSON.stringify(next) : '' });
    setStatus(on ? 'Flag removed — save the event to keep it.' : 'Flagged — save the event to keep it.');
  };

  return (
    <div style={{ padding: '4px 0 8px' }}>
      {!canWrite && !viewMode ? (
        <div style={{ color: 'var(--colors-red700)', fontSize: 13, paddingBottom: 6 }}>The flag storage field is not in this form, so flags cannot be saved.</div>
      ) : null}
      {fields.map((alias) => {
        const meta = fieldsMetadata[alias] || {};
        const flagged = flags.some((f) => f.id === alias);
        return (
          <div key={alias} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderInlineStart: `3px solid ${flagged ? 'var(--colors-red600)' : 'transparent'}`, background: flagged ? 'var(--colors-red050)' : 'transparent' }}>
            <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <div style={{ fontSize: 13, color: 'var(--colors-grey900)' }}>{meta.formName || meta.name || alias}</div>
              <div style={{ fontSize: 12, color: 'var(--colors-grey700)' }}>{shownValue(meta, values[alias]) || 'no value'}</div>
            </div>
            <Button small destructive={!flagged} secondary={flagged} disabled={!!viewMode} onClick={() => toggle(alias)}>{flagged ? 'FLAGGED' : 'FLAG'}</Button>
          </div>
        );
      })}
      {status ? <div style={{ fontSize: 12, color: 'var(--colors-red700)', paddingTop: 6 }}>{status}</div> : null}
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Provider config={CONFIG} plugin parentAlertsAdd={props.alertsAdd}><Plugin {...props} /></Provider>);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
