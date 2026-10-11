#!/usr/bin/env node
// Turns the rate_limit fallback hook on or off via a flag file (settings.json is untouched).
// Usage: node toggle.js [on|off|status]  (no argument = status)
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'omniroute-fallback');
const DISABLED_FLAG = path.join(STATE_DIR, 'disabled');

const cmd = process.argv[2] || 'status';
if (!['on', 'off', 'status'].includes(cmd)) {
  console.error('usage: node toggle.js on|off|status');
  process.exit(1);
}
if (cmd === 'off') {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DISABLED_FLAG, new Date().toISOString());
} else if (cmd === 'on') {
  try {
    fs.unlinkSync(DISABLED_FLAG);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
console.log(`claude-limit-fallback: ${fs.existsSync(DISABLED_FLAG) ? 'OFF' : 'ON'}`);
