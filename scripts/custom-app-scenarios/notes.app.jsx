// Scenario 5 — write-enabled "team notes" app (needs_write_access: true).
// Each note is one key in the app's own dataStore namespace.
const { useState } = React;
const { Provider, useDataQuery, useDataEngine, useAlert, useAlerts } = D2Runtime;
const {
  Card, Button, ButtonStrip, TextAreaField, NoticeBox, CircularLoader, AlertBar, AlertStack,
  Modal, ModalTitle, ModalContent, ModalActions,
} = D2UI;

const NS = D2_APP_CONFIG.namespace;
const NOTES = { n: { resource: `dataStore/${NS}`, params: { fields: '.', pageSize: 200 } } };

function Note({ note, onSave, onDelete, busy }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.value.text);
  return (
    <Card>
      <div data-test="note" style={{ padding: 16 }}>
        {editing ? (
          <>
            <TextAreaField label="Edit note" value={text} onChange={({ value }) => setText(value)} rows={3} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Button small primary disabled={!text.trim() || busy} onClick={async () => { await onSave(note, text.trim()); setEditing(false); }}>Save</Button>
              <Button small secondary onClick={() => { setText(note.value.text); setEditing(false); }}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div data-test="note-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.value.text}</div>
            <div style={{ fontSize: 12, color: 'var(--colors-grey600)', marginTop: 8 }}>
              {note.value.updatedAt ? `Edited ${new Date(note.value.updatedAt).toLocaleString()}` : `Added ${new Date(note.value.createdAt).toLocaleString()}`}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Button small secondary disabled={busy} onClick={() => setEditing(true)}>Edit</Button>
              <Button small destructive secondary disabled={busy} onClick={() => onDelete(note)}>Delete</Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function ConfirmDelete({ note, onCancel, onConfirm, busy }) {
  return (
    <Modal small onClose={onCancel}>
      <ModalTitle>Delete this note?</ModalTitle>
      <ModalContent>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--colors-grey800)' }}>“{note.value.text}”</div>
        <p style={{ marginBottom: 0 }}>It is removed for everyone who uses this app.</p>
      </ModalContent>
      <ModalActions>
        <ButtonStrip end>
          <Button secondary onClick={onCancel}>Cancel</Button>
          <Button destructive loading={busy} disabled={busy} onClick={onConfirm}>Delete</Button>
        </ButtonStrip>
      </ModalActions>
    </Modal>
  );
}

function App() {
  const engine = useDataEngine();
  const { loading, error, data, refetch } = useDataQuery(NOTES);
  const { show } = useAlert(({ msg }) => msg, ({ ok }) => (ok ? { success: true } : { critical: true }));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const run = async (mutation, done) => {
    setBusy(true);
    try {
      await engine.mutate(mutation);
      await refetch();
      show({ msg: done, ok: true });
      return true;
    } catch (e) {
      show({ msg: `Could not save: ${e.message}`, ok: false });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const id = `note-${Date.now()}`;
    if (await run({ resource: `dataStore/${NS}/${id}`, type: 'create', data: { text: draft.trim(), createdAt: new Date().toISOString() } }, 'Note added')) setDraft('');
  };
  const save = (note, text) => run({ resource: `dataStore/${NS}/${note.key}`, type: 'update', data: { ...note.value, text, updatedAt: new Date().toISOString() } }, 'Note updated');
  const remove = async () => {
    if (await run({ resource: `dataStore/${NS}/${confirming.key}`, type: 'delete' }, 'Note deleted')) setConfirming(null);
  };
  const notes = data ? [...data.n.entries].sort((a, b) => (a.key < b.key ? 1 : -1)) : [];
  return (
    <div style={{ padding: 'clamp(12px, 4vw, 24px)', maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, margin: '0 0 4px' }}>Team notes</h1>
      <p style={{ margin: '0 0 16px', color: 'var(--colors-grey700)' }}>Short notes shared by everyone who can open this app.</p>
      <Card>
        <div style={{ padding: 16 }}>
          <TextAreaField label="New note" placeholder="Write a note…" value={draft} onChange={({ value }) => setDraft(value)} rows={3} />
          <div style={{ marginTop: 8 }}>
            <Button primary disabled={!draft.trim() || busy} loading={busy} onClick={add}>Add note</Button>
          </div>
        </div>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {loading && <CircularLoader small />}
        {error && <NoticeBox error title="Could not load notes">{error.message}</NoticeBox>}
        {data && !notes.length && <NoticeBox title="No notes yet">Add the first note above.</NoticeBox>}
        {notes.map((n) => <Note key={n.key} note={n} onSave={save} onDelete={setConfirming} busy={busy} />)}
      </div>
      {confirming && <ConfirmDelete note={confirming} busy={busy} onCancel={() => setConfirming(null)} onConfirm={remove} />}
    </div>
  );
}

// Draws useAlert() messages, as the DHIS2 app shell does.
function Alerts() {
  const alerts = useAlerts();
  return (
    <AlertStack>
      {alerts.map(({ id, message, remove, options: { onHidden, ...props } }) => (
        <AlertBar key={id} {...props} onHidden={() => { if (onHidden) onHidden(); remove(); }}>{message}</AlertBar>
      ))}
    </AlertStack>
  );
}

const CONFIG = { baseUrl: D2_APP_CONFIG.baseUrl, apiVersion: D2_APP_CONFIG.apiVersion, serverVersion: D2_APP_CONFIG.serverVersion };
ReactDOMClient.createRoot(document.getElementById('root')).render(
  <Provider config={CONFIG}>
    <App />
    <Alerts />
  </Provider>
);
