#!/usr/bin/env node
// When a Claude subscription session hits its 5-hour or weekly limit, continue the work in a
// new window routed through OmniRoute.
//
// The new session does NOT resume the full conversation: a long session is larger than the
// free models' context windows (codestral 128k), so OmniRoute would skip them. Instead it
// starts fresh with a handoff file built from the transcript (recent requests and replies,
// files touched) and asks the model to continue from there.
//
// Hook mode (StopFailure, matcher rate_limit): reads the hook JSON from stdin and opens
//   the launcher window via explorer.exe, so the window lives outside the app's process tree.
// Launch mode: node omniroute-fallback.js --launch [<session-id> <base64-cwd> <base64-transcript>]
//   Starts OmniRoute if needed, then runs Claude Code through the fallback combo.
//   Without a session id it opens a plain session (used by the desktop shortcut).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const COMBO = 'claude-fallback';
const OMNIROUTE_PORT = 20128;
const OMNIROUTE_CLI = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'omniroute', 'bin', 'omniroute.mjs');
const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'omniroute-fallback');
const DEBOUNCE_MS = 30 * 60 * 1000;
const SERVER_WAIT_MS = 3 * 60 * 1000;
const API_TIMEOUT_MS = 2 * 60 * 1000;
// ArtifactData's input schema uses prefixItems, which OmniRoute's Gemini translation rejects.
const DISALLOWED_TOOLS = 'ArtifactData';
// Handoff size budget: small enough that system prompt + tools (~75k tokens) + handoff fit 128k.
const HANDOFF_MAX_CHARS = 24000;
const MESSAGE_MAX_CHARS = 2000;
const RECENT_USER_MESSAGES = 4;
const RECENT_ASSISTANT_MESSAGES = 6;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function recentlyLaunched(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < DEBOUNCE_MS;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function runHook() {
  const input = JSON.parse(await readStdin());
  if (input.error !== 'rate_limit') return;
  // Already running through OmniRoute: relaunching would loop.
  if ((process.env.ANTHROPIC_BASE_URL || '').includes(`:${OMNIROUTE_PORT}`)) return;

  const sessionId = String(input.session_id || '');
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const cmdFile = path.join(STATE_DIR, `${sessionId}.cmd`);
  if (recentlyLaunched(cmdFile)) return;

  // The .cmd must stay ASCII (cmd.exe reads it in the OEM code page), so paths travel as base64.
  fs.writeFileSync(
    cmdFile,
    [
      '@echo off',
      'title Claude via OmniRoute',
      `"${process.execPath}" "${__filename}" --launch ${sessionId} ${b64(projectDir)} ${b64(input.transcript_path || '')}`,
      'if errorlevel 1 pause',
      '',
    ].join('\r\n'),
    'ascii'
  );
  spawn('explorer.exe', [cmdFile], { detached: true, stdio: 'ignore' }).unref();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

// Real user requests only: skip tool results, injected skill/command bodies and reminders.
function isUserRequest(entry) {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const text = textOf(entry.message?.content).trim();
  return text !== '' && !text.startsWith('<') && !text.startsWith('Base directory for this skill') &&
    !text.startsWith('The Claude subscription usage limit');
}

function clip(text) {
  return text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)} ...(truncated)` : text;
}

function buildHandoff(sessionId, projectDir, transcriptPath) {
  const entries = fs.readFileSync(transcriptPath, 'utf8').split('\n')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  const requests = entries.filter(isUserRequest).slice(-RECENT_USER_MESSAGES)
    .map((e) => `- ${clip(textOf(e.message.content).trim())}`);
  const replies = entries
    .filter((e) => e.type === 'assistant' && e.message?.model !== '<synthetic>' && textOf(e.message?.content).trim())
    .slice(-RECENT_ASSISTANT_MESSAGES)
    .map((e) => `- ${clip(textOf(e.message.content).trim())}`);
  const files = [...new Set(entries.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((p) => p.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.name))
    .map((p) => p.input?.file_path || p.input?.notebook_path).filter(Boolean))].slice(-20);

  const handoff = [
    '# Handoff: continue a Claude session that hit its usage limit',
    '',
    `Project folder: ${projectDir}`,
    `Original session: ${sessionId}`,
    `Full transcript (JSONL, large - search it with Grep, do not Read it whole): ${transcriptPath}`,
    '',
    '## Most recent user requests (oldest first)',
    ...requests,
    '',
    '## Most recent assistant replies (oldest first)',
    ...replies,
    '',
    '## Files edited in that session',
    ...(files.length ? files.map((f) => `- ${f}`) : ['- (none)']),
  ].join('\n');
  return handoff.length > HANDOFF_MAX_CHARS ? handoff.slice(handoff.length - HANDOFF_MAX_CHARS) : handoff;
}

function omnirouteHealthy() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: OMNIROUTE_PORT, path: '/api/monitoring/health', timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function ensureOmniRoute() {
  if (await omnirouteHealthy()) return true;
  console.log('Starting OmniRoute server...');
  spawn(process.execPath, [OMNIROUTE_CLI, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    if (await omnirouteHealthy()) return true;
  }
  return false;
}

async function runLauncher(sessionId, cwdArg, transcriptArg) {
  if (!(await ensureOmniRoute())) {
    console.error('OmniRoute did not respond within 3 minutes.');
    return 1;
  }
  const cwd = cwdArg ? unb64(cwdArg) : os.homedir();
  // `=` form: the list flag would otherwise swallow the prompt that follows as another tool name.
  const claudeArgs = ['--model', COMBO, `--disallowedTools=${DISALLOWED_TOOLS}`];
  const transcriptPath = transcriptArg ? unb64(transcriptArg) : '';
  if (sessionId && transcriptPath && fs.existsSync(transcriptPath)) {
    const handoffFile = path.join(STATE_DIR, `${sessionId}-handoff.md`);
    fs.writeFileSync(handoffFile, buildHandoff(sessionId, cwd, transcriptPath));
    claudeArgs.push(
      `The Claude subscription usage limit was reached and this new session runs through OmniRoute. ` +
      `Read the handoff file ${handoffFile.replace(/\\/g, '/')} and continue the unfinished task it describes.`
    );
  }
  // Free upstreams sometimes stall a request without answering; retry after 2 minutes
  // instead of Claude Code's 10-minute default.
  const env = { ...process.env, API_TIMEOUT_MS: String(API_TIMEOUT_MS) };
  const result = spawnSync(process.execPath, [OMNIROUTE_CLI, 'launch', '--', ...claudeArgs], { cwd, env, stdio: 'inherit' });
  return result.status ?? 1;
}

const launchIndex = process.argv.indexOf('--launch');
if (launchIndex !== -1) {
  const [sessionId, cwdArg, transcriptArg] = process.argv.slice(launchIndex + 1);
  runLauncher(sessionId, cwdArg, transcriptArg).then((code) => process.exit(code));
} else {
  runHook().catch((err) => {
    process.stderr.write(`omniroute-fallback: ${err.message}\n`);
    process.exit(1);
  });
}
