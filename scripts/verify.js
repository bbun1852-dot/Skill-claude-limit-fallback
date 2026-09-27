#!/usr/bin/env node
// Checks the claude-limit-fallback setup end to end and prints PASS/FAIL per step.
// Usage: node verify.js [--e2e [--dir <already-trusted folder>]]
//   --e2e also simulates a usage-limit 429 with the real StopFailure hook; this opens the
//   "Claude via OmniRoute" window (close it afterwards).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const OMNIROUTE_CLI = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'omniroute', 'bin', 'omniroute.mjs');
const OMNI = 'http://127.0.0.1:20128';
const FREE_MODELS = ['mistral/codestral-latest', 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'gemini/gemini-3.8-flash', 'groq/openai/gpt-oss-120b'];
let failed = false;

function report(ok, name, detail) {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function chat(model) {
  const res = await fetch(`${OMNI}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 400, stream: false, messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }] }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, detail: `${res.status} ${text.slice(0, 120)}` };
  const content = JSON.parse(text).choices?.[0]?.message?.content || '';
  return { ok: content.trim().length > 0, detail: content.trim().slice(0, 40) || 'empty reply' };
}

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-fallback-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'The secret word is "banana-42".\n');
  return dir;
}

function checkInstall() {
  const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
  report(JSON.stringify(settings.hooks?.StopFailure || []).includes('omniroute-fallback.js'), 'StopFailure hook registered');
  report(fs.existsSync(path.join(CLAUDE_DIR, 'hooks', 'omniroute-fallback.js')), 'hook script installed');
  report(fs.existsSync(OMNIROUTE_CLI), 'OmniRoute installed');
}

async function checkModels() {
  const health = await fetch(`${OMNI}/api/monitoring/health`).then((r) => r.ok).catch(() => false);
  report(health, 'OmniRoute server running');
  if (!health) return;
  for (const model of FREE_MODELS) {
    const r = await chat(model).catch((e) => ({ ok: false, detail: e.message }));
    console.log(`${r.ok ? 'ok  ' : 'no  '}  ${model} - ${r.detail}`);
  }
  const combo = await chat('claude-fallback').catch((e) => ({ ok: false, detail: e.message }));
  report(combo.ok, 'combo claude-fallback answers', combo.detail);
}

function checkClaudeCode() {
  const cwd = tempProject();
  const r = spawnSync(process.execPath, [OMNIROUTE_CLI, 'launch', '--', '--model', 'claude-fallback',
    '--disallowedTools', 'ArtifactData', '--allowedTools', 'Read', '-p', 'Read note.txt and reply with only the secret word.'],
    { cwd, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout}${r.stderr}`;
  const lastLine = out.split('\n').map((l) => l.trim()).filter((l) => l && !/unrecognized_model|deprecation/i.test(l)).pop();
  report(out.includes('banana-42'), 'Claude Code through OmniRoute used the Read tool', lastLine);
}

function trusted(dir) {
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const key = dir.replace(/\\/g, '/');
  // Trust is inherited from an already-trusted parent folder.
  return Object.entries(config.projects || {}).some(([k, v]) => v.hasTrustDialogAccepted && (key === k || key.startsWith(`${k}/`)));
}

async function checkEndToEnd() {
  // A fixed folder, so the CLI's one-time "trust this folder?" prompt is only answered once.
  const dirArg = process.argv.indexOf('--dir');
  const cwd = dirArg === -1 ? path.join(CLAUDE_DIR, 'limit-fallback-test') : path.resolve(process.argv[dirArg + 1]);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'The secret word is "banana-42".\n');
  if (!trusted(cwd)) console.log(`WAIT  first run: the new window asks to trust ${cwd} - confirm it there`);
  const server = spawn(process.execPath, [path.join(__dirname, 'fake-limit-server.js')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const env = { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:18998', ANTHROPIC_AUTH_TOKEN: 'limit-test', ANTHROPIC_API_KEY: '' };
  // claude is a .cmd shim on Windows, so it needs a shell; quote the prompt ourselves.
  const r = spawnSync('claude -p "Read note.txt and tell me the secret word."', { cwd, env, encoding: 'utf8', shell: true, timeout: 180000 });
  server.kill();
  report(`${r.stdout}${r.stderr}`.includes('429'), 'simulated usage limit returned 429');

  // The fallback session writes a new transcript in the same project folder. Free models are
  // slow and retry through the combo, so allow up to 15 minutes (measured: about 10).
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = path.join(CLAUDE_DIR, 'projects', slug);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 5000));
    if (!fs.existsSync(projectDir)) continue;
    for (const file of fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))) {
      const lines = fs.readFileSync(path.join(projectDir, file), 'utf8').split('\n');
      const reply = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((m) => m?.type === 'assistant' && m.message?.model && m.message.model !== '<synthetic>' &&
          JSON.stringify(m.message.content).includes('banana-42'));
      if (reply) return report(true, 'hook opened OmniRoute session and it finished the task', `model ${reply.message.model}`);
    }
  }
  report(false, 'hook opened OmniRoute session and it finished the task', `no reply in ${projectDir}`);
}

(async () => {
  checkInstall();
  await checkModels();
  checkClaudeCode();
  if (process.argv.includes('--e2e')) await checkEndToEnd();
  process.exit(failed ? 1 : 0);
})();
