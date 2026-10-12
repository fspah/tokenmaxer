// Thin wrapper over macOS `security` for generic-password items.
// Secrets are passed on stdin (`security -i`), using hex or escaped text,
// without exposing secrets in process arguments.
import { spawn } from 'node:child_process';

const STDIN_LINE_LIMIT = 4032; // same limit Claude Code 2.1.296 uses
const ITEM_NOT_FOUND = 44;
const KEYCHAIN_LOCKED = 36;

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.on('error', (err) => { if (err.code !== 'EPIPE') reject(err); });
    child.stdin.end(input ?? '');
  });
}

function assertSafeName(name) {
  if (!/^[A-Za-z0-9 ._:@+-]+$/.test(name)) throw new Error(`Unsafe keychain name: ${name}`);
}

export async function read(service, account) {
  const { code, stdout, stderr } = await run(['find-generic-password', '-a', account, '-s', service, '-w']);
  if (code === ITEM_NOT_FOUND) return null;
  if (code === KEYCHAIN_LOCKED) throw new Error('The login keychain is locked.');
  if (code !== 0) throw new Error(`security find-generic-password failed (${code}): ${stderr.trim()}`);
  return stdout.replace(/\n$/, '');
}

export async function write(service, account, secret) {
  assertSafeName(service);
  assertSafeName(account);
  const hex = Buffer.from(secret, 'utf8').toString('hex');
  let line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  if (line.length > STDIN_LINE_LIMIT && !/[\r\n]/.test(secret)) {
    const escaped = secret.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    line = `add-generic-password -U -a "${account}" -s "${service}" -w "${escaped}"\n`;
  }
  if (Buffer.byteLength(line) > STDIN_LINE_LIMIT) throw new Error('Credentials are too large for a secure Keychain write. Existing credentials were kept.');
  const res = await run(['-i'], line);
  if (res.code === KEYCHAIN_LOCKED) throw new Error('The login keychain is locked.');
  // `security -i` can exit 0 even when the command inside failed, so verify by reading back.
  if ((await read(service, account)) !== secret) {
    throw new Error(`Keychain write to "${service}" did not stick (${res.code}).`);
  }
}

// JSON payloads are stored ASCII-only (\u-escaped) because `security -w` prints anything
// non-ASCII as hex. Reads also accept that hex form, for items written by other tools.
export async function readJson(service, account) {
  const raw = await read(service, account);
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (/^(?:[0-9a-f]{2})+$/i.test(raw)) return JSON.parse(Buffer.from(raw, 'hex').toString('utf8'));
    throw err;
  }
}

export function writeJson(service, account, value) {
  const ascii = JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return write(service, account, ascii);
}

export async function remove(service, account) {
  const { code, stderr } = await run(['delete-generic-password', '-a', account, '-s', service]);
  if (code === 0) return true;
  if (code === ITEM_NOT_FOUND) return false;
  throw new Error(`security delete-generic-password failed (${code}): ${stderr.trim()}`);
}
