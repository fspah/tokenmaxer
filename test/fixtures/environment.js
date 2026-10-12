import http from 'node:http';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import * as claude from '../../src/claude.js';

const accounts = {};
const refreshes = [];
const calls = [];
const configPath = join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
await fs.writeFile(configPath, JSON.stringify({ theme: 'dark', projects: { keep: true }, modelAccessCache: { old: true }, oauthAccount: null }));
function account(id) { return accounts[id] ??= { five: 10, week: 15, sonnet: 5 }; }
async function setLive(data) {
  const { id, expired = false, suffix = '' } = data;
  await claude.writeLiveItem({
    mcpOAuth: { retained: 'mcp-keep-me' },
    claudeAiOauth: { accessToken: `access-${id}${suffix}`, refreshToken: `refresh-${id}${suffix}`, expiresAt: Date.now() + (expired ? -1000 : 3600000), scopes: ['user:profile', 'user:inference'], subscriptionType: 'max' },
  });
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.oauthAccount = { accountUuid: id, organizationUuid: `org-${id}`, emailAddress: `${id}@example.test` };
  await fs.writeFile(configPath, JSON.stringify(config));
  account(id);
}

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const data = raw ? JSON.parse(raw) : {};
  const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/test/control') {
    if (data.live) await setLive(data.live);
    for (const [id, changes] of Object.entries(data.accounts ?? {})) Object.assign(account(id), changes);
    if (data.locked !== undefined) {
      const store = JSON.parse(await fs.readFile(process.env.CT_TEST_KEYCHAIN, 'utf8').catch(() => '{}'));
      store.locked = data.locked;
      await fs.writeFile(process.env.CT_TEST_KEYCHAIN, JSON.stringify(store));
    }
    if (data.noLogin) await claude.deleteLiveItem();
    if (data.pendingRefresh) {
      const vault = await import('../../src/vault.js');
      const state = await vault.loadState();
      const saved = Object.values(state.accounts).find((value) => value.identity.accountUuid === data.pendingRefresh);
      const tokens = await vault.getTokens(saved.key);
      await vault.setTokens(saved.key, { ...tokens, accessToken: `access-${data.pendingRefresh}:pending`, refreshToken: `refresh-${data.pendingRefresh}:pending`, expiresAt: Date.now() + 3600000 });
    }
    if (data.largeLive) {
      const store = JSON.parse(await fs.readFile(process.env.CT_TEST_KEYCHAIN, 'utf8'));
      const key = `${claude.credentialsService()}|${claude.keychainAccount()}`;
      const item = JSON.parse(store[key]);
      item.mcpOAuth.large = 'x'.repeat(5000);
      store[key] = JSON.stringify(item);
      await fs.writeFile(process.env.CT_TEST_KEYCHAIN, JSON.stringify(store));
    }
    if (data.readOnlyConfig) {
      const dir = join(process.env.CT_HOME, 'read-only');
      await fs.mkdir(dir, { recursive: true });
      const dest = join(dir, 'config.json');
      await fs.copyFile(configPath, dest);
      await fs.unlink(configPath);
      await fs.symlink(dest, configPath);
      await fs.chmod(dir, 0o500);
    }
    return json(200, { ok: true });
  }
  if (req.url === '/test/inspect') {
    return json(200, {
      config: JSON.parse(await fs.readFile(configPath, 'utf8')),
      live: await claude.readLiveItem(),
      store: JSON.parse(await fs.readFile(process.env.CT_TEST_KEYCHAIN, 'utf8').catch(() => '{}')),
      refreshes, calls,
    });
  }
  if (req.url === '/v1/oauth/token') {
    const id = data.refresh_token.replace(/^refresh-/, '').split(':')[0];
    const entry = account(id);
    refreshes.push(data.refresh_token);
    if (entry.invalidGrant) return json(400, { error: 'invalid_grant' });
    if (entry.malformedRefresh) return json(200, { access_token: '' });
    return json(200, { access_token: `access-${id}:renewed`, refresh_token: `refresh-${id}:renewed`, expires_in: 3600, scope: 'user:profile user:inference', account: { uuid: entry.wrongIdentity ? 'wrong' : id }, organization: { uuid: `org-${id}` } });
  }
  const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const id = token.replace(/^access-/, '').split(':')[0];
  const entry = account(id);
  calls.push({ path: req.url, token });
  if (entry.networkError) return json(503, { error: { message: `secret ${token}` } });
  if (req.url === '/api/oauth/profile') return json(200, { account: { uuid: id, email: `${id}@example.test`, display_name: id }, organization: { uuid: `org-${id}`, name: `Org ${id}`, has_extra_usage_enabled: false } });
  if (req.url === '/api/oauth/usage') {
    if (entry.unauthorized && !token.includes(':renewed')) return json(401, { error: 'unauthorized' });
    if (entry.malformedUsage) return json(200, {});
    const resets_at = new Date(Date.now() + 3600000).toISOString();
    return json(200, { five_hour: { utilization: entry.five, resets_at }, seven_day: { utilization: entry.week, resets_at }, seven_day_sonnet: { utilization: entry.sonnet, resets_at }, ...(entry.scoped !== undefined ? { model_scoped: [{ display_name: 'Opus', utilization: entry.scoped, resets_at }] } : {}) });
  }
  json(404, { error: 'not found' });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
process.env.CT_ANTHROPIC_BASE = `http://127.0.0.1:${mock.address().port}`;
// API constants are evaluated on import; import the app after setting the fake endpoint.
const { serve: start } = await import(`../../src/server.js?isolated=${Date.now()}`);
const server = await start({ port: 0, monitor: process.env.CT_TEST_MONITOR === 'true', interval: 500 });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, mock: process.env.CT_ANTHROPIC_BASE }));
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); mock.close(); mock.closeAllConnections(); });
