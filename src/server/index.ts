// HTTP serveri: API, React tətbiqi, /api/live real vaxt kanalı (SSE) (Node 22+, Railway-də tək uzunömürlü proses)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { adminEnabled, config } from './config.js';
import { ADMIN_COOKIE, adminIpAllowed, clientIp, originOk, readSession } from './auth.js';
import { companySession, handleApi } from './app.js';
import { getDb } from './db.js';
import { flushLogs, log, startLogPipeline } from './logger.js';
import { closeAll, handleLive, watchedCardTokens, type Authorize } from './realtime.js';
import * as svc from './service.js';

const CLIENT_DIR = path.resolve('dist', 'client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  ...(config.trustProxy ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

// React build-i paylayır; tanınmayan yollar (/, /c/:token, /k/:slug, /panel, /admin) index.html-ə düşür
function serveClient(res: http.ServerResponse, pathname: string) {
  const file = path.normalize(path.join(CLIENT_DIR, pathname));
  if (file !== CLIENT_DIR && !file.startsWith(CLIENT_DIR + path.sep)) { res.writeHead(400); return res.end(); }
  fs.stat(file, (err, st) => {
    const found = !err && st.isFile();
    if (!found && pathname.startsWith('/assets/')) { res.writeHead(404); return res.end(); }
    const target = found ? file : path.join(CLIENT_DIR, 'index.html');
    fs.readFile(target, (err2, buf) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Tətbiq hələ yığılmayıb — "npm run build" işlədin və ya inkişaf üçün "npm run dev"');
      }
      const immutable = target.includes(`${path.sep}assets${path.sep}`);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(buf);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Yalnız HTTPS: Railway edge TLS-i bağlayıb X-Forwarded-Proto yazır; http ilə gələn hər sorğu https-ə yönləndirilir
  if (config.trustProxy && req.headers['x-forwarded-proto'] === 'http' && url.pathname !== '/health') {
    res.writeHead(308, { Location: `https://${req.headers.host}${req.url ?? '/'}` });
    return res.end();
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  // Canlı axın adi API logundan kənardadır: saatlarla açıq qalır, hər qoşulmanı loglamaq mənasızdır
  if (url.pathname === '/api/live' && req.method === 'GET') {
    return void handleLive(req, res, url, { ip: clientIp(req), originOk, authorize: authorizeLive });
  }
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  // Admin panelin səhifəsi belə yalnız icazəli IP-yə görünür
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const ip = clientIp(req);
    if (!adminEnabled || !adminIpAllowed(ip)) {
      log({ level: 'warn', category: 'security', action: 'admin.ip_denied', ip, message: `GET ${pathname}` });
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Tapılmadı');
    }
  }
  if (pathname === '/staff') { res.writeHead(301, { Location: '/panel' }); return res.end(); }
  serveClient(res, pathname);
});

// Müştəri yalnız tokenini bildiyi kartı, şirkət öz kanalını, admin (IP + sessiya) hər şeyi dinləyir.
// Kart kanalı qoşulan an kartın (rəng və loqo daxil) təzə halını alır — qopuşda buraxılan dəyişiklik itmir.
const authorizeLive: Authorize = async (req, sub) => {
  if (sub.channel === 'card') {
    const { card, company } = await svc.loadCard(sub.token, { refresh: false });
    return { channel: `card:${card.token}`, snapshot: { type: 'card', card: svc.publicCard(card, company) } };
  }
  if (sub.channel === 'company') {
    const r = await companySession(req);
    return r ? { channel: `company:${r.company.id}` } : null;
  }
  const ip = clientIp(req);
  const s = readSession(req, ADMIN_COOKIE);
  return adminEnabled && adminIpAllowed(ip) && s?.role === 'admin' && s.ip === ip ? { channel: 'admin' } : null;
};

async function main() {
  await getDb();
  startLogPipeline();
  await svc.bootstrap();
  if (config.hesabatimApiUrl && config.syncIntervalSec > 0) {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try { await svc.syncTick(watchedCardTokens()); } catch (e) {
        log({ level: 'error', category: 'integration', action: 'sync.failed', message: String(e) });
      } finally { running = false; }
    }, config.syncIntervalSec * 1000).unref();
  }
  server.listen(config.port, () => {
    log({ category: 'system', action: 'server.started', message: `Port ${config.port}, admin ${adminEnabled ? 'açıq' : 'bağlı'}, Hesabatım ${config.hesabatimApiUrl ? 'qoşulub' : 'yox'}` });
    if (!adminEnabled) console.warn('Admin panel bağlıdır: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_ALLOWED_IPS verin');
  });
}

// Railway yeni versiyanı yayanda SIGTERM göndərir: logları bazaya yazıb çıxırıq
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    log({ category: 'system', action: 'server.stopping', message: sig });
    server.close();
    closeAll();
    await flushLogs().catch(() => {});
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Server başlamadı:', e);
  process.exit(1);
});
