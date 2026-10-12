import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as keychain from '../src/keychain.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureDir = join(root, 'test', 'fixtures');

const test = base.extend({
  monitor: [false, { option: true }],
  tower: async ({ request, monitor }, use) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ct-playwright-'));
    const env = { ...process.env, CT_HOME: join(dir, 'vault'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CT_TEST_KEYCHAIN: join(dir, 'keychain.json'), PATH: `${fixtureDir}:${process.env.PATH}` };
    env.CT_TEST_MONITOR = String(monitor);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name];
    const child = spawn(process.execPath, [join(fixtureDir, 'environment.js')], { env, cwd: root });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const addresses = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Fixture timeout: ${stderr}`)); }, 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0])); }
      });
      child.once('error', reject);
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
    });
    env.CT_ANTHROPIC_BASE = addresses.mock;
    const tower = {
      ...addresses, env, dir,
      control: async (data) => { const res = await request.post(`${addresses.mock}/test/control`, { data }); expect(res.ok()).toBeTruthy(); },
      inspect: async () => (await request.get(`${addresses.mock}/test/inspect`)).json(),
      api: async (path, data = {}) => {
        const state = await (await request.get(`${addresses.url}/api/state`)).json();
        return request.post(`${addresses.url}/api/${path}`, { data, headers: { 'X-CT-Token': state.nonce } });
      },
      cli: (args, overrides = {}) => new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['bin/ct.js', ...args], { cwd: root, env: { ...env, ...overrides } });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.stderr.on('data', (chunk) => { stderr += chunk; });
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
      }),
    };
    try { await use(tower); }
    finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      await fs.chmod(join(env.CT_HOME, 'read-only'), 0o700).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
});

async function capture(page, tower, id, label = id) {
  await tower.control({ live: { id } });
  await page.goto(tower.url);
  await page.getByLabel('Account name').fill(label);
  await page.getByRole('button', { name: 'Save current login' }).click();
  await expect(page.getByRole('status')).toContainText('Current login saved');
  await expect(page.getByRole('heading', { name: label, exact: true }).last()).toBeVisible();
}
const card = (page, label) => page.locator('article').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
async function poll(page) {
  const response = page.waitForResponse((response) => response.url().endsWith('/api/poll') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Check usage' }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('Usage checked.');
}

test('empty dashboard, accessibility labels, mobile layout and browser errors', async ({ page, tower }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(tower.url);
  await expect(page).toHaveTitle('TokenMaxer');
  await expect(page.getByText('No saved accounts yet.')).toBeVisible();
  await expect(page.getByText('Monitor paused', { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByLabel('Account name').fill('Missing');
  await page.getByRole('button', { name: 'Save current login' }).click();
  await expect(page.getByRole('status')).toContainText('No Claude subscription login found');
  await page.screenshot({ path: join('test-results', 'empty-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('captures, switches, preserves MCP/config, protects active deletion and keeps tokens private', async ({ page, tower, request }) => {
  await capture(page, tower, 'alpha', 'Personal');
  await capture(page, tower, 'beta', 'Work');
  await card(page, 'Personal').getByRole('button', { name: 'Use account' }).click();
  await expect(card(page, 'Personal').getByText('ACTIVE')).toBeVisible();
  await expect(card(page, 'Personal').getByRole('button', { name: 'Remove' })).toBeDisabled();
  const live = await tower.inspect();
  expect(live.live.claudeAiOauth.accessToken).toBe('access-alpha');
  expect(live.live.mcpOAuth.retained).toBe('mcp-keep-me');
  expect(live.config.oauthAccount.accountUuid).toBe('alpha');
  expect(live.config.theme).toBe('dark');
  expect(live.config.projects).toEqual({ keep: true });
  expect(live.config.modelAccessCache).toBeUndefined();
  const body = await (await request.get(`${tower.url}/api/state`)).text();
  expect(body).not.toContain('access-alpha');
  expect(body).not.toContain('refresh-alpha');
  const disk = await fs.readFile(join(tower.env.CT_HOME, 'state.json'), 'utf8');
  expect(disk).not.toContain('accessToken');
  expect((await fs.stat(join(tower.env.CT_HOME, 'state.json'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(join(tower.env.CT_HOME, 'claude-config.backup.json'))).mode & 0o777).toBe(0o600);
  await card(page, 'Work').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('article')).toHaveCount(1);
  const activeKey = Object.values(JSON.parse(disk).accounts).find((value) => value.label === 'Personal').key;
  expect((await tower.api('remove', { key: activeKey })).status()).toBe(400);
  await page.reload();
  await expect(card(page, 'Personal').getByText('ACTIVE')).toBeVisible();
});

test('automatically selects lowest usage across all windows and switches again after reset', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await capture(page, tower, 'gamma');
  await tower.control({ live: { id: 'alpha' }, accounts: { alpha: { five: 96 }, beta: { five: 20, week: 98 }, gamma: { five: 8, week: 12 } } });
  await poll(page);
  await expect(card(page, 'gamma').getByText('ACTIVE')).toBeVisible();
  expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('gamma');
  await tower.control({ accounts: { alpha: { five: 0, week: 0, sonnet: 0 }, gamma: { scoped: 100 } } });
  await poll(page);
  await expect(card(page, 'alpha').getByText('ACTIVE')).toBeVisible();
  await page.screenshot({ path: join('test-results', 'accounts-desktop.png'), fullPage: true });
});

test('settings survive reload and disabled switching stays on the current account', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await tower.control({ accounts: { beta: { five: 99 } } });
  await page.getByLabel('Enabled').uncheck();
  await page.getByLabel('Switch at').fill('80');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Settings saved.');
  await poll(page);
  await expect(card(page, 'beta').getByText('ACTIVE')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Enabled')).not.toBeChecked();
  await expect(page.getByLabel('Switch at')).toHaveValue('80');
  for (const threshold of [0, 101, '95']) expect((await tower.api('settings', { autoSwitch: true, threshold })).status()).toBe(400);
});

test('no eligible account warns and failed usage does not reuse stale capacity', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await poll(page);
  await tower.control({ accounts: { beta: { five: 100 }, alpha: { networkError: true } } });
  await poll(page);
  await expect(card(page, 'beta').getByText('ACTIVE')).toBeVisible();
  await expect(page.locator('#warning')).toContainText('No saved account has verified capacity');
  await expect(card(page, 'alpha').getByText('Anthropic returned HTTP 503.')).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain('access-alpha');
});

test('expired and 401 tokens refresh, rotate in Keychain and preserve the current login', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await tower.control({ live: { id: 'alpha', expired: true } });
  await poll(page);
  const renewed = await tower.inspect();
  expect(renewed.refreshes).toEqual(['refresh-alpha']);
  expect(renewed.live.claudeAiOauth.accessToken).toBe('access-alpha:renewed');
  expect(renewed.live.mcpOAuth.retained).toBe('mcp-keep-me');
  await tower.control({ live: { id: 'alpha' }, accounts: { alpha: { unauthorized: true } } });
  await poll(page);
  expect((await tower.inspect()).refreshes).toEqual(['refresh-alpha', 'refresh-alpha']);
  await expect(card(page, 'alpha').locator('.error')).toHaveCount(0);
});

test('external Claude token rotation is saved before refresh', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await tower.control({ live: { id: 'alpha', suffix: ':external' } });
  await poll(page);
  const snapshot = await tower.inspect();
  expect(snapshot.refreshes).toEqual([]);
  const saved = Object.entries(snapshot.store).filter(([key]) => key.startsWith('Claude Control Tower')).map(([, value]) => JSON.parse(value));
  expect(saved[0].refreshToken).toBe('refresh-alpha:external');
});

test('invalid grants and malformed refresh results keep failed accounts out of selection', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await tower.control({ live: { id: 'alpha', expired: true }, accounts: { alpha: { invalidGrant: true } } });
  await poll(page);
  await expect(card(page, 'alpha').locator('.error')).toContainText('login expired');
  expect((await tower.inspect()).live.claudeAiOauth.accessToken).toBe('access-alpha');
  await tower.control({ accounts: { alpha: { invalidGrant: false, malformedRefresh: true } } });
  await poll(page);
  await expect(card(page, 'alpha').locator('.error')).toContainText('invalid refreshed credentials');
  expect((await tower.inspect()).live.claudeAiOauth.accessToken).toBe('access-alpha');
});

test('unknown current login and malformed usage never cause an automatic switch', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await tower.control({ live: { id: 'unknown' }, accounts: { unknown: { five: 100 } } });
  await poll(page);
  await expect(page.locator('#warning')).toContainText('current Claude login is not saved');
  expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('unknown');
  await tower.control({ live: { id: 'alpha' }, accounts: { alpha: { malformedUsage: true } } });
  await poll(page);
  await expect(card(page, 'alpha').locator('.error')).toContainText('Usage is unavailable');
});

test('rejects CSRF, host spoofing, invalid routes, input and oversized requests', async ({ tower, request }) => {
  const url = tower.url;
  expect((await request.post(`${url}/api/poll`, { data: {} })).status()).toBe(403);
  const state = await (await request.get(`${url}/api/state`)).json();
  expect((await request.post(`${url}/api/poll`, { data: {}, headers: { 'X-CT-Token': state.nonce, Origin: 'https://evil.test' } })).status()).toBe(403);
  expect((await request.get(`${url}/api/state`, { headers: { Host: 'evil.test' } })).status()).toBe(403);
  expect((await request.get(`${url}/../src/vault.js`)).status()).toBe(404);
  expect((await tower.api('capture', { label: ' ' })).status()).toBe(400);
  expect((await tower.api('capture', { label: 'x'.repeat(81) })).status()).toBe(400);
  expect((await tower.api('switch', { key: 'missing' })).status()).toBe(400);
  expect((await tower.api('not-a-route')).status()).toBe(404);
  expect((await tower.api('capture', { label: 'x'.repeat(9000) })).status()).toBe(413);
});

test('names render as text and repeat captures update the existing account', async ({ page, tower }) => {
  const label = '<img src=x onerror=alert(1)> 😺';
  await capture(page, tower, 'alpha', label);
  expect(await page.locator('article img').count()).toBe(0);
  await capture(page, tower, 'alpha', 'Renamed');
  await expect(page.locator('article')).toHaveCount(1);
  await expect(card(page, 'Renamed')).toBeVisible();
});

test('CLI login is isolated, persists account, cleans temporary credentials, run forwards arguments', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  const before = await tower.inspect();
  const login = await tower.cli(['login', 'New account']);
  expect(login.code, login.stderr).toBe(0);
  expect(login.stdout).toContain('Saved New account');
  const after = await tower.inspect();
  expect(after.live).toEqual(before.live);
  expect(after.config.oauthAccount).toEqual(before.config.oauthAccount);
  expect((await fs.readdir(tower.env.CT_HOME)).filter((name) => name.startsWith('login-'))).toEqual([]);
  expect(Object.keys(after.store).filter((key) => key.startsWith('Claude Code-credentials'))).toHaveLength(1);
  const switched = await tower.cli(['switch', 'New account']);
  expect(switched.code, switched.stderr).toBe(0);
  expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('login');
  const run = await tower.cli(['run', '--', '--continue', '--model', 'sonnet']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(join(tower.env.CT_HOME, 'claude-run.json'), 'utf8'))).toEqual(['--continue', '--model', 'sonnet']);
  const status = await tower.cli(['status']);
  expect(status.stdout).toContain('* New account');
  expect(status.stdout).not.toContain('access-login');
});

test('credential override blocks switching and duplicate CLI names need a key', async ({ page, tower }) => {
  await capture(page, tower, 'alpha', 'Same');
  await capture(page, tower, 'beta', 'Same');
  const duplicate = await tower.cli(['switch', 'Same']);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain('matches multiple accounts');
  const key = (await (await fetch(`${tower.url}/api/state`)).json()).accounts[0].key;
  const blocked = await tower.cli(['switch', key], { ANTHROPIC_API_KEY: 'fake-key' });
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain('ANTHROPIC_API_KEY');
  expect(blocked.stderr).not.toContain('fake-key');
  expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('beta');
});

test('locked Keychain and oversized live items leave credentials unchanged', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await tower.control({ locked: true });
  await card(page, 'alpha').getByRole('button', { name: 'Use account' }).click();
  await expect(page.getByRole('status')).toContainText('keychain is locked');
  await tower.control({ locked: false, largeLive: true });
  const before = await tower.inspect();
  await card(page, 'alpha').getByRole('button', { name: 'Use account' }).click();
  await expect(page.getByRole('status')).toContainText('too large for a secure Keychain write');
  expect((await tower.inspect()).live).toEqual(before.live);
  expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('beta');
});

test('failed identity write rolls back the Keychain switch', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await tower.control({ readOnlyConfig: true });
  const before = await tower.inspect();
  await card(page, 'alpha').getByRole('button', { name: 'Use account' }).click();
  await expect(page.getByRole('status')).toContainText('EACCES');
  expect((await tower.inspect()).live).toEqual(before.live);
  expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('beta');
});

test('concurrent CLI and browser operations serialize without losing settings or tokens', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  const results = await Promise.all([
    tower.cli(['poll']),
    tower.api('settings', { autoSwitch: false, threshold: 80 }),
    tower.cli(['switch', 'alpha']),
  ]);
  expect(results[0].code, results[0].stderr).toBe(0);
  expect(results[1].status()).toBe(200);
  expect(results[2].code, results[2].stderr).toBe(0);
  await page.reload();
  await expect(card(page, 'alpha').getByText('ACTIVE')).toBeVisible();
  await expect(page.getByLabel('Switch at')).toHaveValue('80');
  await expect(page.getByLabel('Enabled')).not.toBeChecked();
});

test('real macOS Keychain round-trips long Unicode JSON without process-argument secrets', async () => {
  test.skip(process.platform !== 'darwin');
  const service = `Claude Control Tower Self Test-${process.pid}-${Date.now()}`;
  const account = 'ct-self-test';
  const payload = { quoted: 'say "hi"', apostrophe: "O'Brien", unicode: '😺 é', literal: '\\u00e9', long: 'x'.repeat(2500) };
  try {
    await keychain.writeJson(service, account, payload);
    expect(await keychain.readJson(service, account)).toEqual(payload);
    await expect(keychain.writeJson(service, account, { long: 'x'.repeat(5000) })).rejects.toThrow('too large');
    expect(await keychain.readJson(service, account)).toEqual(payload);
  } finally { await keychain.remove(service, account); }
});

test('recovers a token rotation interrupted between vault and live writes', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await tower.control({ pendingRefresh: 'alpha' });
  await poll(page);
  const snapshot = await tower.inspect();
  expect(snapshot.live.claudeAiOauth.accessToken).toBe('access-alpha:pending');
  expect(snapshot.live.claudeAiOauth.refreshToken).toBe('refresh-alpha:pending');
  expect(snapshot.refreshes).toEqual([]);
  expect(snapshot.calls.some((value) => value.path === '/api/oauth/usage' && value.token === 'access-alpha:pending')).toBeTruthy();
});

test('logged-out credentials are not displayed as an active account', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await tower.control({ noLogin: true });
  await page.reload();
  await expect(page.locator('article .badge')).toHaveCount(0);
  await expect(card(page, 'alpha').getByRole('button', { name: 'Use account' })).toBeEnabled();
  await card(page, 'alpha').getByRole('button', { name: 'Use account' }).click();
  await expect(card(page, 'alpha').getByText('ACTIVE')).toBeVisible();
});

test('a mismatched refreshed identity cannot overwrite the current login', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await tower.control({ live: { id: 'alpha', expired: true }, accounts: { alpha: { wrongIdentity: true } } });
  await poll(page);
  await expect(card(page, 'alpha').locator('.error')).toContainText('different account');
  const snapshot = await tower.inspect();
  expect(snapshot.live.claudeAiOauth.accessToken).toBe('access-alpha');
  expect(snapshot.config.oauthAccount.accountUuid).toBe('alpha');
});

test('the monitor respects an explicit logout even when the saved account is exhausted', async ({ page, tower }) => {
  await capture(page, tower, 'alpha');
  await capture(page, tower, 'beta');
  await tower.control({ noLogin: true, accounts: { beta: { five: 100 } } });
  await poll(page);
  expect((await tower.inspect()).live).toBeNull();
  await expect(page.locator('article .badge')).toHaveCount(0);
});

test.describe('background monitoring', () => {
  test.use({ monitor: true });
  test('switches without clicking Check usage', async ({ page, tower }) => {
    await capture(page, tower, 'alpha');
    await capture(page, tower, 'beta');
    await tower.control({ accounts: { beta: { five: 99 } } });
    await expect(card(page, 'alpha').getByText('ACTIVE')).toBeVisible();
    expect((await tower.inspect()).config.oauthAccount.accountUuid).toBe('alpha');
    await expect(page.locator('#monitor-status')).toContainText('Monitor running');
  });
});
