// Şirkət paneli: kassada QR oxut + möhür, öz kartları, statistika, öz logları — hamısı canlı
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { CardListItem, CompanyAdminView, LogEntry, MeCompany, StaffCard, Stats, LiveMessage } from '../../shared/types';
import { ApiError, panelApi } from '../api';
import { useLive } from '../live';
import { feedback, fmtDate, tokenFromQr } from '../utils';
import QrScanner from '../components/QrScanner';
import { BarChart, CardSummary, CardTable, dayLabel, LiveBadge, LogTable, Stat } from '../components/Dashboard';

type Tab = 'home' | 'scan' | 'cards' | 'logs' | 'settings';
type Msg = { text: string; kind: 'ok' | 'err' | 'reward' } | null;

export default function PanelPage() {
  const [me, setMe] = useState<MeCompany | null>(null);
  const [checking, setChecking] = useState(true);

  const refreshMe = useCallback(() => panelApi.me().then(setMe), []);
  useEffect(() => { refreshMe().catch(() => setMe(null)).finally(() => setChecking(false)); }, [refreshMe]);
  useEffect(() => { document.title = me ? `${me.company.name} · Panel` : 'Şirkət paneli'; }, [me]);

  if (checking) return <div className="wrap"><div className="panel muted center">Yüklənir…</div></div>;
  if (!me) return <Login onLogin={() => refreshMe().catch(() => {})} />;
  // key: şirkət dəyişəndə bütün panel vəziyyəti (statistika, axın, canlı kanal) sıfırdan qurulur
  return <Dashboard key={me.company.id} me={me} company={me.company}
                    setCompany={(c) => setMe({ ...me, company: c })}
                    onSwitch={(id) => panelApi.switchCompany(id).then(refreshMe).catch(() => {})}
                    onLogout={() => { panelApi.logout().finally(() => setMe(null)); }} />;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'hesabatim' | 'local'>('hesabatim');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'hesabatim') await panelApi.loginHesabatim(username, password);
      else await panelApi.login(username, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Xəta');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: 'hesabatim' | 'local') => { setMode(m); setError(null); setUsername(''); setPassword(''); };

  return (
    <div className="wrap">
      <div className="brand"><div className="logo">★</div><h1>Şirkət paneli</h1><div className="muted">Sadiqlik kartı</div></div>
      <div className="panel">
        <nav className="tabs">
          <button type="button" className={mode === 'hesabatim' ? 'on' : ''} onClick={() => switchMode('hesabatim')}>Hesabatım hesabı</button>
          <button type="button" className={mode === 'local' ? 'on' : ''} onClick={() => switchMode('local')}>Panel girişi</button>
        </nav>
        <div className="muted">
          {mode === 'hesabatim'
            ? 'Hesabatım-a hansı email və şifrə ilə girirsinizsə, onunla daxil olun. Biznesiniz avtomatik açılacaq.'
            : 'Hesabatım-sız işləyən şirkətlər üçün admin tərəfindən verilmiş istifadəçi adı.'}
        </div>
        <form onSubmit={submit}>
          {mode === 'hesabatim' ? (
            <>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="email" required value={username} onChange={(e) => setUsername(e.target.value)} />
            </>
          ) : (
            <>
              <label htmlFor="u">İstifadəçi adı</label>
              <input id="u" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
            </>
          )}
          <label htmlFor="p">Şifrə</label>
          <input id="p" type="password" autoComplete="current-password" required value={password}
                 onChange={(e) => { setPassword(e.target.value); setError(null); }} />
          <button type="submit" disabled={busy}>{busy ? 'Yoxlanılır…' : 'Daxil ol'}</button>
        </form>
        {error && <div className="banner err">{error}</div>}
        <div className="muted secure-note">🔒 Bağlantı HTTPS (TLS) ilə şifrələnir. Hesabatım şifrəniz burada saxlanılmır.</div>
      </div>
    </div>
  );
}

function Dashboard({ me, company, setCompany, onSwitch, onLogout }: {
  me: MeCompany;
  company: CompanyAdminView;
  setCompany: (c: CompanyAdminView) => void;
  onSwitch: (companyId: number) => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>('home');
  const [stats, setStats] = useState<Stats | null>(null);
  const [feed, setFeed] = useState<Extract<LiveMessage, { type: 'activity' }>[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [current, setCurrent] = useState<StaffCard | null>(null);
  const linked = Boolean(company.hesabatimSlug);

  const on401 = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) onLogout(); }, [onLogout]);
  const loadStats = useCallback(() => { panelApi.stats().then(setStats).catch(on401); }, [on401]);
  useEffect(loadStats, [loadStats]);
  useEffect(() => { panelApi.logs().then(setLogs).catch(on401); }, [on401]);

  // Kassada möhür vurulan, Hesabatım-da dəyişən, yeni açılan hər kart dərhal buraya gəlir
  const live = useLive({ channel: 'company' }, (msg) => {
    if (msg.type === 'activity') {
      setFeed((f) => [msg, ...f].slice(0, 30));
      loadStats();
      setCurrent((c) => (c && c.token === msg.card.token ? { ...c, stamps: msg.card.stamps, rewards: msg.card.rewards,
        rewardReady: msg.card.stamps >= msg.card.stampsNeeded } : c));
    } else if (msg.type === 'log') {
      setLogs((l) => [msg.log, ...l].slice(0, 300));
    }
  });

  const openCard = useCallback(async (token: string) => {
    try {
      setCurrent(await panelApi.card(token));
      setTab('scan');
    } catch (e) {
      on401(e);
    }
  }, [on401]);

  return (
    <div className="wide">
      <header className="topbar">
        <div>
          <h1>{company.name}</h1>
          <div className="muted">{linked ? `Hesabatım ilə bağlıdır (${company.hesabatimSlug})` : 'Müstəqil sadiqlik kartı'} · <LiveBadge state={live} /></div>
          {me.login.email && <div className="muted">{me.login.email}{me.login.role ? ` · ${me.login.role}` : ''}</div>}
        </div>
        <div className="topbar-actions">
          {me.companies.length > 1 && (
            <select aria-label="Biznes" value={company.id} onChange={(e) => onSwitch(Number(e.target.value))}>
              {me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <button className="secondary" onClick={onLogout}>Çıxış</button>
        </div>
      </header>
      <nav className="tabs">
        {([['home', 'Ümumi'], ['scan', linked ? 'Kart' : 'Kassa'], ['cards', 'Müştərilər'], ['logs', 'Loglar'], ['settings', 'Ayarlar']] as const)
          .map(([t, label]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>)}
      </nav>

      {tab === 'home' && (
        <>
          <div className="stats wide-stats">
            <Stat value={stats?.stampsToday} label="Bu gün möhür" />
            <Stat value={stats?.newCardsToday} label="Bu gün yeni kart" />
            <Stat value={stats?.rewardsToday} label="Bu gün hədiyyə" />
            <Stat value={stats?.cards} label="Cəmi kart" />
            <Stat value={stats?.rewardReady} label="Hədiyyəsi hazır" />
            <Stat value={stats?.rewardsTotal} label="Cəmi hədiyyə" />
          </div>
          {stats && (
            <div className="grid2">
              <div className="panel"><BarChart title="Möhürlər, son 14 gün" unit="möhür"
                data={stats.days.map((d) => ({ label: dayLabel(d.day), value: d.stamps }))} /></div>
              <div className="panel"><BarChart title="Yeni kartlar, son 14 gün" unit="kart"
                data={stats.days.map((d) => ({ label: dayLabel(d.day), value: d.signups }))} /></div>
            </div>
          )}
          <div className="panel">
            <h2>Canlı axın</h2>
            {feed.length === 0 && <div className="muted">Panel açıq olduqca yeni möhürlər və kartlar burada dərhal görünəcək.</div>}
            <ul className="feed">
              {feed.map((a, i) => (
                <li key={i} onClick={() => openCard(a.card.token)}>
                  <b>{a.card.name}</b> — {a.kind === 'signup' ? 'kart açdı' : a.kind === 'redeem' ? '🎁 hədiyyə aldı'
                    : a.kind === 'stamp' ? `+${a.amount} möhür (${a.card.stamps}/${a.card.stampsNeeded})` : 'düzəliş'}
                  <span className="muted"> · {a.actor} · {fmtDate(a.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      {tab === 'scan' && <Register linked={linked} current={current} setCurrent={setCurrent} onChange={loadStats} on401={on401} />}
      {tab === 'cards' && <Customers onPick={openCard} />}
      {tab === 'logs' && (
        <div className="panel">
          <h2>Şirkət logları</h2>
          <div className="muted" style={{ marginBottom: 10 }}>Girişlər, möhürlər, hədiyyələr, ayar dəyişiklikləri, Hesabatım sinxronizasiyası.</div>
          <LogTable logs={logs} onMore={() => panelApi.logs(logs[logs.length - 1]?.id).then((l) => setLogs((x) => [...x, ...l]))} />
        </div>
      )}
      {tab === 'settings' && <Settings company={company} linked={linked} viaHesabatim={me.login.via === 'hesabatim'} onSaved={setCompany} />}
    </div>
  );
}

function Register({ linked, current, setCurrent, onChange, on401 }: {
  linked: boolean;
  current: StaffCard | null;
  setCurrent: (c: StaffCard | null) => void;
  onChange: () => void;
  on401: (e: unknown) => void;
}) {
  const [msg, setMsg] = useState<Msg>(null);
  const [cooldownCount, setCooldownCount] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastScan = useRef({ token: '', at: 0 });

  const fail = (e: unknown) => {
    on401(e);
    feedback(false);
    if (e instanceof ApiError && e.body.card) setCurrent(e.body.card);
    setMsg({ text: e instanceof Error ? e.message : 'Xəta', kind: 'err' });
  };

  const onScan = async (text: string) => {
    const token = tokenFromQr(text);
    if (!token) return;
    if (token === lastScan.current.token && Date.now() - lastScan.current.at < 4000) return;
    lastScan.current = { token, at: Date.now() };
    feedback(true);
    setScanning(false);
    setCooldownCount(null);
    try {
      const card = await panelApi.card(token);
      setCurrent(card);
      setMsg(card.rewardReady ? { text: '🎉 Bu müştərinin hədiyyəsi hazırdır!', kind: 'reward' } : null);
    } catch (e) {
      fail(e);
    }
  };

  const stamp = async (count: number, force = false) => {
    if (!current || busy) return;
    setBusy(true);
    setCooldownCount(null);
    try {
      const card = await panelApi.stamp(current.token, { count, force });
      setCurrent(card);
      feedback(true);
      setMsg(card.rewardReady
        ? { text: `✅ Möhür vuruldu — növbəti dəfə hədiyyə: ${card.company.reward}!`, kind: 'reward' }
        : { text: `✅ +${count} möhür. Hədiyyəyə ${card.stampsNeeded - card.stamps} qaldı.`, kind: 'ok' });
      onChange();
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.status === 429) setCooldownCount(count);
    } finally {
      setBusy(false);
    }
  };

  const redeem = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      setCurrent(await panelApi.redeem(current.token));
      feedback(true);
      setMsg({ text: '🎁 Hədiyyə verildi. Kart sıfırlandı.', kind: 'ok' });
      onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid2">
      <div className="panel">
        <h2>QR kodu skan et</h2>
        {linked && <div className="banner ok">Möhürlər Hesabatım-da vurulur (Müştərilər → Kartı oxut). Burada kartı yoxlaya bilərsiniz — dəyişiklik dərhal görünür.</div>}
        {scanning && <QrScanner onScan={onScan} onError={(text) => { setScanning(false); setMsg({ text, kind: 'err' }); }} />}
        {scanning
          ? <button className="secondary" onClick={() => setScanning(false)}>Dayandır</button>
          : <button onClick={() => { setMsg(null); setScanning(true); }}>📷 Kameranı aç</button>}
        {!current && msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}
      </div>
      {current && (
        <div className="panel">
          <CardSummary card={current}>
            {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}
            {!linked && (current.rewardReady ? (
              <button className="gold" onClick={redeem} disabled={busy}>🎁 Hədiyyəni ver ({current.company.reward})</button>
            ) : (
              <div className="row">
                <button onClick={() => stamp(1)} disabled={busy}>+1 möhür</button>
                <button className="secondary" onClick={() => stamp(2)}
                        disabled={busy || current.stampsNeeded - current.stamps < 2}>+2 möhür</button>
              </div>
            ))}
            {cooldownCount !== null && (
              <button className="secondary" onClick={() => stamp(cooldownCount, true)} disabled={busy}>Yenə də möhür vur</button>
            )}
          </CardSummary>
        </div>
      )}
    </div>
  );
}

function Customers({ onPick }: { onPick: (token: string) => void }) {
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<CardListItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      panelApi.cards(term.trim()).then((r) => { if (!cancelled) setRows(r); }).catch(() => {});
    }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [term]);
  return (
    <div className="panel">
      <h2>Müştərilər</h2>
      <input placeholder="Ad və ya telefon" value={term} onChange={(e) => setTerm(e.target.value)} />
      {rows && <CardTable cards={rows} onPick={onPick} />}
    </div>
  );
}

function Settings({ company, linked, viaHesabatim, onSaved }: {
  company: CompanyAdminView;
  linked: boolean;
  viaHesabatim: boolean;
  onSaved: (c: CompanyAdminView) => void;
}) {
  const [name, setName] = useState(company.name);
  const [stampsNeeded, setStampsNeeded] = useState(company.stampsNeeded);
  const [reward, setReward] = useState(company.reward);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState<Msg>(null);
  const link = `${window.location.origin}/k/${company.slug}`;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await panelApi.settings({ name, stampsNeeded, reward }));
      setMsg({ text: 'Yadda saxlanıldı', kind: 'ok' });
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Xəta', kind: 'err' });
    }
  };
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await panelApi.password(pw.current, pw.next);
      setPw({ current: '', next: '' });
      setMsg({ text: 'Şifrə dəyişdi', kind: 'ok' });
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Xəta', kind: 'err' });
    }
  };

  return (
    <div className="grid2">
      <div className="panel">
        <h2>Kart ayarları</h2>
        <div className="muted">Müştəri qeydiyyat linki (kassada QR plakat kimi asın):</div>
        <code className="copy">{link}</code>
        <div className="qr-box">
          <QRCodeSVG value={link} size={220} level="M" fgColor="#3b2a1e" bgColor="#ffffff" marginSize={2} />
          <div className="muted" style={{ marginTop: 8 }}>Bu QR kodu kassaya və masalara qoyun (ekran şəkli çəkib çap edə bilərsiniz)</div>
        </div>
        <form onSubmit={save}>
          <label>Ad</label>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={linked} />
          <label>Hədiyyə üçün möhür sayı</label>
          <input type="number" min={2} max={30} value={stampsNeeded} disabled={linked}
                 onChange={(e) => setStampsNeeded(Number(e.target.value))} />
          <label>Hədiyyə</label>
          <input value={reward} onChange={(e) => setReward(e.target.value)} disabled={linked} />
          {linked
            ? <div className="muted" style={{ marginTop: 10 }}>Bu ayarlar Hesabatım-ın biznes ayarlarından gəlir.</div>
            : <button type="submit">Yadda saxla</button>}
        </form>
      </div>
      {viaHesabatim ? (
        <div className="panel">
          <h2>Giriş</h2>
          <div className="muted">Hesabatım hesabı ilə daxil olmusunuz. Şifrə və işçilər Hesabatım-da idarə olunur.</div>
        </div>
      ) : (
      <div className="panel">
        <h2>Şifrəni dəyiş</h2>
        <form onSubmit={changePw}>
          <label>Hazırkı şifrə</label>
          <input type="password" autoComplete="current-password" required value={pw.current}
                 onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <label>Yeni şifrə (ən azı 8 simvol)</label>
          <input type="password" autoComplete="new-password" required minLength={8} value={pw.next}
                 onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <button type="submit">Dəyiş</button>
        </form>
        {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}
      </div>
      )}
    </div>
  );
}
