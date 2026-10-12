let state;
let pending = false;
const $ = (id) => document.getElementById(id);
const dates = (value) => value ? new Date(value).toLocaleString() : 'Not checked yet';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showMessage(message, failure = false) {
  $('message').textContent = message;
  $('message').className = failure ? 'failure' : '';
  $('message').hidden = false;
}

async function load() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Unable to load the dashboard.');
  state = await response.json();
  $('count').textContent = state.accounts.length;
  if (document.activeElement !== $('threshold') && document.activeElement !== $('auto')) {
    $('threshold').value = state.settings.threshold;
    $('auto').checked = state.settings.autoSwitch;
  }
  $('monitor-status').textContent = `${state.monitor ? 'Monitor running · checks every minute' : 'Monitor paused · manual checks only'} · Last check: ${dates(state.lastPollAt)}`;
  $('refresh').disabled = pending || state.polling;
  $('capture').querySelector('button').disabled = pending;
  $('settings').querySelector('button').disabled = pending;
  const warnings = [];
  if (state.overrides.length) warnings.push(`Switching is blocked by these credential overrides: ${state.overrides.join(', ')}. Unset them and restart TokenMaxer.`);
  if (state.monitorError) warnings.push(state.monitorError);
  if (state.credentialError) warnings.push(state.credentialError);
  if (state.accounts.length && !state.accounts.some((account) => account.key === state.active)) warnings.push('Your current Claude login is not saved. Save it below to enable automatic switching.');
  const current = state.accounts.find((account) => account.key === state.active);
  if (state.settings.autoSwitch && current && current.utilization >= state.settings.threshold && !state.accounts.some((account) => account.key !== state.active && !account.error && account.utilization !== null && account.utilization < state.settings.threshold)) warnings.push('No saved account has verified capacity below the threshold. Add another account or wait for usage to reset.');
  $('warning').textContent = warnings.join(' ');
  $('warning').hidden = !warnings.length;
  $('accounts').replaceChildren();
  if (!state.accounts.length) $('accounts').append(element('div', 'No saved accounts yet. Save your current login below to get started.', 'empty'));
  for (const account of state.accounts) {
    const active = account.key === state.active;
    const card = element('article', undefined, `card${active ? ' active' : ''}`);
    card.dataset.key = account.key;
    const heading = element('div', undefined, 'card-heading');
    heading.append(element('h3', account.label));
    if (active) heading.append(element('span', 'ACTIVE', 'badge'));
    card.append(heading, element('p', `${account.email || 'Email unavailable'}${account.subscription ? ` · ${account.subscription}` : ''}`, 'email'));
    for (const usage of account.usage) {
      const names = { five_hour: 'Current session (5 hours)', seven_day: 'Current week', seven_day_sonnet: 'Weekly Sonnet', seven_day_opus: 'Weekly Opus' };
      const row = element('div', undefined, 'window');
      const label = element('div', undefined, 'window-label');
      label.append(element('span', names[usage.name] || usage.name), element('span', `${Math.round(usage.utilization)}%`));
      const progress = element('progress');
      progress.max = 100;
      progress.value = usage.utilization;
      progress.setAttribute('aria-label', `${account.label}: ${names[usage.name] || usage.name}`);
      row.append(label, progress);
      if (usage.resets_at) row.append(element('p', `Resets ${dates(usage.resets_at)}`, 'reset'));
      card.append(row);
    }
    if (!account.usage.length) card.append(element('p', 'Usage not checked yet.', 'muted'));
    if (account.error) card.append(element('p', account.error, 'error'));
    card.append(element('p', `Checked: ${dates(account.checkedAt)}`, 'reset'));
    const actions = element('div', undefined, 'actions');
    const activate = element('button', active ? 'In use' : 'Use account');
    activate.disabled = active || pending || Boolean(state.overrides.length);
    activate.addEventListener('click', () => mutate('/api/switch', { key: account.key }, `Switched to ${account.label}. Resume Claude with claude --continue if needed.`));
    const remove = element('button', 'Remove', 'secondary');
    remove.disabled = active || pending;
    remove.addEventListener('click', () => mutate('/api/remove', { key: account.key }, `Removed ${account.label}.`));
    actions.append(activate, remove);
    card.append(actions);
    $('accounts').append(card);
  }
  $('events').replaceChildren();
  if (!state.events.length) $('events').append(element('li', 'No activity yet.', 'muted'));
  for (const event of state.events) {
    const row = element('li');
    const time = element('time', dates(event.at));
    time.dateTime = new Date(event.at).toISOString();
    row.append(time, element('span', event.message));
    $('events').append(row);
  }
}

async function mutate(path, data, message) {
  if (pending || !state) return;
  pending = true;
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CT-Token': state.nonce }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    showMessage(message);
    if (path === '/api/capture') $('label').value = '';
  } catch (err) { showMessage(err.message, true); }
  finally {
    pending = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    await load().catch((err) => showMessage(err.message, true));
  }
}

$('capture').addEventListener('submit', (event) => { event.preventDefault(); mutate('/api/capture', { label: $('label').value }, 'Current login saved securely in macOS Keychain.'); });
$('settings').addEventListener('submit', (event) => { event.preventDefault(); mutate('/api/settings', { autoSwitch: $('auto').checked, threshold: Number($('threshold').value) }, 'Settings saved.'); });
$('refresh').addEventListener('click', () => mutate('/api/poll', {}, 'Usage checked.'));
load().catch((err) => showMessage(err.message, true));
setInterval(() => { if (!pending) load().catch((err) => showMessage(err.message, true)); }, 5000);
