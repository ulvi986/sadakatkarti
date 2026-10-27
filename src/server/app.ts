// /api/* marşrutları: müştəri, şirkət paneli (/api/panel), ümumi admin (/api/admin), Hesabatım webhook
import type { IncomingMessage, ServerResponse } from 'node:http';
import { adminEnabled, config } from './config.js';
import {
  ADMIN_COOKIE, COMPANY_COOKIE, adminIpAllowed, clientIp, createSession, originOk, rateLimited, readSession,
  safeEqual, sessionCookie, verifyPassword,
} from './auth.js';
import { getDb } from './db.js';
import { hesabatim, HesabatimError, verifyWebhook, type HesabatimWebhook } from './hesabatim.js';
import type { Session } from './auth.js';
import { log, toLogEntry } from './logger.js';
import { connectionCount } from './realtime.js';
import * as svc from './service.js';
import { HttpError, type Company } from './service.js';
import type {
  AdminOverview, ApiErrorBody, CompanyInput, LoginBody, MeCompany, SignupBody, StampBody, SystemInfo,
} from '../shared/types.js';

type Req = IncomingMessage & { body?: unknown };
interface Ctx { req: Req; res: ServerResponse; url: URL; parts: string[]; ip: string; companyId?: number }

export function send<T>(res: ServerResponse, status: number, data: T | ApiErrorBody, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(JSON.stringify(data));
}

function readRaw(req: Req, limit = 1e5): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c;
      if (raw.length > limit) { reject(new HttpError(413, 'Sorğu çox böyükdür')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function body<T>(req: Req): Promise<Partial<T>> {
  try { return JSON.parse((await readRaw(req)) || '{}'); } catch { throw new HttpError(400, 'JSON yanlışdır'); }
}

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);

// =============================================================== giriş yoxlamaları
/** Şirkət sessiyası: ya panelin öz girişi (şifrə dəyişəndə etibarsızlaşır), ya Hesabatım hesabı (icazəli şirkətlər siyahısı) */
export async function companySession(req: IncomingMessage): Promise<{ company: Company; session: Session } | null> {
  const s = readSession(req, COMPANY_COOKIE);
  if (!s || s.role !== 'company' || !s.cid) return null;
  const c = await svc.companyById(s.cid);
  if (!c || !c.active) return null;
  if (s.via === 'hesabatim') return s.cids?.includes(c.id) && c.hesabatim_slug ? { company: c, session: s } : null;
  return s.pv === svc.companyFingerprint(c) ? { company: c, session: s } : null;
}

async function requireCompany(ctx: Ctx): Promise<{ company: Company; session: Session }> {
  const r = await companySession(ctx.req);
  if (!r) throw new HttpError(401, 'Sessiya bitib, yenidən daxil olun');
  ctx.companyId = r.company.id;
  return r;
}

const HESABATIM_SESSION_HOURS = 8;
const companyCookie = (token: string, hours: number) => sessionCookie(COMPANY_COOKIE, token, hours * 3600, '/');

/** Admin: əvvəlcə IP, sonra sessiya. İcazəsiz IP üçün panelin varlığı belə görünmür (404) */
function requireAdminIp(ctx: Ctx) {
  if (!adminEnabled || !adminIpAllowed(ctx.ip)) {
    log({ level: 'warn', category: 'security', action: 'admin.ip_denied', ip: ctx.ip,
      message: `${ctx.req.method} ${ctx.url.pathname}` });
    throw new HttpError(404, 'Tapılmadı');
  }
}

function requireAdmin(ctx: Ctx) {
  requireAdminIp(ctx);
  const s = readSession(ctx.req, ADMIN_COOKIE);
  if (!s || s.role !== 'admin' || s.ip !== ctx.ip) throw new HttpError(401, 'Daxil olun');
}

function loginGuard(ctx: Ctx, scope: string) {
  if (rateLimited(`login:${scope}:${ctx.ip}`, 8)) {
    log({ level: 'warn', category: 'security', action: `${scope}.login_rate_limited`, ip: ctx.ip });
    throw new HttpError(429, 'Çox cəhd — 1 dəqiqə gözləyin');
  }
}

// =============================================================== müştəri
async function routePublic(ctx: Ctx) {
  const { req, res, parts, ip } = ctx;
  const m = req.method;

  if (m === 'GET' && parts[1] === 'config') {
    const c = await svc.defaultCompany();
    if (!c) return send(res, 404, { error: 'Şirkət seçilməyib' });
    return send(res, 200, svc.publicCompany(await svc.syncCompany(c)));
  }
  if (parts[1] === 'companies' && parts[2]) {
    const company = await svc.activeCompany(parts[2]);
    ctx.companyId = company.id;
    if (m === 'GET' && !parts[3]) return send(res, 200, svc.publicCompany(company));
    if (m === 'GET' && parts[3] === 'logo' && !parts[4]) {
      const logo = svc.companyLogo(company);
      if (!logo) throw new HttpError(404, 'Loqo yoxdur');
      // ?v=<heş> ilə çağırılır: loqo dəyişəndə ünvan da dəyişir, ona görə uzun müddət keşlənə bilər
      res.writeHead(200, {
        'Content-Type': logo.mime, 'Content-Length': logo.body.length, 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': ctx.url.searchParams.get('v') === company.logo_hash ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      return void res.end(logo.body);
    }
    if (m === 'POST' && parts[3] === 'cards' && !parts[4]) return signup(ctx, company);
    if (m === 'POST' && parts[3] === 'cards' && parts[4] === 'find' && !parts[5]) {
      if (rateLimited(`signup:${ip}`, 10)) {
        log({ level: 'warn', category: 'security', action: 'card_login.rate_limited', companyId: company.id, ip });
        throw new HttpError(429, 'Çox cəhd — bir az sonra yenidən yoxlayın');
      }
      const b = await body<{ phone: string }>(req);
      return send(res, 200, await svc.findCard(company, b.phone, ip));
    }
  }
  if (m === 'POST' && parts[1] === 'cards' && !parts[2]) {
    const c = await svc.defaultCompany();
    if (!c || !c.active) throw new HttpError(404, 'Şirkət tapılmadı');
    ctx.companyId = c.id;
    return signup(ctx, await svc.syncCompany(c));
  }
  if (m === 'GET' && parts[1] === 'cards' && parts[2] && !parts[3]) {
    const { card, company } = await svc.loadCard(parts[2], { ip });
    ctx.companyId = company.id;
    return send(res, 200, svc.publicCard(card, company));
  }
  if (m === 'POST' && parts[1] === 'integrations' && parts[2] === 'hesabatim' && parts[3] === 'webhook') {
    const raw = await readRaw(req, 6e5); // business.* hadisələrində loqo (data URI) gələ bilər
    const sig = req.headers['x-sadakat-signature'];
    const ts = req.headers['x-sadakat-timestamp'];
    const problem = verifyWebhook(raw, String(ts ?? '') || undefined, String(sig ?? '') || undefined);
    if (problem) {
      log({ level: 'warn', category: 'security', action: 'webhook.rejected', ip, message: problem });
      throw new HttpError(401, problem);
    }
    let w: HesabatimWebhook;
    try { w = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON yanlışdır'); }
    if (!w.business_slug || !w.event) throw new HttpError(400, 'event və business_slug lazımdır');
    return send(res, 200, await svc.handleWebhook(w, ip));
  }
  throw new HttpError(404, 'Tapılmadı');
}

async function signup(ctx: Ctx, company: Company) {
  if (rateLimited(`signup:${ctx.ip}`, 10)) {
    log({ level: 'warn', category: 'security', action: 'signup.rate_limited', companyId: company.id, ip: ctx.ip });
    throw new HttpError(429, 'Çox cəhd — bir az sonra yenidən yoxlayın');
  }
  const b = await body<SignupBody>(ctx.req);
  return send(ctx.res, 200, await svc.signup(company, b.name, b.phone, ctx.ip));
}

// =============================================================== şirkət paneli
async function routePanel(ctx: Ctx) {
  const { req, res, parts, url, ip } = ctx;
  const m = req.method;
  const path = parts.slice(2).join('/');

  if (m === 'POST' && path === 'login') {
    loginGuard(ctx, 'company');
    const b = await body<LoginBody>(req);
    const c = await svc.companyByUsername(String(b.username ?? ''));
    const ok = c && c.active && verifyPassword(String(b.password ?? ''), c.password_hash);
    if (!ok) {
      log({ level: 'warn', category: 'security', action: 'company.login_failed', companyId: c?.id ?? null, ip,
        actor: String(b.username ?? '').slice(0, 80) });
      throw new HttpError(401, 'İstifadəçi adı və ya şifrə yanlışdır');
    }
    const token = createSession({ role: 'company', cid: c.id, pv: svc.companyFingerprint(c) }, config.companySessionHours * 60);
    log({ category: 'security', action: 'company.login', companyId: c.id, actor: c.username, ip });
    return send(res, 200, { ok: true }, {
      'Set-Cookie': sessionCookie(COMPANY_COOKIE, token, config.companySessionHours * 3600, '/'),
    });
  }
  if (m === 'POST' && path === 'login-hesabatim') {
    // Hesabatım-dakı email/şifrə: Hesabatım yoxlayır, biz yalnız üzv olduğu biznesləri götürürük
    loginGuard(ctx, 'company');
    const b = await body<{ email: string; password: string }>(req);
    const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
    let user;
    try {
      ({ user } = await hesabatim.login(email, String(b.password ?? ''), ip));
    } catch (e) {
      if (e instanceof HesabatimError && e.status < 500) {
        log({ level: 'warn', category: 'security', action: 'company.hesabatim_login_failed', ip, actor: email, message: e.message });
        throw new HttpError(e.status === 429 ? 429 : 401, e.status === 429 ? e.message : 'Hesabatım email və ya şifrəsi yanlışdır');
      }
      throw e;
    }
    const companies: Company[] = [];
    const roles = new Map<number, string>();
    for (const mbr of user.memberships) {
      const hb = mbr.business;
      const c = await svc.ensureLinkedCompany(hb.slug, { name: hb.name, stamps_needed: hb.loyalty_stamps_needed,
        reward: hb.loyalty_reward, logo: hb.logo, theme: hb.theme }, 'lookup');
      if (c?.active) { companies.push(c); roles.set(c.id, mbr.role); }
    }
    if (!companies.length) {
      log({ level: 'warn', category: 'security', action: 'company.hesabatim_no_business', ip, actor: email });
      throw new HttpError(403, 'Bu Hesabatım hesabına bağlı aktiv biznes yoxdur');
    }
    const first = companies[0];
    const token = createSession({ role: 'company', via: 'hesabatim', cid: first.id, cids: companies.map((c) => c.id),
      email, hrole: roles.get(first.id), hroles: companies.map((c) => roles.get(c.id) ?? '') }, HESABATIM_SESSION_HOURS * 60);
    for (const c of companies) {
      log({ category: 'security', action: 'company.login', companyId: c.id, actor: `hesabatim:${email}`, ip, message: 'Hesabatım hesabı ilə' });
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': companyCookie(token, HESABATIM_SESSION_HOURS) });
  }
  if (m === 'POST' && path === 'logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(COMPANY_COOKIE, '', 0, '/') });
  }

  const auth = await requireCompany(ctx);
  const sess = auth.session;
  const viaHesabatim = sess.via === 'hesabatim';
  const actor = viaHesabatim ? `hesabatim:${sess.email}` : `company:${auth.company.username}`;
  const company = await svc.syncCompany(auth.company);

  if (m === 'GET' && path === 'me') {
    const all = viaHesabatim
      ? (await Promise.all((sess.cids ?? []).map((id) => svc.companyById(id)))).filter((c): c is Company => Boolean(c?.active))
      : [company];
    return send<MeCompany>(res, 200, {
      role: 'company', company: await svc.companyAdminView(company),
      login: { via: viaHesabatim ? 'hesabatim' : 'local', email: sess.email ?? null, role: sess.hrole ?? null },
      companies: all.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
    });
  }
  if (m === 'POST' && path === 'switch') {
    // Bir Hesabatım hesabı bir neçə biznesə üzvdürsə: yalnız girişdə təsdiqlənmiş şirkətlər arasında keçid
    const b = await body<{ companyId: number }>(req);
    const id = Number(b.companyId);
    if (!viaHesabatim || !sess.cids?.includes(id)) throw new HttpError(403, 'Bu şirkətə giriş icazəniz yoxdur');
    const { exp, ...rest } = sess;
    const hrole = rest.hroles?.[rest.cids!.indexOf(id)] || rest.hrole;
    const token = createSession({ ...rest, cid: id, hrole }, Math.max(1, Math.round((exp - Date.now()) / 60_000)));
    log({ category: 'security', action: 'company.switch', companyId: id, actor, ip });
    return send(res, 200, { ok: true }, { 'Set-Cookie': companyCookie(token, HESABATIM_SESSION_HOURS) });
  }
  if (m === 'GET' && path === 'stats') return send(res, 200, await svc.stats(company.id));
  if (m === 'GET' && path === 'cards') return send(res, 200, await svc.listCards(company.id, url.searchParams.get('q') ?? ''));
  if (parts[2] === 'cards' && parts[3]) {
    const token = svc.tokenFromText(decodeURIComponent(parts[3]));
    if (m === 'GET' && !parts[4]) {
      const { card, company: owner } = await svc.loadCard(token, { ip });
      if (owner.id !== company.id) throw new HttpError(404, 'Bu kart sizin şirkətə aid deyil');
      return send(res, 200, await svc.staffCard(card, owner));
    }
    if (m === 'POST' && parts[4] === 'stamp') {
      const b = await body<StampBody>(req);
      return send(res, 200, await svc.stamp(company, token, b.count, Boolean(b.force), actor, ip));
    }
    if (m === 'POST' && parts[4] === 'redeem') return send(res, 200, await svc.redeem(company, token, actor, ip));
  }
  if (m === 'GET' && path === 'logs') {
    const db = await getDb();
    const rows = await db.query(
      `SELECT * FROM logs WHERE company_id = $1 AND category <> 'request' AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT 100`, [company.id, num(url.searchParams.get('before'))]);
    return send(res, 200, rows.map(toLogEntry));
  }
  if (m === 'PATCH' && path === 'settings') {
    const b = await body<CompanyInput>(req);
    const input: CompanyInput = { name: b.name };
    if (!company.hesabatim_slug) Object.assign(input, { stampsNeeded: b.stampsNeeded, reward: b.reward });
    const next = await svc.updateCompany(company.id, input);
    log({ category: 'audit', action: 'company.settings', companyId: company.id, actor, ip,
      message: `${next.name}: ${next.stamps_needed} möhür, "${next.reward}"` });
    return send(res, 200, await svc.companyAdminView(next));
  }
  if (m === 'POST' && path === 'password') {
    if (viaHesabatim) throw new HttpError(400, 'Hesabatım hesabı ilə girmisiniz — şifrəni Hesabatım-da dəyişin');
    const b = await body<{ current: string; next: string }>(req);
    if (!verifyPassword(String(b.current ?? ''), company.password_hash)) throw new HttpError(400, 'Hazırkı şifrə yanlışdır');
    const next = await svc.updateCompany(company.id, { password: String(b.next ?? '') });
    log({ category: 'security', action: 'company.password_changed', companyId: company.id, actor, ip });
    const token = createSession({ role: 'company', cid: next.id, pv: svc.companyFingerprint(next) }, config.companySessionHours * 60);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(COMPANY_COOKIE, token, config.companySessionHours * 3600, '/') });
  }
  throw new HttpError(404, 'Tapılmadı');
}

// =============================================================== ümumi admin
const startedAt = Date.now();

async function routeAdmin(ctx: Ctx) {
  const { req, res, parts, url, ip } = ctx;
  const m = req.method;
  const path = parts.slice(2).join('/');

  if (m === 'POST' && path === 'login') {
    requireAdminIp(ctx);
    loginGuard(ctx, 'admin');
    const b = await body<LoginBody>(req);
    const ok = safeEqual(String(b.username ?? ''), config.adminUsername) && safeEqual(String(b.password ?? ''), config.adminPassword);
    if (!ok) {
      log({ level: 'warn', category: 'security', action: 'admin.login_failed', ip, actor: String(b.username ?? '').slice(0, 80) });
      throw new HttpError(401, 'İstifadəçi adı və ya şifrə yanlışdır');
    }
    log({ category: 'security', action: 'admin.login', ip, actor: 'admin' });
    const token = createSession({ role: 'admin', ip }, config.adminSessionMinutes);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(ADMIN_COOKIE, token, config.adminSessionMinutes * 60, '/') });
  }
  if (m === 'POST' && path === 'logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(ADMIN_COOKIE, '', 0, '/') });
  }

  requireAdmin(ctx);
  const db = await getDb();

  if (m === 'GET' && path === 'me') return send(res, 200, { role: 'admin', ip });
  if (m === 'GET' && path === 'overview') {
    const companyId = num(url.searchParams.get('company'));
    const [r] = await db.query(`SELECT
        (SELECT COUNT(*)::int FROM companies) AS companies,
        (SELECT COUNT(*)::int FROM companies WHERE active) AS active_companies,
        (SELECT COUNT(*)::int FROM logs WHERE category = 'request' AND at > now() - interval '24 hours') AS requests,
        (SELECT COUNT(*)::int FROM logs WHERE (level = 'error' OR status >= 500) AND at > now() - interval '24 hours') AS errors,
        (SELECT COUNT(*)::int FROM logs WHERE category = 'security' AND level <> 'info' AND at > now() - interval '24 hours') AS security,
        (SELECT COALESCE(ROUND(AVG(duration_ms)), 0)::int FROM logs WHERE category = 'request' AND at > now() - interval '24 hours') AS avg_ms`);
    const traffic = await db.query(`
      WITH h AS (SELECT generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') AS hour)
      SELECT to_char(h.hour AT TIME ZONE $1, 'HH24:00') AS hour,
        COUNT(l.id) FILTER (WHERE l.category = 'request')::int AS requests,
        COUNT(l.id) FILTER (WHERE l.level = 'error' OR l.status >= 500)::int AS errors
      FROM h LEFT JOIN logs l ON l.at >= h.hour AND l.at < h.hour + interval '1 hour'
      GROUP BY h.hour ORDER BY h.hour`, [config.timezone]);
    return send<AdminOverview>(res, 200, {
      stats: await svc.stats(companyId),
      companies: Number(r.companies), activeCompanies: Number(r.active_companies), requests24h: Number(r.requests),
      errors24h: Number(r.errors), securityEvents24h: Number(r.security), avgMs24h: Number(r.avg_ms),
      traffic: traffic.map((t) => ({ hour: String(t.hour), requests: Number(t.requests), errors: Number(t.errors) })),
    });
  }
  if (m === 'GET' && path === 'system') {
    const ping = await hesabatim.ping();
    return send<SystemInfo>(res, 200, {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
      database: config.databaseUrl ? 'postgres' : 'pglite',
      liveConnections: connectionCount(),
      hesabatim: {
        configured: Boolean(config.hesabatimApiUrl), apiUrl: config.hesabatimApiUrl || null,
        reachable: config.hesabatimApiUrl ? ping.reachable : null, latencyMs: ping.latencyMs,
        webhookConfigured: Boolean(config.hesabatimWebhookSecret), lastWebhookAt: svc.lastWebhookAt,
        lastSyncAt: svc.lastSyncAt, syncIntervalSec: config.syncIntervalSec,
      },
      admin: { allowedIps: config.adminAllowedIps, yourIp: ip },
      logRetentionDays: config.logRetentionDays,
    });
  }
  if (m === 'GET' && path === 'companies') return send(res, 200, await svc.listCompanies());
  if (m === 'POST' && path === 'companies') {
    const c = await svc.createCompany(await body<CompanyInput>(req));
    log({ category: 'audit', action: 'company.created', companyId: c.id, actor: 'admin', ip,
      message: `${c.name} (${c.slug})${c.hesabatim_slug ? ` → Hesabatım: ${c.hesabatim_slug}` : ''}` });
    return send(res, 201, await svc.companyAdminView(c));
  }
  if (m === 'PATCH' && parts[2] === 'companies' && parts[3]) {
    const b = await body<CompanyInput>(req);
    const c = await svc.updateCompany(Number(parts[3]), b);
    const changed = Object.keys(b).map((k) => (k === 'password' ? 'password(***)' : k)).join(', ');
    log({ category: 'audit', action: 'company.updated', companyId: c.id, actor: 'admin', ip, message: `${c.name}: ${changed}` });
    return send(res, 200, await svc.companyAdminView(c));
  }
  if (m === 'GET' && path === 'cards') {
    return send(res, 200, await svc.listCards(num(url.searchParams.get('company')), url.searchParams.get('q') ?? '', 100));
  }
  if (m === 'GET' && parts[2] === 'cards' && parts[3]) {
    const { card, company } = await svc.loadCard(svc.tokenFromText(decodeURIComponent(parts[3])), { ip });
    return send(res, 200, await svc.staffCard(card, company));
  }
  if (m === 'GET' && path === 'logs') {
    const p = url.searchParams;
    const rows = await db.query(
      `SELECT * FROM logs WHERE ($1 = '' OR category = $1) AND ($2 = '' OR level = $2)
         AND ($3::int IS NULL OR company_id = $3) AND ($4::bigint IS NULL OR id < $4)
         AND ($5 = '' OR action ILIKE '%' || $5 || '%' OR message ILIKE '%' || $5 || '%' OR ip ILIKE '%' || $5 || '%'
              OR actor ILIKE '%' || $5 || '%' OR meta::text ILIKE '%' || $5 || '%')
       ORDER BY id DESC LIMIT $6`,
      [p.get('category') ?? '', p.get('level') ?? '', num(p.get('company')), num(p.get('before')),
        (p.get('q') ?? '').slice(0, 100), Math.min(num(p.get('limit')) ?? 100, 500)]);
    return send(res, 200, rows.map(toLogEntry));
  }
  throw new HttpError(404, 'Tapılmadı');
}

// =============================================================== giriş nöqtəsi
const QUIET = /^\/api\/admin\/(overview|logs|system|me)$/; // admin panelin özünün yeniləmələri log selini yaratmasın

/** Loglarda kart tokenləri tam görünməsin (token = müştərinin açarıdır) */
const maskPath = (p: string) => p.replace(/\/(cards|c)\/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '/$1/$2…');

export async function handleApi(req: Req, res: ServerResponse, url: URL) {
  const started = Date.now();
  const ctx: Ctx = { req, res, url, parts: url.pathname.split('/').filter(Boolean), ip: clientIp(req) };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) {
      log({ level: 'warn', category: 'security', action: 'csrf.blocked', ip: ctx.ip, message: String(req.headers.origin) });
      throw new HttpError(403, 'Sorğunun mənbəyi təsdiqlənmədi');
    }
    if (ctx.parts[1] === 'panel') await routePanel(ctx);
    else if (ctx.parts[1] === 'admin') await routeAdmin(ctx);
    else await routePublic(ctx);
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message, ...e.extra });
    else if (e instanceof HesabatimError) {
      log({ level: e.status >= 500 ? 'error' : 'warn', category: 'integration', action: 'hesabatim.error', ip: ctx.ip,
        companyId: ctx.companyId, message: `${e.status}: ${e.message}` });
      send(res, e.status, { error: e.message });
    } else {
      log({ level: 'error', category: 'system', action: 'unhandled', ip: ctx.ip, companyId: ctx.companyId,
        message: e instanceof Error ? e.stack ?? e.message : String(e) });
      send(res, 500, { error: 'Server xətası' });
    }
  } finally {
    if (!(req.method === 'GET' && QUIET.test(url.pathname))) {
      log({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        category: 'request', action: `${req.method} ${maskPath(url.pathname)}`, ip: ctx.ip, companyId: ctx.companyId,
        status: res.statusCode, durationMs: Date.now() - started,
        meta: { ua: String(req.headers['user-agent'] ?? '').slice(0, 160) },
      });
    }
  }
}
