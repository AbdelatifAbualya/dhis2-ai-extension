'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * claude-code-bridge.js — lets a Claude model on the user's own Claude
 * subscription (through Claude Code's headless mode, `claude -p`) drive the
 * chatbot in the test harness, with NO change to the extension.
 *
 * The harness points the extension at an OpenAI-compatible base URL on the host
 * `claude-code.bridge.invalid`; llm-harness.js hands every request for that host to
 * handleChatCompletion() below. Each request (system prompt, conversation, tool
 * list) becomes one locked-down `claude -p` run:
 *   --tools ""                 no built-in tools (it cannot touch this machine)
 *   --strict-mcp-config        no MCP servers
 *   --disable-slash-commands   no skills or commands
 *   --no-session-persistence   nothing saved
 *   --system-prompt-file       the extension's own system prompt + tool catalog
 *   the reply is a JSON object {content, tool_calls[]} read from plain text
 *   (no --json-schema: that option is a hidden tool, and Haiku then tried to
 *   call the listed operations natively)
 * run in an empty directory (no CLAUDE.md, no project memory). The reply goes
 * back to the extension as an OpenAI streaming answer, so the extension's own
 * agent loop, guards and tools run exactly as for a real user.
 *
 * Difference from a real deployment, to keep in mind when judging results: the
 * model sees the tools as text and answers in structured JSON, not through the
 * Messages API's native tool calling, and every step re-sends the conversation.
 *
 * env:
 *   LLM_BASE_URL=http://claude-code.bridge.invalid/v1   (selects the bridge)
 *   LLM_MODEL=haiku | sonnet | opus | claude-haiku-5-5 …
 *   LLM_EFFORT=low|medium|high|xhigh|max      (optional)
 *   CLAUDE_BRIDGE_LOG=<file>                  (optional: one JSON line per call)
 *   CLAUDE_BIN=<path to claude>               (optional)
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Never a *.local name: the extension treats *.local as a model on the user's own
// machine (isLocalProviderUrl) and then lets it read patient rows. Claude on the
// subscription is a cloud model, so the bridge must look like one (2026-11-19: the
// patient-listing safety probe passed names and phones to Haiku under the old name).
const BRIDGE_HOST = 'claude-code.bridge.invalid';
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'Text for the user. Empty while you are calling tools; your final answer when tool_calls is empty.' },
    tool_calls: {
      type: 'array',
      description: 'Tools to run now, in order. Empty when you are done.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['name', 'arguments'],
      },
    },
  },
  required: ['content', 'tool_calls'],
  additionalProperties: false,
};

// Plain text, not --json-schema: the schema option works through a hidden tool,
// and with a tool interface in view Haiku called the listed operations as if they
// were its own tools, got Claude Code's "No such tool available", and told the
// user the DHIS2 tools were missing (3 of 4 threads on 2026-11-18). With no tool
// defined at all a native call cannot happen; the JSON is read from the text.
const PROTOCOL = `# How you act in this conversation
You have NO functions or tools you can call yourself in this environment; calling one directly always fails. Your only way to act is your reply, which is ONE JSON object: {"content": "...", "tool_calls": [{"name": "<operation name>", "arguments": {...}}]}.
Write ONLY that JSON object (no prose around it, no code fence). Name the operations you want in tool_calls and stop: the application runs them, in the order given, and sends each result back in the next message as a TOOL RESULT. Then you continue.
- While working: put the operations in tool_calls; content may be empty.
- To finish the turn: tool_calls is [] and content is your complete answer to the user (markdown).
- Arguments follow the operation's schema exactly (lists as JSON arrays, true/false as booleans).
- A [SYSTEM NOTE] in the conversation comes from the application, not the user: follow it.`;

let workDir = null;
function emptyWorkDir() {
  if (workDir && fs.existsSync(workDir)) return workDir;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-'));
  return workDir;
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === 'text' ? p.text : p && p.type === 'image_url' ? '[image]' : JSON.stringify(p))).join('\n');
  return JSON.stringify(content);
}

function toolCatalog(tools) {
  return (tools || []).map((t) => {
    const f = t.function || t;
    return `### ${f.name}\n${f.description || ''}\nArguments (JSON Schema): ${JSON.stringify(f.parameters || { type: 'object' })}`;
  }).join('\n\n');
}

// System messages before the first user message form the system prompt; later
// ones are notes at their place in the conversation.
function splitConversation(messages) {
  const sys = [];
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') sys.push(textOf(messages[i].content)), i++;
  const lines = [];
  for (const m of messages.slice(i)) {
    if (m.role === 'system') lines.push(`[SYSTEM NOTE]\n${textOf(m.content)}`);
    else if (m.role === 'user') lines.push(`[USER]\n${textOf(m.content)}`);
    else if (m.role === 'assistant') {
      const t = textOf(m.content);
      if (t) lines.push(`[ASSISTANT]\n${t}`);
      for (const tc of m.tool_calls || []) lines.push(`[ASSISTANT → TOOL CALL ${tc.id}] ${tc.function?.name}\n${tc.function?.arguments || '{}'}`);
    } else if (m.role === 'tool') lines.push(`[TOOL RESULT for ${m.tool_call_id}]\n${textOf(m.content)}`);
  }
  return { system: sys.join('\n\n'), transcript: lines.join('\n\n') };
}

function runClaude({ model, effort, systemFile, prompt, timeoutMs }) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt-file', systemFile, '--output-format', 'json'];
  if (effort) args.push('--effort', effort);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: emptyWorkDir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(prompt);
  });
}

// The reply's JSON object, from text that may carry a code fence or a sentence
// around it. Returns {content, tool_calls} or null.
// A long reply (a whole dashboard spec, ~4,000 tokens) was not valid JSON: a
// multi-line text tile carried real line breaks inside a string. Repair only what
// JSON forbids and the meaning is clear: control characters inside strings, and
// commas before a closing bracket.
function repairJson(x) {
  let out = ''; let inStr = false; let esc = false;
  for (const ch of x) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch; continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
function parseReply(text) {
  const t = String(text || '').trim();
  const tryParse = (x) => { try { const o = JSON.parse(x); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  const unfenced = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let o = tryParse(t) || tryParse(unfenced) || tryParse(repairJson(unfenced));
  if (!o) {
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) o = tryParse(t.slice(a, b + 1)) || tryParse(repairJson(t.slice(a, b + 1)));
  }
  if (!o || (o.tool_calls !== undefined && !Array.isArray(o.tool_calls))) return null;
  if (o.content === undefined && o.tool_calls === undefined) return null;
  return { content: typeof o.content === 'string' ? o.content : (o.content == null ? '' : JSON.stringify(o.content)), tool_calls: Array.isArray(o.tool_calls) ? o.tool_calls : [] };
}

let callNo = 0;
async function handleChatCompletion(body) {
  const n = ++callNo;
  const t0 = Date.now();
  const model = String(body.model || process.env.LLM_MODEL || 'haiku');
  const { system, transcript } = splitConversation(body.messages || []);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const systemText = `${system}\n\n${PROTOCOL}${tools.length ? `\n\n# Operations the application can run for you (request them by name in tool_calls)\n${toolCatalog(tools)}` : '\n\nNo operations can be run in this step: answer in content with tool_calls [].'}`;
  const systemFile = path.join(emptyWorkDir(), `system-${process.pid}-${n}.txt`);
  fs.writeFileSync(systemFile, systemText);
  const basePrompt = `${transcript}\n\nReply now with the JSON object for your next step.`;
  let d = null; let so = null; let r = null; let attempt = 0;
  while (attempt < 2 && !so) {
    attempt++;
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n\nYour last reply was not the JSON object. Reply with ONLY {"content": "...", "tool_calls": [...]} and nothing else.`;
    r = await runClaude({ model, effort: process.env.LLM_EFFORT || '', systemFile, prompt, timeoutMs: Number(process.env.CLAUDE_BRIDGE_TIMEOUT_MS || 600000) });
    try { d = JSON.parse(r.out); } catch { d = null; }
    if (!d || d.is_error) break;
    so = parseReply(d.result);
    if (!so && process.env.CLAUDE_BRIDGE_LOG) fs.writeFileSync(`${process.env.CLAUDE_BRIDGE_LOG}.unparsed-${n}-${attempt}.txt`, String(d.result || ''));
    const log = { n, attempt, ms: Date.now() - t0, model: Object.keys(d.modelUsage || {})[0], num_turns: d.num_turns, system_chars: systemText.length, prompt_chars: prompt.length, usage: d.usage, parsed: !!so, reply_head: String(d.result || '').slice(0, 160) };
    if (process.env.CLAUDE_BRIDGE_LOG) fs.appendFileSync(process.env.CLAUDE_BRIDGE_LOG, JSON.stringify(log) + '\n');
  }
  try { fs.unlinkSync(systemFile); } catch { /* ignore */ }
  if (!d || d.is_error) {
    const msg = (d && (d.result || d.subtype)) || r.err || r.out || `claude exited ${r.code}`;
    if (process.env.CLAUDE_BRIDGE_LOG) fs.appendFileSync(process.env.CLAUDE_BRIDGE_LOG, JSON.stringify({ n, error: String(msg).slice(0, 300), exit: r.code }) + '\n');
    const status = /rate|limit|quota|usage/i.test(String(msg)) ? 429 : 500;
    return new Response(JSON.stringify({ error: { message: `Claude Code bridge: ${String(msg).slice(0, 500)}` } }), { status, headers: { 'Content-Type': 'application/json' } });
  }
  // Still no JSON after a retry: the text itself is the answer (no operations).
  if (!so) so = { content: String(d.result || ''), tool_calls: [] };
  const calls = (Array.isArray(so.tool_calls) ? so.tool_calls : []).filter((c) => c && c.name);
  const chunks = [];
  const delta = (obj, finish = null) => chunks.push(`data: ${JSON.stringify({ id: `bridge-${n}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: obj, finish_reason: finish }] })}\n\n`);
  if (so.content) delta({ role: 'assistant', content: String(so.content) });
  calls.forEach((c, i) => delta({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }] }));
  delta({}, calls.length ? 'tool_calls' : 'stop');
  chunks.push('data: [DONE]\n\n');
  return new Response(chunks.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function isBridgeUrl(u) {
  try { return new URL(String(u)).hostname === BRIDGE_HOST; } catch { return false; }
}

module.exports = { handleChatCompletion, isBridgeUrl, BRIDGE_HOST, splitConversation, parseReply, repairJson, REPLY_SCHEMA };
