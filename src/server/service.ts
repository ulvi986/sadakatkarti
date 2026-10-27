// Biznes məntiqi: şirkətlər, kartlar, möhürlər, Hesabatım güzgüsü (mirror), statistika.
// Hər dəyişiklik bazaya yazılır, loglanır və SSE ilə müştəriyə + şirkətə + adminə göndərilir.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb, iso, type Row } from './db.js';
import { hashPassword, passwordFingerprint } from './auth.js';
import { hesabatim, HesabatimError, type HesabatimCard, type HesabatimWebhook } from './hesabatim.js';
import { log } from './logger.js';
import { publish, watchedCardTokens } from './realtime.js';
import { azPhoneError, normalizeAzPhone } from '../shared/phone.js';
import type {
  BrandTheme, CardEvent, CardListItem, CompanyAdminView, CompanyInput, DayPoint, PublicCard, PublicCompany, StaffCard, Stats,
} from '../shared/types.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface Company {
  id: number;
  slug: string;
  name: string;
  stamps_needed: number;
  reward: string;
  hesabatim_slug: string | null;
  logo: string | null;
  logo_hash: string | null;
  theme: Record<string, unknown> | null;
  username: string;
  password_hash: string;
  active: boolean;
  created_at: string;
  synced_at: string | null;
}

export interface Card {
  id: number;
  company_id: number;
  token: string;
  name: string;
  phone: string;
  stamps: number;
  total_stamps: number;
  rewards: number;
  source: 'local' | 'hesabatim';
  active: boolean;
  created_at: string;
  last_stamp_at: string | null;
  synced_at: string | null;
}

const toCompany = (r: Row): Company => ({
  ...(r as unknown as Company),
  id: Number(r.id),
  stamps_needed: Number(r.stamps_needed),
  created_at: iso(r.created_at)!,
  synced_at: iso(r.synced_at),
});

const toCard = (r: Row): Card => ({
  ...(r as unknown as Card),
  id: Number(r.id),
  company_id: Number(r.company_id),
  stamps: Number(r.stamps),
  total_stamps: Number(r.total_stamps),
  rewards: Number(r.rewards),
  created_at: iso(r.created_at)!,
  last_stamp_at: iso(r.last_stamp_at),
  synced_at: iso(r.synced_at),
});

export const normalizePhone = (p: unknown) => String(p ?? '').replace(/[^\d+]/g, '').slice(0, 20);
// Hesabatım slug-ları uzun ola bilər və /k/<slug> onlarla eyni olmalıdır
const SLUG_RE = /^[a-z0-9-]{2,220}$/;

// =============================================================== şirkətlər
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Yalnız düzgün #rrggbb rəngləri buraxırıq (CSS-ə yazılır) */
function brandTheme(t: Record<string, unknown> | null): BrandTheme {
  const out: BrandTheme = {};
  for (const k of ['primary', 'accent', 'card'] as const) {
    const v = t?.[k];
    if (typeof v === 'string' && HEX.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

export function publicCompany(c: Company): PublicCompany {
  return {
    slug: c.slug, name: c.name, stampsNeeded: c.stamps_needed, reward: c.reward, linked: Boolean(c.hesabatim_slug),
    logoUrl: c.logo && c.logo_hash ? `/api/companies/${encodeURIComponent(c.slug)}/logo?v=${c.logo_hash}` : null,
    theme: brandTheme(c.theme),
  };
}

/** data:image/...;base64 loqosunu fayl kimi qaytarır (yalnız şəkil növləri) */
export function companyLogo(c: Company): { mime: string; body: Buffer } | null {
  const m = c.logo?.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  return m ? { mime: m[1], body: Buffer.from(m[2], 'base64') } : null;
}

export async function companyBySlug(slug: string): Promise<Company | undefined> {
  const db = await getDb();
  const [r] = await db.query('SELECT * FROM companies WHERE slug = $1', [slug]);
  return r ? toCompany(r) : undefined;
}

export async function companyById(id: number): Promise<Company | undefined> {
  const db = await getDb();
  const [r] = await db.query('SELECT * FROM companies WHERE id = $1', [id]);
  return r ? toCompany(r) : undefined;
}

export async function companyByUsername(username: string): Promise<Company | undefined> {
  const db = await getDb();
  const [r] = await db.query('SELECT * FROM companies WHERE lower(username) = lower($1)', [username]);
  return r ? toCompany(r) : undefined;
}

/** "/" ünvanının şirkəti: DEFAULT_COMPANY və ya yeganə aktiv şirkət */
export async function defaultCompany(): Promise<Company | undefined> {
  if (config.defaultCompany) return companyBySlug(config.defaultCompany);
  const db = await getDb();
  const rows = await db.query('SELECT * FROM companies WHERE active ORDER BY id LIMIT 2');
  return rows.length === 1 ? toCompany(rows[0]) : undefined;
}

export async function activeCompany(slug: string): Promise<Company> {
  const c = (await companyBySlug(slug)) ?? (await companyFromHesabatim(slug));
  if (!c || !c.active) throw new HttpError(404, 'Şirkət tapılmadı');
  return syncCompany(c);
}

/** Hesabatım-a bağlı şirkətin adı/möhür sayı/hədiyyəsi Hesabatım-dan gəlir (dəqiqədə bir yenilənir) */
export async function syncCompany(c: Company, force = false): Promise<Company> {
  if (!c.hesabatim_slug || !config.hesabatimApiUrl) return c;
  if (!force && c.synced_at && Date.now() - Date.parse(c.synced_at) < 60_000) return c;
  try {
    const b = await hesabatim.business(c.hesabatim_slug);
    return await applyBusiness(c, { name: b.name, stamps_needed: b.stamps_needed, reward: b.reward,
      logo: b.logo ?? null, theme: b.theme ?? null });
  } catch (e) {
    log({ level: 'warn', category: 'integration', action: 'hesabatim.business_failed', companyId: c.id,
      message: e instanceof Error ? e.message : String(e) });
    return c;
  }
}

// Hesabatım-da tapılmayan slug-lar üçün qısa mənfi keş (naməlum /k/... linkləri Hesabatım-ı yükləməsin)
const unknownSlugs = new Map<string, number>();

/** /k/<slug> bizdə yoxdursa, amma Hesabatım bu biznesi tanıyırsa — bağlı şirkəti avtomatik yarat */
async function companyFromHesabatim(slug: string): Promise<Company | undefined> {
  if (!config.hesabatimApiUrl || !SLUG_RE.test(slug)) return undefined;
  if ((unknownSlugs.get(slug) ?? 0) > Date.now()) return undefined;
  try {
    const b = await hesabatim.business(slug);
    return await ensureLinkedCompany(slug, { name: b.name, stamps_needed: b.stamps_needed, reward: b.reward,
      logo: b.logo ?? null, theme: b.theme ?? null }, 'lookup');
  } catch (e) {
    if (e instanceof HesabatimError && e.status === 404) unknownSlugs.set(slug, Date.now() + 60_000);
    return undefined;
  }
}

/** Hesabatım biznesi üçün eyni slug-lu bağlı şirkət (yoxdursa yaradır). Panel şifrəsi təsadüfidir — admin sıfırlayır */
export async function ensureLinkedCompany(slug: string, b: BusinessData,
  via: 'webhook' | 'lookup'): Promise<Company | undefined> {
  const db = await getDb();
  const [linked] = await db.query('SELECT * FROM companies WHERE hesabatim_slug = $1 ORDER BY id LIMIT 1', [slug]);
  if (linked) return toCompany(linked);
  const [r] = await db.query(
    `INSERT INTO companies (slug, name, stamps_needed, reward, hesabatim_slug, username, password_hash, synced_at)
     VALUES ($1, $2, $3, $4, $1,
             CASE WHEN EXISTS (SELECT 1 FROM companies WHERE lower(username) = lower($1)) THEN $1 || '-' || $5 ELSE $1 END,
             $6, now())
     ON CONFLICT (slug) DO NOTHING RETURNING *`,
    [slug, (b.name || slug).slice(0, 80), b.stamps_needed ?? 9, b.reward || 'Pulsuz məhsul',
      crypto.randomBytes(3).toString('hex'), hashPassword(crypto.randomBytes(18).toString('base64url'))]);
  if (!r) {
    // Eyni slug-lu müstəqil (əl ilə yaradılmış) şirkət var — üstünə yazmırıq
    log({ level: 'warn', category: 'integration', action: 'company.auto_create_conflict', message: `${slug}: bu slug artıq müstəqil şirkətdədir` });
    return undefined;
  }
  const c = toCompany(r);
  log({ category: 'integration', action: 'company.auto_created', companyId: c.id, actor: 'hesabatim',
    message: `${c.name} (${slug}) Hesabatım-dan avtomatik yaradıldı (${via}); panel girişi: ${c.username}, şifrəni admin paneldən təyin edin` });
  return b.logo !== undefined || b.theme !== undefined ? applyBusiness(c, { logo: b.logo, theme: b.theme }) : c;
}

/** Hesabatım-dan gələn biznes məlumatı. logo/theme: undefined = toxunma, null = sil */
export interface BusinessData {
  name?: string;
  stamps_needed?: number;
  reward?: string;
  logo?: string | null;
  theme?: Record<string, unknown> | null;
}

async function applyBusiness(c: Company, b: BusinessData): Promise<Company> {
  const db = await getDb();
  // Loqo: yalnız data:image (≤ ~700 KB), Hesabatım 512 KB-dan böyüyünü onsuz da qəbul etmir
  const logo = b.logo === undefined ? undefined
    : b.logo && /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.logo) && b.logo.length < 720_000 ? b.logo : null;
  const logoHash = logo ? crypto.createHash('sha256').update(logo).digest('hex').slice(0, 12) : null;
  const theme = b.theme === undefined ? undefined : brandTheme(b.theme);
  const [r] = await db.query(
    `UPDATE companies SET name = COALESCE($2, name), stamps_needed = COALESCE($3, stamps_needed),
       reward = COALESCE($4, reward),
       logo = CASE WHEN $5 THEN $6 ELSE logo END, logo_hash = CASE WHEN $5 THEN $7 ELSE logo_hash END,
       theme = CASE WHEN $8 THEN $9::jsonb ELSE theme END,
       synced_at = now() WHERE id = $1 RETURNING *`,
    [c.id, b.name ?? null, b.stamps_needed ?? null, b.reward ?? null,
      logo !== undefined, logo ?? null, logoHash, theme !== undefined, theme ? JSON.stringify(theme) : null]);
  const next = toCompany(r);
  const changed: string[] = [];
  if (next.name !== c.name || next.stamps_needed !== c.stamps_needed || next.reward !== c.reward) {
    changed.push(`${next.stamps_needed} möhür, hədiyyə "${next.reward}"`);
  }
  if (next.logo_hash !== c.logo_hash) changed.push(next.logo ? 'yeni loqo' : 'loqo silindi');
  if (JSON.stringify(brandTheme(next.theme)) !== JSON.stringify(brandTheme(c.theme))) {
    changed.push(`rənglər ${JSON.stringify(brandTheme(next.theme))}`);
  }
  if (changed.length) {
    log({ category: 'integration', action: 'company.synced', companyId: c.id, actor: 'hesabatim',
      message: `${next.name}: ${changed.join(', ')}` });
    publish(`company:${c.id}`, { type: 'company', company: publicCompany(next) });
    // Ekranda açıq olan kartlar yeni rəng/loqonu dərhal alsın
    const watched = watchedCardTokens();
    if (watched.length) {
      const open = await db.query('SELECT * FROM cards WHERE company_id = $1 AND token = ANY($2::text[])', [c.id, watched]);
      for (const k of open.map(toCard)) publish(`card:${k.token}`, { type: 'card', card: publicCard(k, next) });
    }
  }
  return next;
}

export async function companyAdminView(c: Company): Promise<CompanyAdminView> {
  const [v] = await listCompanies(c.id);
  return v;
}

export async function listCompanies(onlyId?: number): Promise<CompanyAdminView[]> {
  const db = await getDb();
  const rows = await db.query(`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM cards k WHERE k.company_id = c.id) AS card_count,
      (SELECT COALESCE(SUM(amount), 0)::int FROM events e WHERE e.company_id = c.id AND e.type = 'stamp'
         AND (e.at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) AS stamps_today,
      (SELECT COALESCE(SUM(amount), 0)::int FROM events e WHERE e.company_id = c.id AND e.type = 'stamp'
         AND e.at > now() - interval '30 days') AS stamps_30d
    FROM companies c WHERE ($2::int IS NULL OR c.id = $2) ORDER BY c.id`, [config.timezone, onlyId ?? null]);
  return rows.map((r) => {
    const c = toCompany(r);
    return {
      id: c.id, slug: c.slug, name: c.name, stampsNeeded: c.stamps_needed, reward: c.reward,
      hesabatimSlug: c.hesabatim_slug, username: c.username, active: c.active, createdAt: c.created_at,
      syncedAt: c.synced_at, cards: Number(r.card_count), stampsToday: Number(r.stamps_today),
      stamps30d: Number(r.stamps_30d),
    };
  });
}

function validateCompany(input: CompanyInput, creating: boolean) {
  const out: Record<string, unknown> = {};
  if (input.slug !== undefined || creating) {
    const slug = String(input.slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Slug yalnız kiçik hərf, rəqəm və "-" (2–220 simvol)');
    out.slug = slug;
  }
  if (input.name !== undefined || creating) {
    const name = String(input.name ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Şirkətin adını yazın');
    out.name = name;
  }
  if (input.stampsNeeded !== undefined) {
    const n = Number(input.stampsNeeded);
    if (!Number.isInteger(n) || n < 2 || n > 30) throw new HttpError(400, 'Möhür sayı 2–30 arası olmalıdır');
    out.stamps_needed = n;
  }
  if (input.reward !== undefined) {
    const r = String(input.reward).trim().slice(0, 120);
    if (r.length < 2) throw new HttpError(400, 'Hədiyyəni yazın');
    out.reward = r;
  }
  if (input.hesabatimSlug !== undefined) {
    const s = input.hesabatimSlug ? String(input.hesabatimSlug).trim().toLowerCase() : null;
    if (s && !/^[a-z0-9-]{1,220}$/.test(s)) throw new HttpError(400, 'Hesabatım slug-u yanlışdır');
    out.hesabatim_slug = s;
  }
  if (input.username !== undefined || creating) {
    const u = String(input.username ?? '').trim();
    if (!/^[A-Za-z0-9._@!-]{3,80}$/.test(u)) throw new HttpError(400, 'İstifadəçi adı 3–80 simvol (hərf, rəqəm, . _ @ ! -)');
    out.username = u;
  }
  if (input.password !== undefined || creating) {
    const p = String(input.password ?? '');
    if (p.length < 8) throw new HttpError(400, 'Şifrə ən azı 8 simvol olmalıdır');
    out.password_hash = hashPassword(p);
  }
  if (input.active !== undefined) out.active = Boolean(input.active);
  return out;
}

export async function createCompany(input: CompanyInput): Promise<Company> {
  const v = validateCompany(input, true);
  if (v.hesabatim_slug) {
    if (!config.hesabatimApiUrl) throw new HttpError(400, 'HESABATIM_API_URL qurulmayıb');
    await hesabatim.business(String(v.hesabatim_slug)).catch((e) => {
      throw new HttpError(400, `Hesabatım-da bu slug tapılmadı: ${e instanceof Error ? e.message : e}`);
    });
  }
  const db = await getDb();
  const cols = Object.keys(v);
  try {
    const [r] = await db.query(
      `INSERT INTO companies (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(v));
    return syncCompany(toCompany(r), true);
  } catch (e) {
    if (String((e as { code?: string }).code) === '23505') throw new HttpError(409, 'Bu slug və ya istifadəçi adı artıq var');
    throw e;
  }
}

export async function updateCompany(id: number, input: CompanyInput): Promise<Company> {
  const v = validateCompany(input, false);
  const db = await getDb();
  const cols = Object.keys(v);
  if (!cols.length) throw new HttpError(400, 'Dəyişiklik yoxdur');
  try {
    const [r] = await db.query(
      `UPDATE companies SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...Object.values(v)]);
    if (!r) throw new HttpError(404, 'Şirkət tapılmadı');
    return syncCompany(toCompany(r), true);
  } catch (e) {
    if (String((e as { code?: string }).code) === '23505') throw new HttpError(409, 'Bu slug və ya istifadəçi adı artıq var');
    throw e;
  }
}

export const companyFingerprint = (c: Company) => passwordFingerprint(c.password_hash);

// =============================================================== kartlar
export function publicCard(card: Card, company: Company): PublicCard {
  return {
    token: card.token,
    name: card.name.split(' ')[0],
    stamps: card.stamps,
    stampsNeeded: company.stamps_needed,
    rewardReady: card.stamps >= company.stamps_needed,
    rewards: card.rewards,
    active: card.active,
    company: publicCompany(company),
  };
}

function listItem(card: Card, company: Company): CardListItem {
  return {
    token: card.token, name: card.name, phone: card.phone, stamps: card.stamps, stampsNeeded: company.stamps_needed,
    rewards: card.rewards, totalStamps: card.total_stamps, source: card.source, lastStampAt: card.last_stamp_at,
    createdAt: card.created_at, companySlug: company.slug, companyName: company.name,
  };
}

export async function staffCard(card: Card, company: Company): Promise<StaffCard> {
  const db = await getDb();
  const history = await db.query('SELECT type, amount, actor, at FROM events WHERE card_id = $1 ORDER BY id DESC LIMIT 20', [card.id]);
  return {
    ...publicCard(card, company),
    name: card.name,
    phone: card.phone,
    totalStamps: card.total_stamps,
    createdAt: card.created_at,
    lastStampAt: card.last_stamp_at,
    source: card.source,
    syncedAt: card.synced_at,
    history: history.map((h) => ({ type: h.type as CardEvent['type'], amount: Number(h.amount), actor: String(h.actor), at: iso(h.at)! })),
  };
}

async function cardRow(token: string): Promise<Card | undefined> {
  const db = await getDb();
  const [r] = await db.query('SELECT * FROM cards WHERE token = $1', [token]);
  return r ? toCard(r) : undefined;
}

/** Kartın bütün dinləyicilərinə (müştəri, şirkət, admin) xəbər ver */
function broadcast(card: Card, company: Company, kind: CardEvent['type'] | 'signup', amount: number, actor: string) {
  publish(`card:${card.token}`, { type: 'card', card: publicCard(card, company) });
  const activity = {
    type: 'activity' as const, companyId: company.id, companySlug: company.slug, kind,
    card: listItem(card, company), amount, actor, at: new Date().toISOString(),
  };
  publish(`company:${company.id}`, activity);
  publish('admin', activity);
}

export async function signup(company: Company, rawName: unknown, rawPhone: unknown, ip: string): Promise<PublicCard> {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'Adınızı yazın');
  const phone = normalizeAzPhone(rawPhone);
  if (!phone) throw new HttpError(400, azPhoneError(rawPhone) ?? 'Telefon nömrəsi yanlışdır');
  const db = await getDb();

  if (company.hesabatim_slug) {
    // Kart Hesabatım-ın customers cədvəlində yaranır, biz güzgüsünü saxlayırıq
    const hc = await hesabatim.signup(company.hesabatim_slug, name, phone, ip);
    const [existing] = await db.query('SELECT * FROM cards WHERE company_id = $1 AND phone = $2', [company.id, phone]);
    const card = existing
      ? toCard((await db.query(
        `UPDATE cards SET token = $2, stamps = $3, rewards = $4, total_stamps = GREATEST(total_stamps, $5), active = true,
           synced_at = now(), last_seen_at = now() WHERE id = $1 RETURNING *`,
        [existing.id, hc.token, hc.stamps, hc.rewards, hc.total_stamps ?? 0]))[0])
      : toCard((await db.query(
        `INSERT INTO cards (company_id, token, name, phone, stamps, rewards, total_stamps, source, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'hesabatim', now())
         ON CONFLICT (token) DO UPDATE SET last_seen_at = now() RETURNING *`,
        [company.id, hc.token, name, phone, hc.stamps, hc.rewards, hc.total_stamps ?? 0]))[0]);
    if (!existing) {
      log({ category: 'audit', action: 'card.signup', companyId: company.id, actor: 'customer', ip,
        message: `${name} kart açdı (Hesabatım)`, meta: { token: mask(card.token) } });
      broadcast(card, company, 'signup', 0, 'customer');
    }
    return publicCard(card, company);
  }

  const token = crypto.randomBytes(12).toString('base64url');
  const [inserted] = await db.query(
    `INSERT INTO cards (company_id, token, name, phone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, phone) DO NOTHING RETURNING *`, [company.id, token, name, phone]);
  if (inserted) {
    const card = toCard(inserted);
    log({ category: 'audit', action: 'card.signup', companyId: company.id, actor: 'customer', ip,
      message: `${name} kart açdı`, meta: { token: mask(card.token) } });
    broadcast(card, company, 'signup', 0, 'customer');
    return publicCard(card, company);
  }
  // Eyni nömrə ilə təkrar gəlib (telefonu dəyişib) — köhnə kartını qaytarırıq
  const [r] = await db.query('SELECT * FROM cards WHERE company_id = $1 AND phone = $2', [company.id, phone]);
  log({ category: 'audit', action: 'card.recovered', companyId: company.id, actor: 'customer', ip,
    message: `${name} nömrə ilə kartını geri aldı` });
  return publicCard(toCard(r), company);
}

export const mask = (token: string) => `${token.slice(0, 4)}…`;

/** "Kartım var": telefon nömrəsi ilə həmin şirkətdəki kartı tapır (yeni telefonda və ya brauzer təmizlənəndə) */
export async function findCard(company: Company, rawPhone: unknown, ip: string): Promise<PublicCard> {
  const phone = normalizeAzPhone(rawPhone);
  if (!phone) throw new HttpError(400, azPhoneError(rawPhone) ?? 'Telefon nömrəsi yanlışdır');
  const db = await getDb();
  const [r] = await db.query('SELECT * FROM cards WHERE company_id = $1 AND phone = $2', [company.id, phone]);
  if (!r) {
    log({ category: 'audit', action: 'card.login_not_found', companyId: company.id, actor: 'customer', ip });
    throw new HttpError(404, 'Bu nömrə ilə kart tapılmadı. Yeni kart açın.');
  }
  let card = toCard(r);
  if (card.source === 'hesabatim') card = await refreshFromHesabatim(card, company, ip);
  log({ category: 'audit', action: 'card.login', companyId: company.id, actor: 'customer', ip,
    message: `${card.name} nömrə ilə kartına daxil oldu`, meta: { token: mask(card.token) } });
  return publicCard(card, company);
}

/** QR mətnindən tokeni çıxarır (tam URL və ya sadəcə token) */
export function tokenFromText(text: string): string {
  const m = text.match(/\/c\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : text.trim();
}

/** Kartı və şirkətini qaytarır; Hesabatım kartıdırsa əvvəlcə ordan təzələyir */
export async function loadCard(token: string, opts: { refresh?: boolean; ip?: string | null } = {}) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) throw new HttpError(404, 'Kart tapılmadı');
  let card = await cardRow(token);
  if (!card) throw new HttpError(404, 'Kart tapılmadı');
  let company = (await companyById(card.company_id))!;
  if (!company.active) throw new HttpError(404, 'Kart tapılmadı');
  if (card.source === 'hesabatim' && opts.refresh !== false) {
    company = await syncCompany(company);
    card = await refreshFromHesabatim(card, company, opts.ip ?? null);
  }
  const db = await getDb();
  await db.query('UPDATE cards SET last_seen_at = now() WHERE id = $1', [card.id]);
  return { card, company };
}

/** Hesabatım-dakı vəziyyəti güzgüyə köçürür; fərq varsa hadisə yazır və yayımlayır */
export async function refreshFromHesabatim(card: Card, company: Company, ip: string | null, minAgeMs = 3000): Promise<Card> {
  if (card.synced_at && Date.now() - Date.parse(card.synced_at) < minAgeMs) return card;
  try {
    const hc = await hesabatim.card(card.token, ip);
    return await applyHesabatimCard(card, company, hc, 'hesabatim');
  } catch (e) {
    if (e instanceof HesabatimError && e.status === 404 && card.active) {
      // Hesabatım kartı yenisi ilə əvəz edib (itmiş telefon) — köhnə token artıq işləmir
      const db = await getDb();
      const [r] = await db.query('UPDATE cards SET active = false, synced_at = now() WHERE id = $1 RETURNING *', [card.id]);
      const next = toCard(r);
      log({ level: 'warn', category: 'integration', action: 'card.deactivated', companyId: company.id, actor: 'hesabatim',
        message: `${card.name}: kart Hesabatım-da tapılmadı (yenisi verilib?)`, meta: { token: mask(card.token) } });
      publish(`card:${card.token}`, { type: 'card', card: publicCard(next, company) });
      return next;
    }
    if (!(e instanceof HesabatimError)) throw e;
    return card; // Hesabatım müvəqqəti əlçatan deyil — güzgüdəki son vəziyyəti göstəririk
  }
}

async function applyHesabatimCard(card: Card, company: Company, hc: HesabatimCard, actor: string): Promise<Card> {
  const db = await getDb();
  const [r] = await db.query(
    `UPDATE cards SET stamps = $2, rewards = $3, total_stamps = GREATEST(total_stamps, $4), active = true,
       last_stamp_at = CASE WHEN $2 > stamps OR $3 > rewards THEN now() ELSE last_stamp_at END, synced_at = now()
     WHERE id = $1 RETURNING *`,
    [card.id, hc.stamps, hc.rewards, hc.total_stamps ?? 0]);
  const next = toCard(r);
  const redeemed = next.rewards - card.rewards;
  const stamped = redeemed > 0 ? next.stamps : next.stamps - card.stamps;
  const kind: CardEvent['type'] | null = redeemed > 0 ? 'redeem' : stamped > 0 ? 'stamp'
    : next.stamps !== card.stamps ? 'adjust' : null;
  if (redeemed > 0) await recordEvent(next, 'redeem', redeemed, actor);
  if (stamped > 0) await recordEvent(next, 'stamp', stamped, actor);
  if (kind === 'adjust') await recordEvent(next, 'adjust', next.stamps - card.stamps, actor);
  if (kind || !card.active) {
    log({ category: 'audit', action: `card.${kind ?? 'reactivated'}`, companyId: company.id, actor,
      message: `${next.name}: ${card.stamps} → ${next.stamps}/${company.stamps_needed} (Hesabatım)`, meta: { token: mask(next.token) } });
    broadcast(next, company, kind ?? 'adjust', kind === 'redeem' ? redeemed : stamped, actor);
  }
  return next;
}

async function recordEvent(card: Card, type: CardEvent['type'], amount: number, actor: string) {
  const db = await getDb();
  await db.query('INSERT INTO events (card_id, company_id, type, amount, actor) VALUES ($1, $2, $3, $4, $5)',
    [card.id, card.company_id, type, amount, actor]);
}

function assertLocal(company: Company) {
  if (company.hesabatim_slug) throw new HttpError(409, 'Bu şirkətin möhürləri Hesabatım-da vurulur: Müştərilər → Kartı oxut');
}

export async function stamp(company: Company, token: string, countRaw: unknown, force: boolean, actor: string, ip: string) {
  assertLocal(company);
  const { card } = await loadCard(token, { refresh: false });
  if (card.company_id !== company.id) throw new HttpError(404, 'Kart tapılmadı');
  if (card.stamps >= company.stamps_needed) {
    throw new HttpError(409, 'Hədiyyə hazırdır — əvvəlcə onu verin', { card: await staffCard(card, company) });
  }
  const count = Math.max(1, Math.min(Number(countRaw) || 1, company.stamps_needed - card.stamps));
  const db = await getDb();
  // Bir sorğuda: limit və cooldown şərti ilə yenilə + hadisəni yaz (paralel iki skan ikiqat möhür vurmasın)
  const [r] = await db.query(
    `WITH u AS (
       UPDATE cards SET stamps = stamps + $2, total_stamps = total_stamps + $2, last_stamp_at = now()
       WHERE id = $1 AND stamps + $2 <= $3
         AND ($4 OR last_stamp_at IS NULL OR last_stamp_at < now() - make_interval(secs => $5))
       RETURNING *
     ), e AS (
       INSERT INTO events (card_id, company_id, type, amount, actor) SELECT id, company_id, 'stamp', $2, $6 FROM u
     ) SELECT * FROM u`,
    [card.id, count, company.stamps_needed, force, config.cooldownSec, actor]);
  if (!r) {
    const fresh = (await cardRow(token))!;
    const ago = fresh.last_stamp_at ? Math.round((Date.now() - Date.parse(fresh.last_stamp_at)) / 1000) : 0;
    log({ level: 'warn', category: 'audit', action: 'card.stamp_blocked', companyId: company.id, actor, ip,
      message: `${fresh.name}: ${ago} san. əvvəl möhür vurulub` });
    throw new HttpError(429, `Bu karta ${ago} saniyə əvvəl möhür vurulub`, { cooldown: true, card: await staffCard(fresh, company) });
  }
  const next = toCard(r);
  log({ category: 'audit', action: 'card.stamp', companyId: company.id, actor, ip,
    message: `${next.name}: +${count} → ${next.stamps}/${company.stamps_needed}${force ? ' (təkrar təsdiqlə)' : ''}`,
    meta: { token: mask(next.token) } });
  broadcast(next, company, 'stamp', count, actor);
  return staffCard(next, company);
}

export async function redeem(company: Company, token: string, actor: string, ip: string) {
  assertLocal(company);
  const { card } = await loadCard(token, { refresh: false });
  if (card.company_id !== company.id) throw new HttpError(404, 'Kart tapılmadı');
  const db = await getDb();
  const [r] = await db.query(
    `WITH u AS (UPDATE cards SET stamps = 0, rewards = rewards + 1 WHERE id = $1 AND stamps >= $2 RETURNING *),
     e AS (INSERT INTO events (card_id, company_id, type, amount, actor) SELECT id, company_id, 'redeem', 1, $3 FROM u)
     SELECT * FROM u`, [card.id, company.stamps_needed, actor]);
  if (!r) throw new HttpError(409, 'Hələ kifayət qədər möhür yoxdur');
  const next = toCard(r);
  log({ category: 'audit', action: 'card.redeem', companyId: company.id, actor, ip,
    message: `${next.name}: hədiyyə verildi (${company.reward})`, meta: { token: mask(next.token) } });
  broadcast(next, company, 'redeem', 1, actor);
  return staffCard(next, company);
}

export async function listCards(companyId: number | null, q: string, limit = 50): Promise<CardListItem[]> {
  const db = await getDb();
  const term = q.trim();
  // "050 123" kimi axtarış "+99450123..." ilə tapılsın
  const digits = term.replace(/\D/g, '').replace(/^(00994|994|0)/, '');
  const rows = await db.query(
    `SELECT k.*, c.slug AS c_slug, c.name AS c_name, c.stamps_needed AS c_needed FROM cards k
     JOIN companies c ON c.id = k.company_id
     WHERE ($1::int IS NULL OR k.company_id = $1)
       AND ($2 = '' OR k.name ILIKE '%' || $2 || '%' OR k.phone ILIKE '%' || $2 || '%'
            OR ($4 <> '' AND k.phone LIKE '%' || $4 || '%'))
     ORDER BY COALESCE(k.last_stamp_at, k.created_at) DESC LIMIT $3`, [companyId, term, limit, digits]);
  return rows.map((r) => {
    const k = toCard(r);
    return {
      token: k.token, name: k.name, phone: k.phone, stamps: k.stamps, stampsNeeded: Number(r.c_needed),
      rewards: k.rewards, totalStamps: k.total_stamps, source: k.source, lastStampAt: k.last_stamp_at,
      createdAt: k.created_at, companySlug: String(r.c_slug), companyName: String(r.c_name),
    };
  });
}

// =============================================================== statistika
export async function stats(companyId: number | null): Promise<Stats> {
  const db = await getDb();
  const tz = config.timezone;
  const today = `(at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`;
  const scope = '($2::int IS NULL OR company_id = $2)';
  const [s] = await db.query(`SELECT
      (SELECT COUNT(*)::int FROM cards WHERE ${scope}) AS cards,
      (SELECT COUNT(*)::int FROM cards WHERE ${scope} AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) AS new_today,
      (SELECT COALESCE(SUM(amount), 0)::int FROM events WHERE ${scope} AND type = 'stamp' AND ${today}) AS stamps_today,
      (SELECT COUNT(*)::int FROM events WHERE ${scope} AND type = 'redeem' AND ${today}) AS rewards_today,
      (SELECT COALESCE(SUM(amount), 0)::int FROM events WHERE ${scope} AND type = 'redeem') AS rewards_total,
      (SELECT COUNT(*)::int FROM cards k JOIN companies c ON c.id = k.company_id
         WHERE ($2::int IS NULL OR k.company_id = $2) AND k.stamps >= c.stamps_needed) AS reward_ready`,
  [tz, companyId]);
  const days = await db.query(`
    WITH d AS (
      SELECT generate_series((now() AT TIME ZONE $1)::date - 13, (now() AT TIME ZONE $1)::date, interval '1 day')::date AS day
    ),
    s AS (SELECT (created_at AT TIME ZONE $1)::date AS day, COUNT(*)::int AS n FROM cards
          WHERE ${scope} AND created_at > now() - interval '15 days' GROUP BY 1),
    e AS (SELECT (at AT TIME ZONE $1)::date AS day,
                 COALESCE(SUM(amount) FILTER (WHERE type = 'stamp'), 0)::int AS stamps,
                 COALESCE(SUM(amount) FILTER (WHERE type = 'redeem'), 0)::int AS redeems
          FROM events WHERE ${scope} AND at > now() - interval '15 days' GROUP BY 1)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(s.n, 0) AS signups,
           COALESCE(e.stamps, 0) AS stamps, COALESCE(e.redeems, 0) AS redeems
    FROM d LEFT JOIN s ON s.day = d.day LEFT JOIN e ON e.day = d.day ORDER BY d.day`, [tz, companyId]);
  return {
    cards: Number(s.cards), newCardsToday: Number(s.new_today), stampsToday: Number(s.stamps_today),
    rewardsToday: Number(s.rewards_today), rewardsTotal: Number(s.rewards_total), rewardReady: Number(s.reward_ready),
    days: days.map((d) => ({ day: String(d.day), signups: Number(d.signups), stamps: Number(d.stamps), redeems: Number(d.redeems) }) satisfies DayPoint),
  };
}

// =============================================================== Hesabatım webhook və fon sinxronizasiyası
export let lastWebhookAt: string | null = null;
export let lastSyncAt: string | null = null;

export async function handleWebhook(w: HesabatimWebhook, ip: string) {
  const db = await getDb();
  if (w.id) {
    const [fresh] = await db.query('INSERT INTO webhook_seen (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [String(w.id).slice(0, 80)]);
    if (!fresh) return { duplicate: true };
  }
  lastWebhookAt = new Date().toISOString();
  if (w.event === 'business.created') {
    const c = await ensureLinkedCompany(w.business_slug, { name: w.name, stamps_needed: w.stamps_needed, reward: w.reward,
      logo: w.logo, theme: w.theme }, 'webhook');
    log({ category: 'integration', action: 'webhook.received', ip, message: `${w.event} · ${w.business_slug}` });
    return c ? { ok: true, company: c.slug } : { ignored: true };
  }
  const companies = (await db.query('SELECT * FROM companies WHERE hesabatim_slug = $1', [w.business_slug])).map(toCompany);
  if (!companies.length) {
    log({ level: 'warn', category: 'integration', action: 'webhook.unknown_business', ip, message: `${w.event}: ${w.business_slug}` });
    return { ignored: true };
  }
  for (let company of companies) {
    if (w.event === 'business.updated') {
      await applyBusiness(company, { name: w.name, stamps_needed: w.stamps_needed, reward: w.reward, logo: w.logo, theme: w.theme });
      continue;
    }
    if (w.stamps_needed !== undefined && w.stamps_needed !== company.stamps_needed) {
      company = await applyBusiness(company, { stamps_needed: w.stamps_needed });
    }
    if (!w.card_token) continue;
    if (w.event === 'loyalty.new_card' && w.old_token) {
      // Hesabatım kartı yenisi ilə əvəz edib: güzgüdə tokeni dəyiş, köhnə tokenin dinləyicilərinə xəbər ver
      const [r] = await db.query('UPDATE cards SET token = $2, active = true, synced_at = now() WHERE token = $1 AND company_id = $3 RETURNING *',
        [w.old_token, w.card_token, company.id]);
      if (r) {
        publish(`card:${w.old_token}`, { type: 'card', card: { ...publicCard(toCard(r), company), token: w.old_token, active: false } });
        log({ category: 'integration', action: 'card.reissued', companyId: company.id, actor: 'hesabatim',
          message: `${String(r.name)}: yeni kart verildi`, meta: { token: mask(w.card_token) } });
      }
    }
    const card = await cardRow(w.card_token);
    if (!card) continue; // Hesabatım-da əl ilə yaradılmış müştəri — müştəri saytımıza girəndə güzgülənəcək
    await applyHesabatimCard(card, company, {
      token: w.card_token, name: w.name ?? card.name, stamps: w.stamps ?? card.stamps,
      stamps_needed: company.stamps_needed, reward_ready: false, rewards: w.rewards ?? card.rewards,
      total_stamps: w.total_stamps,
    }, 'hesabatim');
  }
  log({ category: 'integration', action: 'webhook.received', ip, message: `${w.event} · ${w.business_slug}` });
  return { ok: true };
}

/** Webhook gəlməsə belə: indi ekranda açıq olan kartları və ən köhnə sinxronlanmış kartları yenilə */
export async function syncTick(watchedTokens: string[]) {
  if (!config.hesabatimApiUrl) return;
  const db = await getDb();
  const rows = await db.query(
    `SELECT k.* FROM cards k JOIN companies c ON c.id = k.company_id
     WHERE k.source = 'hesabatim' AND k.active AND c.active AND c.hesabatim_slug IS NOT NULL
       AND (k.token = ANY($1::text[])
            OR (k.last_seen_at > now() - interval '30 days' AND (k.synced_at IS NULL OR k.synced_at < now() - interval '10 minutes')))
     ORDER BY (k.token = ANY($1::text[])) DESC, k.synced_at NULLS FIRST LIMIT 60`, [watchedTokens]);
  const companies = new Map<number, Company>();
  const cards = rows.map(toCard);
  for (let i = 0; i < cards.length; i += 6) {
    await Promise.all(cards.slice(i, i + 6).map(async (card) => {
      let company = companies.get(card.company_id);
      if (!company) {
        company = await syncCompany((await companyById(card.company_id))!);
        companies.set(card.company_id, company);
      }
      await refreshFromHesabatim(card, company, null, Math.max(1000, config.syncIntervalSec * 500)).catch(() => {});
    }));
  }
  lastSyncAt = new Date().toISOString();
}

/** Köhnə tək-şirkət quraşdırması (HESABATIM_BUSINESS) üçün ilk şirkəti avtomatik yaradır */
export async function bootstrap() {
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM companies');
  if (Number(n) > 0 || !config.legacyHesabatimBusiness) return;
  const slug = config.legacyHesabatimBusiness.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  const password = crypto.randomBytes(9).toString('base64url');
  await createCompany({ slug, name: slug, hesabatimSlug: config.legacyHesabatimBusiness, username: slug, password })
    .then(() => log({ category: 'system', action: 'company.bootstrap', message: `Şirkət "${slug}" yaradıldı — şifrəni admin paneldən dəyişin` }))
    .catch((e) => log({ level: 'error', category: 'system', action: 'company.bootstrap_failed', message: String(e) }));
}
