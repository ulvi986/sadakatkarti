// Hesabatım inteqrasiyası. Brauzer Hesabatım-a heç vaxt birbaşa getmir: bütün sorğular bu serverdən proxy olunur
// (X-Proxy-Secret ilə), Hesabatım isə dəyişiklikləri imzalı webhook ilə geri göndərir.
import crypto from 'node:crypto';
import { config } from './config.js';
import { safeEqual } from './auth.js';

const TIMEOUT_MS = 8000;

/** Hesabatım-ın cavabındakı xəta — status və mesaj müştəriyə olduğu kimi ötürülür */
export class HesabatimError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface HesabatimCard {
  token: string;
  name: string;
  stamps: number;
  stamps_needed: number;
  reward_ready: boolean;
  rewards: number;
  total_stamps?: number;
}

export interface HesabatimBusiness {
  name: string;
  stamps_needed: number;
  reward: string;
  loyalty_enabled: boolean;
  logo?: string | null;
  theme?: Record<string, unknown> | null;
}

async function call<T>(path: string, clientIp: string | null, body?: unknown): Promise<T> {
  if (!config.hesabatimApiUrl) throw new HesabatimError('Hesabatım inteqrasiyası qurulmayıb', 503);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Bütün müştərilər bu serverin IP-si ilə getməsin deyə Hesabatım limitləri müştərinin IP-sinə tətbiq edir
  if (config.hesabatimProxySecret) {
    headers['X-Proxy-Secret'] = config.hesabatimProxySecret;
    if (clientIp) headers['X-Forwarded-For'] = clientIp;
  }
  let res: Response;
  try {
    res = await fetch(`${config.hesabatimApiUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HesabatimError('Kart sistemi hazırda əlçatan deyil, bir az sonra yenidən cəhd edin', 503);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: { message?: string } }).error?.message || 'Xəta baş verdi';
    throw new HesabatimError(message, res.status >= 500 ? 502 : res.status);
  }
  return data as T;
}

export interface HesabatimLogin {
  user: {
    email: string;
    full_name: string | null;
    memberships: {
      role: string;
      business: {
        slug: string; name: string; loyalty_stamps_needed: number; loyalty_reward: string;
        logo?: string | null; theme?: Record<string, unknown> | null;
      };
    }[];
  };
}

const biz = (slug: string) => `/public/businesses/${encodeURIComponent(slug)}`;

export const hesabatim = {
  business: (slug: string) => call<HesabatimBusiness>(biz(slug), null),
  signup: (slug: string, name: string, phone: string, ip: string) =>
    call<HesabatimCard>(`${biz(slug)}/cards`, ip, { name, phone }),
  /** Şirkət paneli girişi: email/şifrə Hesabatım-da yoxlanır. Hesabatım-ın sessiya tokenini saxlamırıq —
   *  yalnız hansı bizneslərə üzv olduğunu götürürük. Şifrə heç yerdə yazılmır və loglanmır. */
  login: async (email: string, password: string, ip: string) => {
    const r = await call<HesabatimLogin & { access_token?: string }>('/auth/login', ip, { email, password });
    return { user: r.user };
  },
  card: (token: string, ip: string | null) => call<HesabatimCard>(`/public/cards/${encodeURIComponent(token)}`, ip),
  /** Admin paneldəki inteqrasiya statusu üçün */
  async ping(): Promise<{ reachable: boolean; latencyMs: number | null }> {
    if (!config.hesabatimApiUrl) return { reachable: false, latencyMs: null };
    const t = Date.now();
    try {
      const base = config.hesabatimApiUrl.replace(/\/api\/v\d+$/, '');
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
      return { reachable: res.ok, latencyMs: Date.now() - t };
    } catch {
      return { reachable: false, latencyMs: null };
    }
  },
};

// ---------- webhook (Hesabatım → SadakatKarti) ----------
export interface HesabatimWebhook {
  id: string;
  event: 'loyalty.stamp' | 'loyalty.redeem' | 'loyalty.adjust' | 'loyalty.new_card' | 'customer.created' | 'business.created' | 'business.updated';
  business_slug: string;
  card_token?: string;
  old_token?: string;
  name?: string;
  stamps?: number;
  stamps_needed?: number;
  rewards?: number;
  total_stamps?: number;
  reward?: string;
  loyalty_enabled?: boolean;
  logo?: string | null;
  theme?: Record<string, unknown> | null;
  at?: string;
}

/** X-Sadakat-Signature: sha256=HMAC(secret, `${timestamp}.${body}`), 5 dəqiqədən köhnə imza rədd edilir */
export function verifyWebhook(raw: string, timestamp: string | undefined, signature: string | undefined): string | null {
  if (!config.hesabatimWebhookSecret) return 'Webhook açarı qurulmayıb';
  if (!timestamp || !signature) return 'İmza yoxdur';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return 'Vaxt möhürü köhnədir';
  const expected = 'sha256=' + crypto.createHmac('sha256', config.hesabatimWebhookSecret)
    .update(`${timestamp}.${raw}`).digest('hex');
  return safeEqual(signature, expected) ? null : 'İmza yanlışdır';
}
