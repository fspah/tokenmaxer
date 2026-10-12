# Claude Control Tower

A local macOS dashboard and CLI for saving Claude Code subscription accounts, checking their usage and automatically activating an account with available capacity. Credentials stay in macOS Keychain. You log in once for each new account, then reuse its saved login while it remains valid.

## Start

Requires macOS, Node.js 20 or later, and Claude Code on your `PATH`. Tested against Claude Code **2.1.296**.

```sh
git clone git@github.com:fspah/claude-control-tower.git
cd claude-control-tower
npm ci
npm start
```

The repository is private, so cloning requires a GitHub account with access. On this Mac, the existing checkout is `~/coding_projects/claude-control-tower`.

Open <http://127.0.0.1:4317>. Give your current account a name and click **Save current login**, then **Check usage**.

The `ct` command can be installed as a local symlink:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/bin/ct.js" ~/.local/bin/ct
```

If `~/.local/bin` is not on your `PATH`, use `node bin/ct.js` in place of `ct`.

## Add and use accounts

```sh
ct capture "Personal"
ct login "Work"
ct switch "Work"
ct status
ct run -- --continue
```

`capture` saves your current subscription login. `login` runs the official `claude auth login --claudeai` flow in a temporary config directory, stores that account in the vault and removes the temporary login. It leaves your active Claude account in place. Each new account requires one browser authorization. Expired or revoked refresh grants require a new login too.

Switch manually from the dashboard or with `ct switch`. Saved accounts persist across app and computer restarts. Account names can contain spaces and Unicode. If two accounts share a name, use the key shown by `ct status`.

Remove an inactive saved account with `ct remove "Work"` or the dashboard's **Remove** button. Switch away from an active account before removing it. `ct help` lists all commands.

## Automatic switching

The dashboard server polls all saved accounts every minute. By default, it switches when any usage window reaches **95%**, selecting the saved account with the lowest maximum usage below that threshold. Change the threshold or disable switching in the dashboard.

Five-hour, weekly, model-specific weekly and model-scoped limits all count. Failed usage requests, missing tokens and accounts requiring a new login are excluded. If every account is exhausted, the current account stays active. The monitor checks again as usage windows reset. An unsaved current login is never switched automatically.

`ct poll` performs one check and applies the same switching rules. `ct run` checks first, then launches Claude with your arguments. It does not start a background monitor; keep the dashboard server or login daemon running for checks during a session.

Switching changes Claude Code's stored credentials and identity for the selected config directory. Existing Claude processes may cache credentials. If an open session still reports the old account or limit, exit it and use `claude --continue` in the same project, or `claude --resume` to choose a conversation. Control Tower does not interrupt an active turn or replay prompts.

## Run at login

Stop a manually running dashboard before installing its daemon:

```sh
ct install-daemon
ct uninstall-daemon
```

The daemon runs the dashboard and monitor through a macOS LaunchAgent. Its plist lives at `~/Library/LaunchAgents/local.claude-control-tower.plist`; its log lives at `~/.claude-control-tower/daemon.log`. The project and Node executable must stay at their installed paths. Removing the daemon keeps saved accounts.

For a manual server on another port, use `ct serve --port 4318`. To open the dashboard without background polling, use `ct serve --no-monitor`; **Check usage** still performs a check and can switch accounts when automatic switching is enabled.

## Updates and troubleshooting

To update an installation using the login daemon:

```sh
git pull --ff-only
npm ci
ct install-daemon
```

Run those commands from the checkout. `install-daemon` restarts an existing login daemon and records the current Node executable path. For a manually started server, restart it after updating.

- **Port 4317 already in use:** the login daemon or another dashboard server may already be running. Open the existing dashboard, stop the manual server, or choose another port.
- **Keychain locked:** unlock your login Keychain in macOS Keychain Access, then retry the operation.
- **No account with capacity:** inspect the usage and error messages in the dashboard, add another account, or wait for a usage reset. The monitor never selects an account using an unsuccessful usage check.
- **Account needs a new login:** use `ct login "Work"` to renew that account's saved credentials.
- **Old account still shown inside Claude:** exit that Claude session and run `claude --continue` in the same project.

## Storage and compatibility

- Saved tokens use one macOS Keychain item per account under the service **Claude Control Tower**.
- Non-secret account metadata, token fingerprints, settings and usage live in `~/.claude-control-tower/state.json` with mode `0600`; the directory uses mode `0700`.
- Switching preserves other live credential fields, including MCP OAuth tokens. It updates `oauthAccount`, clears account-specific caches and keeps unrelated Claude configuration. A mode `0600` config backup is written to `claude-config.backup.json`.
- Vault operations serialize across the CLI and monitor. Credential writes coordinate with Claude Code's refresh locks. Token rotations are saved before further API requests, and interrupted live writes can be recovered on the next check.
- The dashboard binds only to `127.0.0.1`. Mutations require a session nonce and reject foreign origins and unrecognized hosts. Tokens are excluded from its API, UI, activity log and process arguments.
- Keychain writes use stdin, including an escaped text form for larger items. If the entire credentials item exceeds the macOS interactive-command limit, the write fails without exposing it in arguments. This can affect Claude installations with unusually large MCP credential collections.
- `CLAUDE_CONFIG_DIR` selects which Claude login is managed; `CT_HOME` changes the vault directory and isolates its Keychain service. Use the same environment for the CLI and server.
- Credential environment overrides are reported by name, without their values. Unset them before switching. This project manages subscription OAuth logins; API keys, cloud-provider authentication, `apiKeyHelper`, Anthropic profiles and administrator-enforced authentication need their own configuration. A daemon cannot see credential overrides set only inside an unrelated shell.
- Usage/profile and refresh calls follow the endpoints used by the installed Claude Code version. They are not a stable public integration API and may change. The credential layout and cache list are also version-sensitive. Recheck compatibility after a major Claude Code update.

Claude's documented authentication options, credential storage and precedence: <https://code.claude.com/docs/en/authentication>.

## Tests

```sh
npm install
npx playwright install chromium
npm test
```

Playwright exercises the real dashboard and CLI against isolated fake accounts, a fake Anthropic server and a fake Keychain. It checks automatic/manual switching, usage resets, settings, concurrent writes, token refresh, expired grants, preservation of other credentials, rollback, input handling, browser rendering and local request protection. A separate test checks the real macOS Keychain using a temporary item containing only dummy values, then deletes it. No real Claude account is switched by the suite.

The suite contains **22 tests**, all passing during the initial validation. The live dashboard, current-account capture, real profile/usage response shapes and installed LaunchAgent were also checked locally. Multi-account switching and refresh failure scenarios use fake accounts; validation does not claim live switching between multiple real accounts.
