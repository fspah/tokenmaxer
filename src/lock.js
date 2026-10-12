// Directory locks compatible with `proper-lockfile`, which Claude Code uses: a lock is a directory
// created with mkdir, and it counts as stale once its mtime is older than `stale` ms.
import fs from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(path, stale, deadline) {
  for (;;) {
    try {
      await fs.mkdir(path);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const st = await fs.stat(path).catch(() => null);
    if (st && Date.now() - st.mtimeMs > stale) {
      await fs.rm(path, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      const err = new Error(`Lock busy: ${path}`);
      err.code = 'ELOCKED';
      throw err;
    }
    await sleep(100 + Math.random() * 150);
  }
}

// Takes every lock in order (all or nothing), runs fn, releases in reverse order.
// Held locks get their mtime bumped every 5s, as proper-lockfile does, so they never look stale.
export async function withLocks(paths, { stale, timeoutMs = 15000 }, fn) {
  const deadline = Date.now() + timeoutMs;
  const held = [];
  const touch = setInterval(() => {
    const now = new Date();
    for (const p of held) fs.utimes(p, now, now).catch(() => {});
  }, 5000);
  try {
    for (const p of paths) {
      await acquire(p, stale, deadline);
      held.push(p);
    }
    return await fn();
  } finally {
    clearInterval(touch);
    for (const p of held.reverse()) await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  }
}
