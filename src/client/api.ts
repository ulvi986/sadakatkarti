import type {
  AdminOverview, ApiErrorBody, CardListItem, CompanyAdminView, CompanyInput, LogEntry, MeCompany, PublicCard,
  PublicCompany, SignupBody, StaffCard, StampBody, Stats, SystemInfo,
} from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: ApiErrorBody) {
    super(message);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Serverə qoşulmaq olmadı', 0, { error: 'Serverə qoşulmaq olmadı' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as ApiErrorBody;
    throw new ApiError(body.error || 'Xəta baş verdi', res.status, body);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  defaultCompany: () => request<PublicCompany>('/api/config'),
  company: (slug: string) => request<PublicCompany>(`/api/companies/${encodeURIComponent(slug)}`),
  signup: (slug: string, body: SignupBody) =>
    request<PublicCard>(`/api/companies/${encodeURIComponent(slug)}/cards`, { method: 'POST', body }),
  card: (token: string) => request<PublicCard>(`/api/cards/${encodeURIComponent(token)}`),
  findCard: (slug: string, phone: string) =>
    request<PublicCard>(`/api/companies/${encodeURIComponent(slug)}/cards/find`, { method: 'POST', body: { phone } }),
};

const card = (base: string, token: string) => `${base}/cards/${encodeURIComponent(token)}`;

export const panelApi = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/panel/login', { method: 'POST', body: { username, password } }),
  loginHesabatim: (email: string, password: string) =>
    request<{ ok: true }>('/api/panel/login-hesabatim', { method: 'POST', body: { email, password } }),
  switchCompany: (companyId: number) => request<{ ok: true }>('/api/panel/switch', { method: 'POST', body: { companyId } }),
  logout: () => request<{ ok: true }>('/api/panel/logout', { method: 'POST' }),
  me: () => request<MeCompany>('/api/panel/me'),
  stats: () => request<Stats>('/api/panel/stats'),
  cards: (q: string) => request<CardListItem[]>(`/api/panel/cards${qs({ q })}`),
  card: (token: string) => request<StaffCard>(card('/api/panel', token)),
  stamp: (token: string, body: StampBody) => request<StaffCard>(`${card('/api/panel', token)}/stamp`, { method: 'POST', body }),
  redeem: (token: string) => request<StaffCard>(`${card('/api/panel', token)}/redeem`, { method: 'POST' }),
  logs: (before?: number) => request<LogEntry[]>(`/api/panel/logs${qs({ before })}`),
  settings: (body: CompanyInput) => request<CompanyAdminView>('/api/panel/settings', { method: 'PATCH', body }),
  password: (current: string, next: string) =>
    request<{ ok: true }>('/api/panel/password', { method: 'POST', body: { current, next } }),
};

export interface LogFilter { category?: string; level?: string; company?: number | null; q?: string; before?: number }

export const adminApi = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/admin/login', { method: 'POST', body: { username, password } }),
  logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  me: () => request<{ role: 'admin'; ip: string }>('/api/admin/me'),
  overview: (company?: number | null) => request<AdminOverview>(`/api/admin/overview${qs({ company })}`),
  system: () => request<SystemInfo>('/api/admin/system'),
  companies: () => request<CompanyAdminView[]>('/api/admin/companies'),
  createCompany: (body: CompanyInput) => request<CompanyAdminView>('/api/admin/companies', { method: 'POST', body }),
  updateCompany: (id: number, body: CompanyInput) =>
    request<CompanyAdminView>(`/api/admin/companies/${id}`, { method: 'PATCH', body }),
  cards: (q: string, company?: number | null) => request<CardListItem[]>(`/api/admin/cards${qs({ q, company })}`),
  card: (token: string) => request<StaffCard>(card('/api/admin', token)),
  logs: (f: LogFilter) => request<LogEntry[]>(`/api/admin/logs${qs({ ...f })}`),
};
