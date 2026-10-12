#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as controller from '../src/controller.js';
import * as claude from '../src/claude.js';
import * as vault from '../src/vault.js';
import { serve } from '../src/server.js';

const help = `TokenMaxer (macOS, Node 20+)

  ct serve [--port 4317] [--no-monitor]  Open local dashboard and monitor usage
  ct capture <name>                    Save the current Claude login in Keychain
  ct login <name>                      Log in once and save another account
  ct status                            List saved accounts and usage
  ct poll                              Check usage and switch at the threshold
  ct switch <name-or-key>               Activate a saved account
  ct remove <name-or-key>               Remove an inactive saved account
  ct run [--] [claude arguments]        Check accounts, then launch Claude
  ct install-daemon                    Start dashboard automatically at login
  ct uninstall-daemon                  Stop and remove the login daemon

Existing Claude sessions may need a restart: claude --continue
Tokens stay in macOS Keychain. New accounts require one browser login.
`;

async function childExit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function login(label) {
  if (!label?.trim() || label.trim().length > 80) throw new Error('Provide an account name between 1 and 80 characters.');
  await fs.mkdir(vault.home(), { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(join(vault.home(), 'login-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const name of controller.credentialOverrides()) delete env[name];
  try {
    const code = await childExit('claude', ['auth', 'login', '--claudeai'], { env });
    if (code !== 0) throw new Error(`Claude login exited with code ${code}.`);
    const key = await controller.capture(label, env);
    console.log(`Saved ${label} (${key}) in macOS Keychain. Use ct switch "${label}" to activate it.`);
  } finally {
    await claude.deleteLiveItem(env);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function resolveAccount(value) {
  const { accounts } = await controller.status();
  const matches = accounts.filter((account) => account.key === value || account.label === value);
  if (matches.length !== 1) throw new Error(matches.length ? 'That name matches multiple accounts. Use the account key from ct status.' : 'Account not found. Run ct status.');
  return matches[0].key;
}

const daemonLabel = 'local.claude-control-tower';
const daemonPath = join(homedir(), 'Library', 'LaunchAgents', `${daemonLabel}.plist`);
const xml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

async function daemon(install) {
  const domain = `gui/${process.getuid()}`;
  if (!install) {
    await childExit('launchctl', ['bootout', `${domain}/${daemonLabel}`], { stdio: 'ignore' });
    await fs.rm(daemonPath, { force: true });
    console.log('Login daemon removed. Saved accounts were kept.');
    return;
  }
  await fs.mkdir(vault.home(), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  const env = { PATH: process.env.PATH, ...(process.env.CT_HOME ? { CT_HOME: process.env.CT_HOME } : {}), ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}) };
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${daemonLabel}</string>
<key>ProgramArguments</key><array>${[process.execPath, fileURLToPath(import.meta.url), 'serve'].map((value) => `<string>${xml(value)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(vault.home(), 'daemon.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(vault.home(), 'daemon.log'))}</string>
</dict></plist>\n`;
  await fs.writeFile(daemonPath, content, { mode: 0o600 });
  await fs.writeFile(join(vault.home(), 'daemon.log'), '', { mode: 0o600, flag: 'a' });
  await childExit('launchctl', ['bootout', `${domain}/${daemonLabel}`], { stdio: 'ignore' });
  if (await childExit('launchctl', ['bootstrap', domain, daemonPath])) throw new Error('Could not start the login daemon. Stop any existing server on port 4317 and try again.');
  console.log('Login daemon installed. Dashboard: http://127.0.0.1:4317');
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (process.platform !== 'darwin') throw new Error('This version requires macOS Keychain.');
  switch (command) {
    case 'serve': {
      let port = 4317;
      let monitor = true;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--no-monitor') monitor = false;
        else if (args[i] === '--port') port = Number(args[++i]);
        else throw new Error(`Unknown option: ${args[i]}`);
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
      const server = await serve({ port, monitor });
      console.log(`TokenMaxer: http://127.0.0.1:${server.address().port}`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
      break;
    }
    case 'capture': console.log(`Saved account ${await controller.capture(args.join(' '))} in macOS Keychain.`); break;
    case 'login': await login(args.join(' ')); break;
    case 'status': {
      const state = await controller.status();
      if (!state.accounts.length) console.log('No saved accounts. Run ct capture <name> or ct login <name>.');
      for (const account of state.accounts) console.log(`${state.active === account.key ? '*' : ' '} ${account.label} | ${account.email || ''} | ${account.key} | ${account.utilization === null ? 'usage unknown' : `${account.utilization}% used`}${account.error ? ` | ${account.error}` : ''}`);
      if (state.overrides.length) console.log(`Credential overrides: ${state.overrides.join(', ')}`);
      break;
    }
    case 'poll': await controller.poll(); console.log('Usage checked. Run ct status for results.'); break;
    case 'switch': await controller.switchAccount(await resolveAccount(args.join(' '))); console.log('Account switched. Resume an existing session with claude --continue if needed.'); break;
    case 'remove': await controller.removeAccount(await resolveAccount(args.join(' '))); console.log('Saved account removed.'); break;
    case 'run':
      await controller.poll();
      process.exitCode = await childExit('claude', args[0] === '--' ? args.slice(1) : args);
      break;
    case 'install-daemon': await daemon(true); break;
    case 'uninstall-daemon': await daemon(false); break;
    default: throw new Error(`Unknown command: ${command}. Run ct help.`);
  }
}

main().catch((err) => { console.error(`TokenMaxer: ${err.message}`); process.exitCode = 1; });
