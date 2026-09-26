#!/usr/bin/env node
// Installs everything for claude-limit-fallback that does not need a human:
//   OmniRoute (npm -g), the StopFailure hook script + settings.json entry, the desktop
//   shortcut, and a running OmniRoute server. Safe to run again: each step checks first.
// Usage: node install.js [--home DIR] [--desktop DIR]   (defaults: your home and Desktop)
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

const HOME = opt('--home') || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOK_SRC = path.join(__dirname, 'omniroute-fallback.js');
const HOOK_DST = path.join(CLAUDE_DIR, 'hooks', 'omniroute-fallback.js');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const OMNIROUTE_CLI = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'omniroute', 'bin', 'omniroute.mjs');
const SERVE_VBS = path.join(__dirname, 'omniroute-serve.vbs');

const log = (status, msg) => console.log(`${status.padEnd(7)} ${msg}`);

function desktopDir() {
  return opt('--desktop') ||
    execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Desktop\')"', { encoding: 'utf8' }).trim();
}

function ensureOmniRoute() {
  if (fs.existsSync(OMNIROUTE_CLI)) return log('ok', 'OmniRoute already installed');
  log('run', 'npm install -g omniroute');
  execSync('npm install -g omniroute', { stdio: 'inherit' });
  if (!fs.existsSync(OMNIROUTE_CLI)) throw new Error(`OmniRoute CLI not found at ${OMNIROUTE_CLI} after install`);
  log('ok', 'OmniRoute installed');
}

function installHookScript() {
  fs.mkdirSync(path.dirname(HOOK_DST), { recursive: true });
  const same = fs.existsSync(HOOK_DST) && fs.readFileSync(HOOK_DST, 'utf8') === fs.readFileSync(HOOK_SRC, 'utf8');
  if (same) return log('ok', `hook script up to date: ${HOOK_DST}`);
  fs.copyFileSync(HOOK_SRC, HOOK_DST);
  log('write', `hook script: ${HOOK_DST}`);
}

function registerHook() {
  const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
  const hooks = settings.hooks || {};
  const groups = hooks.StopFailure || [];
  if (JSON.stringify(groups).includes('omniroute-fallback.js')) return log('ok', 'StopFailure hook already registered');

  const command = `node "${HOOK_DST.replace(/\\/g, '/')}"`;
  const entry = { matcher: 'rate_limit', hooks: [{ type: 'command', command, timeout: 30 }] };
  const next = { ...settings, hooks: { ...hooks, StopFailure: [...groups, entry] } };
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, backup);
    log('backup', backup);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n');
  log('write', `StopFailure hook registered in ${SETTINGS}`);
}

function writeShortcut() {
  const bat = path.join(desktopDir(), 'Claude-OmniRoute.bat');
  // ASCII only: cmd.exe reads .bat files in the OEM code page.
  const body = [
    '@echo off',
    'rem Manual fallback: opens a new Claude Code session through OmniRoute (combo "claude-fallback").',
    `"${process.execPath}" "%USERPROFILE%\\.claude\\hooks\\omniroute-fallback.js" --launch`,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
  if (fs.existsSync(bat) && fs.readFileSync(bat, 'utf8') === body) return log('ok', `shortcut up to date: ${bat}`);
  fs.writeFileSync(bat, body, 'ascii');
  log('write', `shortcut: ${bat}`);
}

function healthy() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 20128, path: '/api/monitoring/health', timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function ensureServer() {
  if (await healthy()) return log('ok', 'OmniRoute server running (http://localhost:20128/dashboard)');
  // explorer.exe runs the .vbs outside this process tree, so the server outlives the session.
  spawn('explorer.exe', [SERVE_VBS], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (await healthy()) return log('ok', 'OmniRoute server started (http://localhost:20128/dashboard)');
  }
  throw new Error('OmniRoute server did not answer within 3 minutes');
}

(async () => {
  ensureOmniRoute();
  installHookScript();
  registerHook();
  writeShortcut();
  await ensureServer();
  console.log('\nNext (needs a person or the logged-in dashboard): add provider keys, then run');
  console.log('scripts/omniroute-setup.browser.js in the dashboard tab, then node scripts/verify.js');
})().catch((err) => {
  console.error(`FAIL    ${err.message}`);
  process.exit(1);
});
