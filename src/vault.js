// Saved accounts. Tokens live in the macOS Keychain (one item per account, service
// "Claude Control Tower"); non-secret metadata, usage and settings live in CT_HOME/state.json.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as keychain from './keychain.js';
import { withLocks } from './lock.js';

export const DEFAULT_SETTINGS = { autoSwitch: true, threshold: 95 };

export function home() {
  return process.env.CT_HOME || join(homedir(), '.claude-control-tower');
}

// A non-default CT_HOME (tests) gets its own Keychain service, the same way Claude Code
// suffixes its item for a non-default CLAUDE_CONFIG_DIR.
function service() {
  if (!process.env.CT_HOME) return 'Claude Control Tower';
  return `Claude Control Tower-${createHash('sha256').update(home()).digest('hex').slice(0, 8)}`;
}

export const getTokens = (key) => keychain.readJson(service(), key);
export const setTokens = (key, tokens) => keychain.writeJson(service(), key, tokens);
export const deleteTokens = (key) => keychain.remove(service(), key);

export async function loadState() {
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(join(home(), 'state.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return {
    ...state,
    settings: { ...DEFAULT_SETTINGS, ...state.settings },
    accounts: state.accounts ?? {},
  };
}

export async function saveState(state) {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  const path = join(home(), 'state.json');
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, path);
}

// Serialises every read-modify-write of the vault across the daemon and CLI processes.
export async function withVaultLock(fn) {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  return withLocks([join(home(), 'vault.lock')], { stale: 120000, timeoutMs: 60000 }, fn);
}

export async function logEvent(type, message, extra = {}) {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: Date.now(), type, message, ...extra });
  await fs.appendFile(join(home(), 'events.jsonl'), `${line}\n`, { mode: 0o600 });
}

export async function recentEvents(limit = 50) {
  let text = '';
  try {
    text = await fs.readFile(join(home(), 'events.jsonl'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return text.trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
}
