// Everything about Claude Code's own on-disk login state. Mirrors Claude Code 2.1.296:
// - credentials: Keychain item "Claude Code-credentials[-<sha256(configDir)[:8]>]", account $USER.
//   The item also carries MCP OAuth tokens (mcpOAuth), so only claudeAiOauth is ever replaced.
// - identity: oauthAccount in ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json).
// - refresh coordination: proper-lockfile dirs <configDir>/.oauth_refresh.lock and <configDir>.lock.
// - config writes: <config file>.lock.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import * as keychain from './keychain.js';
import { withLocks } from './lock.js';

// The keys Claude Code's performLogout clears when the account changes (re-login keeps the rest).
export const ACCOUNT_CACHE_KEYS = [
  'additionalModelOptionsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelCostsCache',
  'modelAccessCache', 'orgModelDefaultCache', 'cachedArtifactRoster', 'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt', 'clientDataCache', 'clientDataCacheSlots', 'autoCompactWindowsCache',
  'cachedUsageUtilization', 'metricsStatusCache', 'metricsStatusCacheByPrincipal',
  'githubWebConnectionStatusCache', 'startupPrefetchedAt',
];

const REFRESH_LOCK_STALE_MS = 60000; // Claude Code's OAuth refresh lock
const CONFIG_LOCK_STALE_MS = 10000; // proper-lockfile default, used for ~/.claude.json

export function configDir(env = process.env) {
  return (env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).normalize('NFC');
}

export function credentialsService(env = process.env) {
  if (!env.CLAUDE_CONFIG_DIR) return 'Claude Code-credentials';
  return `Claude Code-credentials-${createHash('sha256').update(configDir(env)).digest('hex').slice(0, 8)}`;
}

export function keychainAccount() {
  let user;
  try {
    user = process.env.USER || userInfo().username;
  } catch {
    user = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user';
}

export function globalConfigPath(env = process.env) {
  const legacy = join(configDir(env), '.config.json');
  if (existsSync(legacy)) return legacy;
  return join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
}

function refreshLockPaths(env) {
  const dir = configDir(env);
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  return [join(dir, '.oauth_refresh.lock'), `${real}.lock`];
}

// Holds Claude Code's own refresh locks, so no Claude Code process can be mid-refresh
// (and rotate the refresh token) while we read or replace the stored login.
export async function withRefreshLock(fn, env = process.env) {
  await fs.mkdir(configDir(env), { recursive: true });
  return withLocks(refreshLockPaths(env), { stale: REFRESH_LOCK_STALE_MS }, fn);
}

export function readLiveItem(env = process.env) {
  return keychain.readJson(credentialsService(env), keychainAccount());
}

export function writeLiveItem(item, env = process.env) {
  return keychain.writeJson(credentialsService(env), keychainAccount(), item);
}

export function deleteLiveItem(env = process.env) {
  return keychain.remove(credentialsService(env), keychainAccount());
}

export async function readConfig(env = process.env) {
  try {
    return JSON.parse(await fs.readFile(globalConfigPath(env), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Same on-disk effect as Claude Code's /login for the config file: new oauthAccount,
// account-scoped caches dropped, everything else untouched. Done under Claude Code's config lock
// with an atomic rename, so a concurrent Claude Code write can't interleave with ours.
export async function setConfigAccount(oauthAccount, { backupPath } = {}) {
  const path = globalConfigPath();
  const real = await fs.realpath(path).catch(() => path);
  await withLocks([`${real}.lock`], { stale: CONFIG_LOCK_STALE_MS }, async () => {
    let text = '{}';
    let mode = 0o644;
    try {
      text = await fs.readFile(real, 'utf8');
      mode = (await fs.stat(real)).mode & 0o777;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const config = JSON.parse(text);
    if (backupPath) await fs.writeFile(backupPath, text, { mode: 0o600 });
    for (const key of ACCOUNT_CACHE_KEYS) delete config[key];
    config.oauthAccount = oauthAccount;
    const tmp = join(dirname(real), `.claude.json.ct-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
      await fs.rename(tmp, real);
    } finally { await fs.unlink(tmp).catch((err) => { if (err.code !== 'ENOENT') throw err; }); }
  });
}
