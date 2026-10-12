import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as controller from './controller.js';

const publicDir = new URL('../public/', import.meta.url);

export async function serve({ port = 4317, monitor = true, interval = 60000 } = {}) {
  const nonce = randomBytes(32).toString('hex');
  let polling = false;
  let monitorError = null;
  async function refresh() {
    if (polling) throw new Error('A usage check is already running.');
    polling = true;
    try { await controller.poll(); monitorError = null; }
    catch (err) { monitorError = err.message; throw err; }
    finally { polling = false; }
  }
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host;
    const expectedPort = server.address().port;
    if (host !== `127.0.0.1:${expectedPort}` && host !== `localhost:${expectedPort}`) {
      res.writeHead(403).end('Invalid host.');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url, `http://${host}`);
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(200, { ...await controller.status(), nonce, polling, monitorError, monitor });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-ct-token'] !== nonce || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['content-type'] !== 'application/json') {
          return json(403, { error: 'Request rejected. Reload the dashboard and try again.' });
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(413, { error: 'Request too large.' });
        }
        const data = JSON.parse(body || '{}');
        switch (url.pathname) {
          case '/api/capture': await controller.capture(data.label); break;
          case '/api/switch': await controller.switchAccount(data.key); break;
          case '/api/remove': await controller.removeAccount(data.key); break;
          case '/api/settings': await controller.updateSettings(data); break;
          case '/api/poll': await refresh(); break;
          default: return json(404, { error: 'Not found.' });
        }
        return json(200, { ok: true });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method !== 'GET' || !assets[url.pathname]) return json(404, { error: 'Not found.' });
      const [name, type] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(await fs.readFile(new URL(name, publicDir)));
    } catch (err) { json(400, { error: err instanceof SyntaxError ? 'Invalid JSON.' : err.message }); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let timer;
  if (monitor) {
    const tick = () => { if (!polling) refresh().catch((err) => console.error(`Monitor: ${err.message}`)); };
    tick();
    timer = setInterval(tick, interval);
  }
  server.on('close', () => clearInterval(timer));
  return server;
}
