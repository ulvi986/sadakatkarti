// Server və client arasında ortaq tiplər

/** Hesabatım-dakı biznes rəngləri (#rrggbb) */
export interface BrandTheme {
  primary?: string;
  accent?: string;
  card?: string;
}

export interface PublicCompany {
  slug: string;
  name: string;
  stampsNeeded: number;
  reward: string;
  /** Loqo ayrıca, keşlənən ünvanda (versiya loqonun heşidir) */
  logoUrl: string | null;
  theme: BrandTheme;
  /** Kartlar Hesabatım-da yaranır və möhür orada vurulur */
  linked: boolean;
}

export interface PublicCard {
  token: string;
  name: string;
  stamps: number;
  stampsNeeded: number;
  rewardReady: boolean;
  rewards: number;
  /** Hesabatım kartı yenisi ilə əvəz edibsə false */
  active: boolean;
  company: PublicCompany;
}

export interface CardEvent {
  type: 'stamp' | 'redeem' | 'adjust' | 'sync';
  amount: number;
  actor: string;
  at: string;
}

export interface StaffCard extends PublicCard {
  phone: string;
  totalStamps: number;
  createdAt: string;
  lastStampAt: string | null;
  source: 'local' | 'hesabatim';
  syncedAt: string | null;
  history: CardEvent[];
}

export interface CardListItem {
  token: string;
  name: string;
  phone: string;
  stamps: number;
  stampsNeeded: number;
  rewards: number;
  totalStamps: number;
  source: 'local' | 'hesabatim';
  lastStampAt: string | null;
  createdAt: string;
  companySlug: string;
  companyName: string;
}

export interface DayPoint {
  day: string; // YYYY-MM-DD (biznesin saat qurşağında)
  signups: number;
  stamps: number;
  redeems: number;
}

export interface Stats {
  cards: number;
  newCardsToday: number;
  stampsToday: number;
  rewardsToday: number;
  rewardsTotal: number;
  rewardReady: number;
  days: DayPoint[];
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory = 'request' | 'audit' | 'security' | 'integration' | 'system';

export interface LogEntry {
  id: number;
  at: string;
  level: LogLevel;
  category: LogCategory;
  companyId: number | null;
  actor: string | null;
  ip: string | null;
  action: string;
  message: string | null;
  status: number | null;
  durationMs: number | null;
  meta: Record<string, unknown> | null;
}

export interface CompanyAdminView {
  id: number;
  slug: string;
  name: string;
  stampsNeeded: number;
  reward: string;
  hesabatimSlug: string | null;
  username: string;
  active: boolean;
  createdAt: string;
  syncedAt: string | null;
  cards: number;
  stampsToday: number;
  stamps30d: number;
}

export interface AdminOverview {
  stats: Stats;
  companies: number;
  activeCompanies: number;
  requests24h: number;
  errors24h: number;
  securityEvents24h: number;
  avgMs24h: number;
  /** son 24 saat, saatlıq */
  traffic: { hour: string; requests: number; errors: number }[];
}

export interface SystemInfo {
  uptimeSec: number;
  memoryMb: number;
  node: string;
  database: 'postgres' | 'pglite';
  liveConnections: number;
  hesabatim: {
    configured: boolean;
    apiUrl: string | null;
    reachable: boolean | null;
    latencyMs: number | null;
    webhookConfigured: boolean;
    lastWebhookAt: string | null;
    lastSyncAt: string | null;
    syncIntervalSec: number;
  };
  admin: { allowedIps: string[]; yourIp: string };
  logRetentionDays: number;
}

export interface MeCompany {
  role: 'company';
  company: CompanyAdminView;
  login: { via: 'local' | 'hesabatim'; email: string | null; role: string | null };
  /** Hesabatım hesabı bir neçə biznesə üzvdürsə, aralarında keçid */
  companies: { id: number; slug: string; name: string }[];
}

export interface ApiErrorBody {
  error: string;
  cooldown?: boolean;
  card?: StaffCard;
}

export interface SignupBody { name: string; phone: string }
export interface StampBody { count?: number; force?: boolean }
export interface LoginBody { username: string; password: string }

export interface CompanyInput {
  slug?: string;
  name?: string;
  stampsNeeded?: number;
  reward?: string;
  hesabatimSlug?: string | null;
  username?: string;
  password?: string;
  active?: boolean;
}

// --- Canlı yeniləmələr (SSE, GET /api/live?channel=...) ---
export type LiveSub =
  | { channel: 'card'; token: string }
  | { channel: 'company' }
  | { channel: 'admin' };

export type LiveMessage =
  | { type: 'subscribed'; channel: string }
  | { type: 'card'; card: PublicCard }
  | { type: 'company'; company: PublicCompany }
  | { type: 'activity'; companyId: number; companySlug: string; kind: CardEvent['type'] | 'signup'; card: CardListItem; amount: number; actor: string; at: string }
  | { type: 'log'; log: LogEntry };
