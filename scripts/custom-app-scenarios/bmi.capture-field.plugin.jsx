// Capture form-field plugin: reads weight (kg) and height (cm), writes BMI.
// Aliases: weight, height (read) · bmi (written) — placed with a field_map
// for exactly these three.
const { useEffect } = React;
const { Provider } = D2Runtime;

function bmiCategory(b) {
  if (b < 18.5) return 'underweight';
  if (b < 25) return 'normal weight';
  if (b < 30) return 'overweight';
  return 'obese';
}

function Plugin({ values = {}, setFieldValue, viewMode, setPluginHeight }) {
  const w = parseFloat(values.weight);
  const h = parseFloat(values.height);
  const bmi = w > 0 && h > 0 ? (w / ((h / 100) ** 2)).toFixed(1) : '';
  useEffect(() => {
    if (viewMode || typeof setFieldValue !== 'function') return;
    if (String(values.bmi ?? '') !== bmi) setFieldValue({ fieldId: 'bmi', value: bmi });
  }, [bmi, viewMode]);
  useEffect(() => {
    const root = document.getElementById('root');
    if (typeof setPluginHeight !== 'function') return;
    const ro = new ResizeObserver(() => setPluginHeight(Math.ceil(root.getBoundingClientRect().height)));
    ro.observe(root);
    return () => ro.disconnect();
  }, [setPluginHeight]);
  return (
    <div style={{ padding: '6px 0', fontSize: 14 }}>
      {bmi
        ? <span>BMI <strong>{bmi}</strong> kg/m² — {bmiCategory(Number(bmi))}</span>
        : <span style={{ color: 'var(--colors-grey700)' }}>Enter weight and height to calculate the BMI.</span>}
    </div>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
const root = ReactDOMClient.createRoot(document.getElementById('root'));
const render = (props) => root.render(<Provider config={CONFIG}><Plugin {...props} /></Provider>);
if (window.parent === window) render({});
else postRobot.send(window.parent, 'getPropsFromParent').then(({ data }) => render(data)).catch(() => render({}));
postRobot.on('updated', ({ data }) => { render(data); });
