// Capture form-field plugin: reads weight (kg), height (cm) and temperature
// (°C) and writes a one-line vitals summary into a text field.
// Aliases: weight, height, temperature (read) · summary (written).
const { useEffect } = React;
const { Provider } = D2Runtime;
const { Tag } = D2UI;

function bmiCategory(b) {
  if (b < 18.5) return 'underweight';
  if (b < 25) return 'normal weight';
  if (b < 30) return 'overweight';
  return 'obese';
}

function Plugin({ values = {}, setFieldValue, viewMode, setPluginHeight }) {
  const w = parseFloat(values.weight);
  const h = parseFloat(values.height);
  const t = parseFloat(values.temperature);
  const bmi = w > 0 && h > 0 ? w / ((h / 100) ** 2) : null;
  const fever = t > 0 ? t >= 38 : null;
  const parts = [];
  if (bmi) parts.push(`BMI ${bmi.toFixed(1)} (${bmiCategory(bmi)})`);
  if (fever !== null) parts.push(fever ? `fever ${t} °C` : `no fever (${t} °C)`);
  const summary = parts.length ? `Vitals: ${parts.join(', ')}` : '';
  useEffect(() => {
    if (viewMode || typeof setFieldValue !== 'function' || !summary) return;
    if (String(values.summary ?? '') !== summary) setFieldValue({ fieldId: 'summary', value: summary });
  }, [summary, viewMode]);
  useEffect(() => {
    const root = document.getElementById('root');
    if (typeof setPluginHeight !== 'function') return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(root.getBoundingClientRect().height)));
    ro.observe(root);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 0', fontSize: 14 }}>
      <strong style={{ fontWeight: 500 }}>Vitals check</strong>
      {bmi ? <Tag neutral={bmiCategory(bmi) === 'normal weight'} negative={bmiCategory(bmi) !== 'normal weight'}>{`BMI ${bmi.toFixed(1)} · ${bmiCategory(bmi)}`}</Tag> : null}
      {fever !== null ? <Tag negative={fever} positive={!fever}>{fever ? `Fever ${t} °C` : `No fever · ${t} °C`}</Tag> : null}
      {!parts.length ? <span style={{ color: 'var(--colors-grey700)' }}>Enter weight, height and temperature.</span> : null}
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Provider config={CONFIG}><Plugin {...props} /></Provider>);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
