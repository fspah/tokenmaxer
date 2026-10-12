import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as claude from './claude.js';
import * as vault from './vault.js';
import { fetchProfile, fetchUsage, refreshTokens } from './api.js';

const keyFor = (identity) => identity?.accountUuid
  ? createHash('sha256').update(`${identity.accountUuid}:${identity.organizationUuid || ''}`).digest('hex').slice(0, 24)
  : null;
const tokenHash = (tokens) => createHash('sha256').update(tokens.accessToken).digest('hex');

function labelValue(label) {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 80) throw new Error('Enter an account name between 1 and 80 characters.');
  return label.trim();
}

export function usageWindows(usage) {
  if (!usage || typeof usage !== 'object') return [];
  return Object.entries(usage).filter(([name]) => name === 'five_hour' || name.startsWith('seven_day')).map(([name, value]) => ({ name, ...value }))
    .concat((usage.model_scoped ?? []).map((value) => ({ ...value, name: `Weekly ${value.display_name || value.model}` })))
    .concat((Array.isArray(usage.limits) ? usage.limits : [])
      .filter((value) => value?.kind === 'weekly_scoped' && typeof value.scope?.model?.display_name === 'string')
      .map((value) => ({ name: `Weekly ${value.scope.model.display_name}`, utilization: value.percent, resets_at: value.resets_at })))
    .filter((value) => Number.isFinite(value.utilization));
}

export function utilization(usage) {
  const values = usageWindows(usage);
  return values.length ? Math.max(...values.map((value) => value.utilization)) : null;
}

async function syncLive(state, env = process.env) {
  const identity = (await claude.readConfig(env)).oauthAccount;
  const key = keyFor(identity);
  let item = await claude.readLiveItem(env);
  const tokens = item?.claudeAiOauth;
  state.active = tokens?.accessToken ? key : null;
  const account = state.accounts[key];
  if (account && tokens?.accessToken) {
    const hash = tokenHash(tokens);
    const saved = await vault.getTokens(key);
    if (hash === account.liveTokenHash && saved?.accessToken && saved.accessToken !== tokens.accessToken) {
      // Recover a refresh interrupted after the vault write but before the live Keychain write.
      item = { ...item, claudeAiOauth: saved };
      await claude.writeLiveItem(item, env);
      account.liveTokenHash = tokenHash(saved);
    } else {
      await vault.setTokens(key, tokens);
      account.liveTokenHash = hash;
    }
  }
  return { key, item, identity, account };
}

async function renew(key, tokens, identity, live) {
  if (!tokens?.refreshToken) throw new Error('This account needs a new login. Run ct login.');
  const result = await refreshTokens(tokens);
  if ((result.accountUuid && result.accountUuid !== identity.accountUuid) ||
      (result.organizationUuid && result.organizationUuid !== identity.organizationUuid)) {
    throw new Error('Refreshed credentials belong to a different account. Run ct login.');
  }
  // Persist rotated tokens before further requests.
  await vault.setTokens(key, result.tokens);
  if (live.key === key) {
    live.item = { ...live.item, claudeAiOauth: result.tokens };
    await claude.writeLiveItem(live.item);
    live.account.liveTokenHash = tokenHash(result.tokens);
  }
  return result.tokens;
}

async function accountUsage(key, account, live) {
  let tokens = await vault.getTokens(key);
  if (!tokens?.accessToken) throw new Error('Saved credentials are missing. Run ct login.');
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60000) tokens = await renew(key, tokens, account.identity, live);
  let usage;
  try { usage = await fetchUsage(tokens.accessToken); }
  catch (err) {
    if (err.status !== 401) throw err;
    tokens = await renew(key, tokens, account.identity, live);
    usage = await fetchUsage(tokens.accessToken);
  }
  if (utilization(usage) === null) throw new Error('Usage is unavailable for this account.');
  account.usage = usage;
  account.checkedAt = Date.now();
  account.error = null;
  return tokens;
}

async function activate(state, key, live, reason) {
  const account = state.accounts[key];
  if (!account) throw new Error('Account not found.');
  if (live.key === key && live.item?.claudeAiOauth?.accessToken) return false;
  let tokens = await vault.getTokens(key);
  if (!tokens?.accessToken) throw new Error('Saved credentials are missing. Run ct login.');
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60000) tokens = await renew(key, tokens, account.identity, live);
  let profile;
  try { profile = await fetchProfile(tokens.accessToken); }
  catch (err) {
    if (err.status !== 401) throw err;
    tokens = await renew(key, tokens, account.identity, live);
    profile = await fetchProfile(tokens.accessToken);
  }
  if (profile.account?.uuid !== account.identity.accountUuid || profile.organization?.uuid !== account.identity.organizationUuid) throw new Error('Saved credentials belong to a different account. Run ct login.');
  // Preserve MCP and other credentials. Roll back the Keychain if the identity file cannot be saved.
  await claude.writeLiveItem({ ...live.item, claudeAiOauth: tokens });
  try { await claude.setConfigAccount(account.identity, { backupPath: join(vault.home(), 'claude-config.backup.json') }); }
  catch (err) {
    if (live.item) await claude.writeLiveItem(live.item);
    else await claude.deleteLiveItem();
    throw err;
  }
  state.active = key;
  account.liveTokenHash = tokenHash(tokens);
  state.lastSwitchAt = Date.now();
  await vault.saveState(state);
  await vault.logEvent('switch', `Switched to ${account.label}. ${reason}`, { key });
  return true;
}

function locked(fn, env = process.env) {
  return vault.withVaultLock(() => claude.withRefreshLock(async () => fn(await vault.loadState()), env));
}

export async function capture(label, env = process.env) {
  label = labelValue(label);
  return locked(async (state) => {
    const item = await claude.readLiveItem(env);
    const tokens = item?.claudeAiOauth;
    if (!tokens?.accessToken) throw new Error('No Claude subscription login found. Run ct login first.');
    const profile = await fetchProfile(tokens.accessToken);
    if (!profile.account?.uuid || !profile.organization?.uuid) throw new Error('Claude did not return a complete account identity.');
    const identity = {
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email || profile.account.email_address,
      organizationUuid: profile.organization.uuid,
      organizationName: profile.organization.name,
      displayName: profile.account.display_name,
      hasExtraUsageEnabled: profile.organization.has_extra_usage_enabled,
      billingType: profile.organization.billing_type,
    };
    const key = keyFor(identity);
    await vault.setTokens(key, tokens);
    state.accounts[key] = { ...state.accounts[key], key, label, identity, subscription: tokens.subscriptionType, liveTokenHash: tokenHash(tokens), addedAt: state.accounts[key]?.addedAt ?? Date.now(), error: null };
    await vault.saveState(state);
    await vault.logEvent('capture', `Saved ${label}.`, { key });
    return key;
  }, env);
}

export async function poll({ auto = true } = {}) {
  return locked(async (state) => {
    const live = await syncLive(state);
    const fresh = new Set();
    for (const [key, account] of Object.entries(state.accounts)) {
      try { await accountUsage(key, account, live); fresh.add(key); }
      catch (err) { account.error = err.message; }
    }
    state.lastPollAt = Date.now();
    const current = state.accounts[live.key];
    // Never change an unknown/unsaved login or choose an account using stale usage.
    if (auto && state.settings.autoSwitch && live.item?.claudeAiOauth?.accessToken && current && fresh.has(live.key) && utilization(current.usage) >= state.settings.threshold && !credentialOverrides().length) {
      const candidates = Object.entries(state.accounts).filter(([key, account]) => key !== live.key && fresh.has(key) && utilization(account.usage) < state.settings.threshold)
        .sort((a, b) => utilization(a[1].usage) - utilization(b[1].usage));
      if (candidates.length) await activate(state, candidates[0][0], live, 'Usage threshold reached.');
    }
    await vault.saveState(state);
    return state;
  });
}

export async function switchAccount(key) {
  if (credentialOverrides().length) throw new Error(`Unset these credential overrides before switching: ${credentialOverrides().join(', ')}.`);
  return locked(async (state) => {
    const live = await syncLive(state);
    await activate(state, key, live, 'Manual switch.');
    await vault.saveState(state);
  });
}

export async function removeAccount(key) {
  return locked(async (state) => {
    const live = await syncLive(state);
    if (!state.accounts[key]) throw new Error('Account not found.');
    if (live.key === key) throw new Error('Switch to another account before removing the active account.');
    await vault.deleteTokens(key);
    delete state.accounts[key];
    await vault.saveState(state);
    await vault.logEvent('remove', 'Removed saved account.', { key });
  });
}

export async function updateSettings(settings) {
  if (typeof settings.autoSwitch !== 'boolean' || !Number.isFinite(settings.threshold) || settings.threshold < 1 || settings.threshold > 100) throw new Error('Threshold must be between 1 and 100, and autoSwitch must be a boolean.');
  return vault.withVaultLock(async () => {
    const state = await vault.loadState();
    state.settings = { autoSwitch: settings.autoSwitch, threshold: settings.threshold };
    await vault.saveState(state);
  });
}

export function credentialOverrides() {
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].filter((name) => Boolean(process.env[name]) && process.env[name] !== '0' && process.env[name] !== 'false');
}

export async function status() {
  const state = await vault.loadState();
  const identity = (await claude.readConfig()).oauthAccount;
  let active = keyFor(identity);
  let credentialError;
  try { if (!(await claude.readLiveItem())?.claudeAiOauth?.accessToken) active = null; }
  catch (err) { credentialError = err.message; }
  return {
    settings: state.settings, active, lastPollAt: state.lastPollAt, lastSwitchAt: state.lastSwitchAt,
    overrides: credentialOverrides(), credentialError,
    accounts: Object.values(state.accounts).map((account) => ({
      key: account.key, label: account.label, email: account.identity.emailAddress,
      organization: account.identity.organizationName, subscription: account.subscription,
      usage: usageWindows(account.usage), utilization: utilization(account.usage), checkedAt: account.checkedAt, error: account.error,
    })),
    events: await vault.recentEvents(),
  };
}
