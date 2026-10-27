// Giriş, sessiyalar, IP yoxlaması
import type http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';

// ---------- müştəri IP-si ----------
const normIp = (ip: string) => ip.trim().replace(/^::ffff:/, '').toLowerCase();

/** Proxy arxasında (Railway/Cloudflare) yalnız proxy-nin yazdığı başlığa inanırıq */
export function clientIp(req: http.IncomingMessage): string {
  if (config.trustProxy) {
    const h = req.headers[config.clientIpHeader];
    const v = (Array.isArray(h) ? h[0] : h)?.split(',')[0];
    if (v) return normIp(v).slice(0, 64);
  }
  return normIp(req.socket?.remoteAddress || '');
}

export const adminIpAllowed = (ip: string) => config.adminAllowedIps.map(normIp).includes(normIp(ip));

/** POST və canlı axın yalnız öz saytımızdan (CSRF qoruması) */
export function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // brauzer olmayan klient (curl, webhook) — cookie göndərmir
  if (config.allowedOrigins.includes(origin)) return true;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}

// ---------- parollar (scrypt) ----------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), 32, { N: 16384 });
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'base64url'));
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- sessiyalar: imzalanmış HttpOnly cookie ----------
export const ADMIN_COOKIE = 'sk_admin';
export const COMPANY_COOKIE = 'sk_company';

export interface Session {
  role: 'admin' | 'company';
  cid?: number;
  /** şifrə dəyişəndə köhnə sessiyalar etibarsız olsun deyə şifrə heşinin barmaq izi */
  pv?: string;
  ip?: string;
  /** Hesabatım hesabı ilə giriş: icazəli şirkətlər, email və Hesabatım-dakı rol */
  via?: 'local' | 'hesabatim';
  cids?: number[];
  email?: string;
  hrole?: string;
  hroles?: string[];
  exp: number;
}

const sign = (data: string) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
export const passwordFingerprint = (hash: string) => crypto.createHash('sha256').update(hash).digest('base64url').slice(0, 12);

export function createSession(s: Omit<Session, 'exp'>, minutes: number): string {
  const data = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + minutes * 60_000 })).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function readSession(req: http.IncomingMessage, cookie: string): Session | null {
  const raw = parseCookies(req)[cookie];
  if (!raw) return null;
  const [data, sig] = raw.split('.');
  if (!data || !sig || !safeEqual(sig, sign(data))) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString()) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(name: string, value: string, maxAgeSec: number, path: string): string {
  const secure = config.production || config.trustProxy ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

// ---------- brute-force qoruması (yaddaşda, tək proses) ----------
const attempts = new Map<string, { n: number; reset: number }>();

/** true → limit aşılıb */
export function rateLimited(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  a.n++;
  return a.n > max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}, 60_000).unref();
