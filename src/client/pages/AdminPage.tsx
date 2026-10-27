// Ümumi admin panel: bütün şirkətlər, kartlar, loglar (canlı), sistem və inteqrasiya vəziyyəti.
// Server bu səhifəni də, API-ni də yalnız ADMIN_ALLOWED_IPS-dəki IP-lərə açır.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AdminOverview, CardListItem, CompanyAdminView, CompanyInput, LogEntry, StaffCard, SystemInfo, LiveMessage,
} from '../../shared/types';
import { adminApi, ApiError, type LogFilter } from '../api';
import { useLive } from '../live';
import { fmtDate } from '../utils';
import { BarChart, CardSummary, CardTable, dayLabel, LiveBadge, LogTable, Stat } from '../components/Dashboard';

type Tab = 'home' | 'companies' | 'cards' | 'logs' | 'system';

export default function AdminPage() {
  const [ip, setIp] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const refresh = useCallback(() => adminApi.me().then((m) => setIp(m.ip)), []);
  useEffect(() => { document.title = 'Admin · Sadiqlik kartı'; }, []);
  useEffect(() => { refresh().catch(() => setIp(null)).finally(() => setChecking(false)); }, [refresh]);

  if (checking) return <div className="wrap"><div className="panel muted center">Yüklənir…</div></div>;
  if (!ip) return <Login onLogin={() => refresh().catch(() => {})} />;
  return <Admin ip={ip} onLogout={() => { adminApi.logout().finally(() => setIp(null)); }} />;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await adminApi.login(username, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Xəta');
    }
  };
  return (
    <div className="wrap">
      <div className="brand"><div className="logo">🛡️</div><h1>Ümumi admin</h1><div className="muted">Yalnız icazəli IP</div></div>
      <div className="panel">
        <form onSubmit={submit}>
          <label htmlFor="u">İstifadəçi adı</label>
          <input id="u" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
          <label htmlFor="p">Şifrə</label>
          <input id="p" type="password" autoComplete="current-password" required value={password}
                 onChange={(e) => { setPassword(e.target.value); setError(null); }} />
          <button type="submit">Daxil ol</button>
        </form>
        {error && <div className="banner err">{error}</div>}
      </div>
    </div>
  );
}

function Admin({ ip, onLogout }: { ip: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  const [companies, setCompanies] = useState<CompanyAdminView[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [scope, setScope] = useState<number | null>(null);
  const [feed, setFeed] = useState<Extract<LiveMessage, { type: 'activity' }>[]>([]);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [card, setCard] = useState<StaffCard | null>(null);

  const on401 = useCallback((e: unknown) => { if (e instanceof ApiError && (e.status === 401 || e.status === 404)) onLogout(); }, [onLogout]);
  const loadCompanies = useCallback(() => { adminApi.companies().then(setCompanies).catch(on401); }, [on401]);
  const loadOverview = useCallback(() => { adminApi.overview(scope).then(setOverview).catch(on401); }, [scope, on401]);
  useEffect(loadCompanies, [loadCompanies]);
  useEffect(loadOverview, [loadOverview]);
  // Trafik qrafiki sorğu loglarından qurulur — dəqiqədə bir təzələ
  useEffect(() => { const t = window.setInterval(loadOverview, 60_000); return () => window.clearInterval(t); }, [loadOverview]);

  const live = useLive({ channel: 'admin' }, (msg) => {
    if (msg.type === 'activity') {
      setFeed((f) => [msg, ...f].slice(0, 50));
      loadOverview();
    } else if (msg.type === 'log') {
      setLiveLogs((l) => [msg.log, ...l].slice(0, 500));
    }
  });

  const companyName = useCallback((id: number | null) => companies.find((c) => c.id === id)?.name ?? null, [companies]);
  const openCard = useCallback((token: string) => { adminApi.card(token).then(setCard).catch(on401); }, [on401]);
  const s = overview?.stats;

  return (
    <div className="wide">
      <header className="topbar">
        <div>
          <h1>Ümumi admin panel</h1>
          <div className="muted">IP: {ip} · <LiveBadge state={live} /></div>
        </div>
        <button className="secondary" onClick={onLogout}>Çıxış</button>
      </header>
      <nav className="tabs">
        {([['home', 'Dashboard'], ['companies', 'Şirkətlər'], ['cards', 'Kartlar'], ['logs', 'Loglar'], ['system', 'Sistem']] as const)
          .map(([t, label]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>)}
      </nav>

      {tab === 'home' && (
        <>
          <div className="filters">
            <select value={scope ?? ''} onChange={(e) => setScope(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Bütün şirkətlər</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="stats wide-stats">
            <Stat value={s?.stampsToday} label="Bu gün möhür" />
            <Stat value={s?.newCardsToday} label="Bu gün yeni kart" />
            <Stat value={s?.rewardsToday} label="Bu gün hədiyyə" />
            <Stat value={s?.cards} label="Cəmi kart" />
            <Stat value={overview && `${overview.activeCompanies}/${overview.companies}`} label="Aktiv şirkət" />
            <Stat value={overview?.requests24h} label="Sorğu (24 saat)" />
            <Stat value={overview?.avgMs24h !== undefined ? `${overview.avgMs24h} ms` : undefined} label="Orta cavab" />
            <Stat value={overview?.errors24h} label="Xəta (24 saat)" tone={overview?.errors24h ? 'err' : undefined} />
            <Stat value={overview?.securityEvents24h} label="Təhlükəsizlik xəbərdarlığı" tone={overview?.securityEvents24h ? 'warn' : undefined} />
          </div>
          {overview && (
            <div className="grid2">
              <div className="panel"><BarChart title="Möhürlər, son 14 gün" unit="möhür"
                data={overview.stats.days.map((d) => ({ label: dayLabel(d.day), value: d.stamps }))} /></div>
              <div className="panel"><BarChart title="Yeni kartlar, son 14 gün" unit="kart"
                data={overview.stats.days.map((d) => ({ label: dayLabel(d.day), value: d.signups }))} /></div>
              <div className="panel"><BarChart title="API sorğuları, son 24 saat" unit="sorğu"
                data={overview.traffic.map((t) => ({ label: t.hour, value: t.requests }))} /></div>
              <div className="panel"><BarChart title="Xətalar, son 24 saat" unit="xəta"
                data={overview.traffic.map((t) => ({ label: t.hour, value: t.errors }))} /></div>
            </div>
          )}
          <div className="grid2">
            <div className="panel">
              <h2>Canlı fəaliyyət</h2>
              {feed.length === 0 && <div className="muted">Bütün şirkətlərdəki möhür, hədiyyə və yeni kartlar burada dərhal görünür.</div>}
              <ul className="feed">
                {feed.map((a, i) => (
                  <li key={i} onClick={() => { openCard(a.card.token); setTab('cards'); }}>
                    <b>{a.card.companyName}</b> · {a.card.name} — {a.kind === 'signup' ? 'kart açdı' : a.kind === 'redeem' ? '🎁 hədiyyə'
                      : a.kind === 'stamp' ? `+${a.amount} (${a.card.stamps}/${a.card.stampsNeeded})` : 'düzəliş'}
                    <span className="muted"> · {a.actor} · {fmtDate(a.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="panel">
              <h2>Son loglar</h2>
              <LogTable logs={liveLogs.slice(0, 15)} companyName={companyName} />
            </div>
          </div>
        </>
      )}
      {tab === 'companies' && <Companies companies={companies} reload={loadCompanies} />}
      {tab === 'cards' && <Cards companies={companies} card={card} setCard={setCard} openCard={openCard} />}
      {tab === 'logs' && <Logs companies={companies} companyName={companyName} liveLogs={liveLogs} />}
      {tab === 'system' && <System />}
    </div>
  );
}

const EMPTY: CompanyInput = { slug: '', name: '', stampsNeeded: 9, reward: 'Pulsuz kofe', hesabatimSlug: '', username: '', password: '' };

function Companies({ companies, reload }: { companies: CompanyAdminView[]; reload: () => void }) {
  const [form, setForm] = useState<CompanyInput>(EMPTY);
  const [editing, setEditing] = useState<CompanyAdminView | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const body: CompanyInput = { ...form, hesabatimSlug: form.hesabatimSlug || null };
    try {
      if (editing) {
        if (!body.password) delete body.password;
        await adminApi.updateCompany(editing.id, body);
        setMsg({ text: 'Yeniləndi', kind: 'ok' });
      } else {
        await adminApi.createCompany(body);
        setMsg({ text: 'Şirkət yaradıldı', kind: 'ok' });
      }
      setForm(EMPTY);
      setEditing(null);
      reload();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Xəta', kind: 'err' });
    }
  };

  const edit = (c: CompanyAdminView) => {
    setEditing(c);
    setForm({ slug: c.slug, name: c.name, stampsNeeded: c.stampsNeeded, reward: c.reward, hesabatimSlug: c.hesabatimSlug ?? '', username: c.username, password: '' });
  };
  const toggle = async (c: CompanyAdminView) => {
    await adminApi.updateCompany(c.id, { active: !c.active }).catch(() => {});
    reload();
  };
  const set = (k: keyof CompanyInput) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: k === 'stampsNeeded' ? Number(e.target.value) : e.target.value });

  return (
    <>
      <div className="panel">
        <h2>Şirkətlər</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Şirkət</th><th>Login</th><th>Qayda</th><th>Hesabatım</th><th>Kart</th><th>Möhür (bu gün / 30 gün)</th><th>Status</th><th /></tr></thead>
            <tbody>
              {companies.length === 0 && <tr><td colSpan={8} className="muted center">Hələ şirkət yoxdur — aşağıdan yaradın</td></tr>}
              {companies.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b><div className="muted">/k/{c.slug}</div></td>
                  <td>{c.username}</td>
                  <td>{c.stampsNeeded} → {c.reward}</td>
                  <td>{c.hesabatimSlug ?? '—'}{c.syncedAt && <div className="muted">{fmtDate(c.syncedAt)}</div>}</td>
                  <td>{c.cards}</td>
                  <td>{c.stampsToday} / {c.stamps30d}</td>
                  <td><span className={`pill ${c.active ? 'ok' : 'off'}`}>{c.active ? 'Aktiv' : 'Bağlı'}</span></td>
                  <td className="nowrap">
                    <button className="mini secondary" onClick={() => edit(c)}>Düzəlt</button>
                    <button className="mini secondary" onClick={() => toggle(c)}>{c.active ? 'Bağla' : 'Aç'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h2>{editing ? `Düzəliş: ${editing.name}` : 'Yeni şirkət'}</h2>
        <form onSubmit={submit} className="form-grid">
          <div><label>Ad</label><input required value={form.name} onChange={set('name')} /></div>
          <div><label>Slug (link: /k/slug)</label><input required pattern="[a-z0-9-]{2,60}" value={form.slug} onChange={set('slug')} /></div>
          <div><label>Hesabatım biznes slug-u (boş = müstəqil)</label><input value={form.hesabatimSlug ?? ''} onChange={set('hesabatimSlug')} /></div>
          <div><label>Möhür sayı</label><input type="number" min={2} max={30} value={form.stampsNeeded} onChange={set('stampsNeeded')} /></div>
          <div><label>Hədiyyə</label><input value={form.reward} onChange={set('reward')} /></div>
          <div><label>Panel istifadəçi adı</label><input required value={form.username} onChange={set('username')} /></div>
          <div><label>{editing ? 'Yeni şifrə (boş = dəyişmə)' : 'Panel şifrəsi (ən azı 8)'}</label>
            <input type="password" autoComplete="new-password" required={!editing} minLength={8} value={form.password} onChange={set('password')} /></div>
          <div className="row">
            <button type="submit">{editing ? 'Yadda saxla' : 'Yarat'}</button>
            {editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setForm(EMPTY); }}>Ləğv et</button>}
          </div>
        </form>
        <div className="muted">Hesabatım-a bağlı şirkətdə ad, möhür sayı və hədiyyə Hesabatım-dan gəlir; kartlar Hesabatım-ın müştərilər bölməsində də görünür.</div>
        {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}
      </div>
    </>
  );
}

function Cards({ companies, card, setCard, openCard }: {
  companies: CompanyAdminView[];
  card: StaffCard | null;
  setCard: (c: StaffCard | null) => void;
  openCard: (token: string) => void;
}) {
  const [q, setQ] = useState('');
  const [company, setCompany] = useState<number | null>(null);
  const [rows, setRows] = useState<CardListItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => adminApi.cards(q.trim(), company).then((r) => { if (!cancelled) setRows(r); }).catch(() => {}), 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q, company]);
  return (
    <div className="grid2 wide-left">
      <div className="panel">
        <h2>Bütün kartlar</h2>
        <div className="filters">
          <input placeholder="Ad və ya telefon" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={company ?? ''} onChange={(e) => setCompany(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Bütün şirkətlər</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {rows && <CardTable cards={rows} onPick={openCard} showCompany />}
      </div>
      {card && (
        <div className="panel">
          <CardSummary card={card}>
            <div className="muted" style={{ marginTop: 10 }}>
              Yaradılıb: {fmtDate(card.createdAt)} · Son sinxron: {fmtDate(card.syncedAt)}
            </div>
            <button className="secondary" onClick={() => setCard(null)}>Bağla</button>
          </CardSummary>
        </div>
      )}
    </div>
  );
}

function Logs({ companies, companyName, liveLogs }: {
  companies: CompanyAdminView[];
  companyName: (id: number | null) => string | null;
  liveLogs: LogEntry[];
}) {
  const [filter, setFilter] = useState<LogFilter>({});
  const [rows, setRows] = useState<LogEntry[]>([]);
  const [tail, setTail] = useState(true);
  const [baseline, setBaseline] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => adminApi.logs(filter).then((r) => {
      if (cancelled) return;
      setRows(r);
      setBaseline(r[0]?.id ?? 0);
    }).catch(() => {}), 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [filter]);

  // Canlı rejimdə SSE-dən gələn yeni loglar filtrə uyğun gəlirsə yuxarı əlavə olunur
  const matches = useCallback((l: LogEntry) => (!filter.category || l.category === filter.category)
    && (!filter.level || l.level === filter.level) && (!filter.company || l.companyId === filter.company)
    && (!filter.q || JSON.stringify(l).toLowerCase().includes(filter.q.toLowerCase())), [filter]);
  const shown = useMemo(() => {
    if (!tail) return rows;
    const fresh = liveLogs.filter((l) => l.id > baseline && matches(l));
    return [...fresh, ...rows];
  }, [tail, rows, liveLogs, baseline, matches]);

  const exportCsv = () => {
    const head = 'id,at,level,category,company,actor,ip,action,status,duration_ms,message';
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = shown.map((l) => [l.id, l.at, l.level, l.category, companyName(l.companyId), l.actor, l.ip, l.action, l.status, l.durationMs, l.message].map(esc).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `logs-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel">
      <h2>Loglar</h2>
      <div className="filters">
        <select value={filter.category ?? ''} onChange={(e) => setFilter({ ...filter, category: e.target.value || undefined })}>
          <option value="">Bütün növlər</option>
          <option value="request">Sorğular</option>
          <option value="audit">Əməliyyatlar</option>
          <option value="security">Təhlükəsizlik</option>
          <option value="integration">İnteqrasiya</option>
          <option value="system">Sistem</option>
        </select>
        <select value={filter.level ?? ''} onChange={(e) => setFilter({ ...filter, level: e.target.value || undefined })}>
          <option value="">Bütün səviyyələr</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <select value={filter.company ?? ''} onChange={(e) => setFilter({ ...filter, company: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Bütün şirkətlər</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input placeholder="Axtar: IP, hadisə, mətn…" value={filter.q ?? ''} onChange={(e) => setFilter({ ...filter, q: e.target.value || undefined })} />
        <label className="check"><input type="checkbox" checked={tail} onChange={(e) => setTail(e.target.checked)} /> Canlı</label>
        <button className="mini secondary" onClick={exportCsv}>CSV</button>
      </div>
      <LogTable logs={shown} companyName={companyName}
                onMore={() => adminApi.logs({ ...filter, before: rows[rows.length - 1]?.id }).then((r) => setRows((x) => [...x, ...r]))} />
    </div>
  );
}

function System() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    const load = () => adminApi.system().then(setInfo).catch(() => {});
    load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, []);
  if (!info) return <div className="panel muted">Yüklənir…</div>;
  const h = info.hesabatim;
  const up = `${Math.floor(info.uptimeSec / 3600)} saat ${Math.floor((info.uptimeSec % 3600) / 60)} dəq`;
  return (
    <div className="grid2">
      <div className="panel">
        <h2>Server</h2>
        <dl className="kv">
          <dt>İşləmə müddəti</dt><dd>{up}</dd>
          <dt>Yaddaş</dt><dd>{info.memoryMb} MB</dd>
          <dt>Node</dt><dd>{info.node}</dd>
          <dt>Baza</dt><dd>{info.database === 'postgres' ? 'Postgres' : 'PGlite (lokal)'}</dd>
          <dt>Canlı (SSE) bağlantılar</dt><dd>{info.liveConnections}</dd>
          <dt>Log saxlanma</dt><dd>{info.logRetentionDays} gün</dd>
          <dt>İcazəli admin IP-lər</dt><dd>{info.admin.allowedIps.join(', ')}</dd>
          <dt>Sizin IP</dt><dd>{info.admin.yourIp}</dd>
        </dl>
      </div>
      <div className="panel">
        <h2>Hesabatım inteqrasiyası</h2>
        <dl className="kv">
          <dt>Qoşulub</dt><dd>{h.configured ? 'Bəli' : 'Xeyr'}</dd>
          <dt>API</dt><dd>{h.apiUrl ?? '—'}</dd>
          <dt>Əlçatanlıq</dt>
          <dd>{h.reachable === null ? '—' : h.reachable ? <span className="pill ok">✓ işləyir · {h.latencyMs} ms</span> : <span className="pill off">✗ əlçatan deyil</span>}</dd>
          <dt>Webhook</dt><dd>{h.webhookConfigured ? 'Qurulub' : 'Qurulmayıb (yalnız fon sinxronizasiyası)'}</dd>
          <dt>Son webhook</dt><dd>{fmtDate(h.lastWebhookAt)}</dd>
          <dt>Son fon sinxronizasiyası</dt><dd>{fmtDate(h.lastSyncAt)} (hər {h.syncIntervalSec} san.)</dd>
        </dl>
      </div>
    </div>
  );
}
