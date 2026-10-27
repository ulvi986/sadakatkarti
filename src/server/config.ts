// Bütün mühit dəyişənləri bir yerdə
import crypto from 'node:crypto';

const env = process.env;
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT || 3000),
  production: env.NODE_ENV === 'production',
  /** Postgres (Railway). Boşdursa lokal PGlite faylı işləyir — eyni SQL */
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
  pgliteDir: env.PGLITE_DIR || 'data/pglite',
  timezone: env.TIMEZONE || 'Asia/Baku',

  /** "/" ünvanı hansı şirkətin qeydiyyat səhifəsini açsın (slug). Boşdursa yeganə aktiv şirkət */
  defaultCompany: env.DEFAULT_COMPANY || '',
  cooldownSec: Number(env.COOLDOWN_SEC || 30),

  // --- Ümumi admin panel ---
  adminUsername: env.ADMIN_USERNAME || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  /** Yalnız bu IP-lərdən /admin açılır (vergüllə). Boşdursa admin panel tam bağlıdır */
  adminAllowedIps: list(env.ADMIN_ALLOWED_IPS),
  sessionSecret: env.SESSION_SECRET || '',
  adminSessionMinutes: Number(env.ADMIN_SESSION_MINUTES || 120),
  companySessionHours: Number(env.COMPANY_SESSION_HOURS || 12),

  // --- Proxy arxasında müştəri IP-si ---
  /** Railway kənar proxy-si X-Real-IP yazır. Cloudflare qoyulsa: CLIENT_IP_HEADER=cf-connecting-ip */
  trustProxy: env.TRUST_PROXY === '1' || Boolean(env.RAILWAY_ENVIRONMENT),
  clientIpHeader: (env.CLIENT_IP_HEADER || 'x-real-ip').toLowerCase(),
  /** Canlı axın və POST sorğuları yalnız bu mənbələrdən (boşdursa Host ilə eyni olan mənbə) */
  allowedOrigins: list(env.ALLOWED_ORIGINS),

  // --- Hesabatım inteqrasiyası ---
  hesabatimApiUrl: (env.HESABATIM_API_URL || '').replace(/\/+$/, ''),
  hesabatimProxySecret: env.HESABATIM_PROXY_SECRET || '',
  hesabatimWebhookSecret: env.HESABATIM_WEBHOOK_SECRET || '',
  /** Köhnə tək-şirkət rejimi: bu slug verilibsə, ilk açılışda Hesabatım-a bağlı şirkət yaradılır */
  legacyHesabatimBusiness: env.HESABATIM_BUSINESS || '',
  /** Webhook gəlməsə belə son 24 saatda aktiv kartları bu intervalla Hesabatım-dan yenilə (saniyə, 0 = söndür) */
  syncIntervalSec: Number(env.SYNC_INTERVAL_SEC ?? 15),

  logRetentionDays: Number(env.LOG_RETENTION_DAYS || 30),
};

if (!config.sessionSecret) {
  // Hər restartda sessiyalar sıfırlanır — productionda SESSION_SECRET mütləq verilməlidir
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET verilməyib — müvəqqəti açar yaradıldı (restartda hamı çıxış edəcək)');
}

export const hesabatimConfigured = Boolean(config.hesabatimApiUrl);
export const adminEnabled = Boolean(config.adminUsername && config.adminPassword && config.adminAllowedIps.length);
