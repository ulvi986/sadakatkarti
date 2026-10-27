// SSE (Server-Sent Events): kart dəyişəndə müştərinin telefonu, şirkət paneli və admin panel dərhal yenilənir.
// Kanallar: card:<token> (müştəri), company:<id> (şirkət paneli), admin (ümumi panel).
// Adi HTTP cavabıdır (GET /api/live, text/event-stream): proxy-lər onu WebSocket upgrade-i kimi kəsmir,
// brauzer qopanda özü yenidən qoşulur və hər qoşulmada server kartın təzə halını dərhal göndərir.
import type http from 'node:http';
import type { LiveMessage, LiveSub } from '../shared/types.js';

/** Abunəliyə icazə: kanal adını və qoşulan an göndəriləcək ilk vəziyyəti qaytarır, ya da null (rədd) */
export type Authorize = (req: http.IncomingMessage, sub: LiveSub) =>
  Promise<{ channel: string; snapshot?: LiveMessage } | null>;

const HEARTBEAT_MS = 15_000; // Railway/mobil proxy boş bağlantını bağlamasın
const MAX_PER_IP = 20;

const channels = new Map<string, Set<http.ServerResponse>>();
const perIp = new Map<string, number>();
let total = 0;

const frame = (msg: LiveMessage) => `data: ${JSON.stringify(msg)}\n\n`;

export function publish(channel: string, msg: LiveMessage) {
  const subs = channels.get(channel);
  if (!subs?.size) return;
  const data = frame(msg);
  for (const res of subs) res.write(data);
}

/** Hazırda ekranda açıq olan kartlar (fon sinxronizasiyası əvvəlcə bunları yeniləyir) */
export function watchedCardTokens(): string[] {
  return [...channels.keys()].filter((c) => c.startsWith('card:')).map((c) => c.slice(5));
}

export function connectionCount() {
  return total;
}

function parseSub(url: URL): LiveSub | null {
  const channel = url.searchParams.get('channel');
  if (channel === 'card') {
    const token = url.searchParams.get('token');
    return token && token.length <= 100 ? { channel, token } : null;
  }
  return channel === 'company' || channel === 'admin' ? { channel } : null;
}

export async function handleLive(req: http.IncomingMessage, res: http.ServerResponse, url: URL, opts: {
  ip: string;
  originOk: (req: http.IncomingMessage) => boolean;
  authorize: Authorize;
}) {
  const sub = parseSub(url);
  const granted = sub && opts.originOk(req) && (perIp.get(opts.ip) ?? 0) < MAX_PER_IP
    ? await opts.authorize(req, sub).catch(() => null) : null;
  if (!granted) {
    // 2xx olmayan cavabda EventSource özü təkrar cəhd etmir — klient fasilə ilə özü qərar verir
    res.writeHead(sub ? 403 : 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end();
  }

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // aradakı nginx/proxy cavabı yığıb saxlamasın
  });
  // retry: qopanda brauzer 1 saniyədən sonra yenidən qoşulsun (standart 3 s)
  res.write(`retry: 1000\n${frame({ type: 'subscribed', channel: granted.channel })}`);
  if (granted.snapshot) res.write(frame(granted.snapshot));

  if (!channels.has(granted.channel)) channels.set(granted.channel, new Set());
  channels.get(granted.channel)!.add(res);
  perIp.set(opts.ip, (perIp.get(opts.ip) ?? 0) + 1);
  total++;

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    const set = channels.get(granted.channel);
    set?.delete(res);
    if (set && !set.size) channels.delete(granted.channel);
    const n = (perIp.get(opts.ip) ?? 1) - 1;
    if (n > 0) perIp.set(opts.ip, n); else perIp.delete(opts.ip);
    total--;
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

/** Server dayananda açıq axınları bağla ki, brauzerlər dərhal yeni versiyaya qoşulsun */
export function closeAll() {
  for (const set of channels.values()) for (const res of set) res.end();
}
