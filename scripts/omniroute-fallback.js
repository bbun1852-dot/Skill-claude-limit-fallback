#!/usr/bin/env node
// When a Claude subscription session hits its 5-hour or weekly limit, reopen the same
// conversation in a new window routed through OmniRoute and let it continue.
//
// Hook mode (StopFailure, matcher rate_limit): reads the hook JSON from stdin and opens
//   the launcher window via explorer.exe, so the window lives outside the app's process tree.
// Launch mode: node omniroute-fallback.js --launch [<session-id> <base64-cwd>]
//   Starts OmniRoute if needed, then runs Claude Code through the fallback combo.
//   Without a session id it opens a fresh session (used by the desktop shortcut).
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
// ArtifactData's input schema uses prefixItems, which OmniRoute's Gemini translation rejects.
const DISALLOWED_TOOLS = 'ArtifactData';
const CONTINUE_PROMPT =
  'The Claude subscription usage limit was reached, so this session now runs through OmniRoute. ' +
  'Continue the previous task from where it stopped.';

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

  // The .cmd must stay ASCII (cmd.exe reads it in the OEM code page), so the cwd travels as base64.
  const cwdArg = Buffer.from(projectDir, 'utf8').toString('base64');
  fs.writeFileSync(
    cmdFile,
    [
      '@echo off',
      'title Claude via OmniRoute',
      `"${process.execPath}" "${__filename}" --launch ${sessionId} ${cwdArg}`,
      'if errorlevel 1 pause',
      '',
    ].join('\r\n'),
    'ascii'
  );
  spawn('explorer.exe', [cmdFile], { detached: true, stdio: 'ignore' }).unref();
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

async function runLauncher(sessionId, cwdArg) {
  if (!(await ensureOmniRoute())) {
    console.error('OmniRoute did not respond within 3 minutes.');
    return 1;
  }
  const cwd = cwdArg ? Buffer.from(cwdArg, 'base64').toString('utf8') : os.homedir();
  const claudeArgs = ['--model', COMBO, '--disallowedTools', DISALLOWED_TOOLS];
  if (sessionId) claudeArgs.push('--resume', sessionId, '--fork-session', CONTINUE_PROMPT);
  const result = spawnSync(process.execPath, [OMNIROUTE_CLI, 'launch', '--', ...claudeArgs], { cwd, stdio: 'inherit' });
  return result.status ?? 1;
}

const launchIndex = process.argv.indexOf('--launch');
if (launchIndex !== -1) {
  runLauncher(process.argv[launchIndex + 1], process.argv[launchIndex + 2]).then((code) => process.exit(code));
} else {
  runHook().catch((err) => {
    process.stderr.write(`omniroute-fallback: ${err.message}\n`);
    process.exit(1);
  });
}
