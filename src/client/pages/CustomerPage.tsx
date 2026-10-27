import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { PublicCard, PublicCompany } from '../../shared/types';
import { azPhoneError, formatAzPhone } from '../../shared/phone';
import { api, ApiError } from '../api';
import { applyBrand } from '../brand';
import { useLive } from '../live';
import { feedback, ordinal, safeStorage } from '../utils';
import StampGrid from '../components/StampGrid';

// Kamera kitabxanası böyükdür — yalnız "QR kodu oxut" basılanda yüklənir
const QrScanner = lazy(() => import('../components/QrScanner'));

const FALLBACK_POLL_MS = 5000; // yalnız canlı axın qopanda

// Bu telefonda açılmış kartlar: hər kafe üçün bir token. Kafenin QR-i yenidən oxunanda kart birbaşa açılır.
const lastStore = safeStorage('local', 'loyaltyToken');
const cardsStore = safeStorage('local', 'loyaltyCards');
const savedCards = (): Record<string, string> => {
  try { return JSON.parse(cardsStore.get() || '{}'); } catch { return {}; }
};
const saveCard = (slug: string, token: string) => {
  cardsStore.set(JSON.stringify({ ...savedCards(), [slug]: token }));
  lastStore.set(token);
};
const forgetToken = (token: string) => {
  cardsStore.set(JSON.stringify(Object.fromEntries(Object.entries(savedCards()).filter(([, t]) => t !== token))));
  if (lastStore.get() === token) lastStore.clear();
};

function initialToken(urlToken: string | null, urlSlug: string | null): string | null {
  if (urlToken) return urlToken;
  if (urlSlug) return savedCards()[urlSlug] ?? null;
  return lastStore.get();
}

export default function CustomerPage({ urlToken, urlSlug }: { urlToken: string | null; urlSlug: string | null }) {
  const [slug, setSlug] = useState(urlSlug);
  const [company, setCompany] = useState<PublicCompany | null>(null);
  // none: "/" üçün şirkət seçilməyib · notfound: /k/slug yoxdur · offline: server cavab vermir
  const [companyState, setCompanyState] = useState<'none' | 'notfound' | 'offline' | null>(null);
  const [retry, setRetry] = useState(0);
  const [token, setToken] = useState<string | null>(() => initialToken(urlToken, urlSlug));
  const [card, setCard] = useState<PublicCard | null>(null);
  const [loading, setLoading] = useState(token !== null);
  const [startMode, setStartMode] = useState<'signup' | 'login'>('signup');

  // Kart açıqdırsa şirkət kartın özündən gəlir, yoxsa /k/slug və ya standart şirkət
  useEffect(() => {
    if (token) return;
    (slug ? api.company(slug) : api.defaultCompany())
      .then((c) => { setCompany(c); setCompanyState(null); })
      .catch((e) => setCompanyState(e instanceof ApiError && e.status === 404 ? (slug ? 'notfound' : 'none') : 'offline'));
  }, [token, slug, retry]);

  const shown = card?.company ?? company;
  useEffect(() => {
    document.title = shown ? `${shown.name} · Sadiqlik Kartı` : 'Sadiqlik Kartı';
    applyBrand(shown?.theme);
  }, [shown]);

  const accept = useCallback((c: PublicCard) => {
    setCard(c);
    setCompany(c.company);
    if (c.active) saveCard(c.company.slug, c.token);
    if (window.location.pathname !== `/c/${c.token}`) window.history.replaceState(null, '', `/c/${c.token}`);
  }, []);

  const load = useCallback(async (t: string) => {
    try {
      accept(await api.card(t));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        forgetToken(t);
        setToken(null);
        setCard(null);
      }
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => { if (token) load(token); }, [token, load]);

  // Möhür vurulan an (və ya kafe rəngini dəyişəndə) server SSE ilə yeni kartı dərhal göndərir
  const live = useLive(token ? { channel: 'card', token } : null, (msg) => {
    if (msg.type === 'card' && msg.card.token === token) accept(msg.card);
  });

  useEffect(() => {
    if (!token || live === 'live') return;
    const t = window.setInterval(() => { if (!document.hidden) load(token); }, FALLBACK_POLL_MS);
    return () => window.clearInterval(t);
  }, [token, live, load]);

  /** Bu telefonda kartdan çıx və həmin kafenin giriş formasına qayıt */
  const logout = () => {
    if (card) forgetToken(card.token);
    const s = card?.company.slug ?? slug;
    window.history.replaceState(null, '', s ? `/k/${s}` : '/');
    setSlug(s);
    setStartMode('login');
    setCard(null);
    setToken(null);
  };

  return (
    <div className="wrap">
      <div className="brand">
        {shown?.logoUrl
          ? <img className="logo logo-img" src={shown.logoUrl} alt={`${shown.name} loqosu`} />
          : <div className="logo">{shown ? shown.name.trim().charAt(0).toUpperCase() : '★'}</div>}
        <h1>{shown?.name ?? 'Sadiqlik Kartı'}</h1>
        {!shown && <div className="muted">Möhür yığ, hədiyyə qazan</div>}
        {shown && (
          <div className="muted">
            {shown.stampsNeeded} dəfə al — {ordinal(shown.stampsNeeded + 1)} bizdən hədiyyə: {shown.reward}
          </div>
        )}
      </div>

      {loading ? (
        <div className="panel muted center">Yüklənir…</div>
      ) : card ? (
        <CardView card={card} live={live === 'live'} onLogout={logout} />
      ) : companyState === 'offline' ? (
        <div className="panel">
          <div className="banner err">Serverə qoşulmaq olmadı. İnternet bağlantınızı yoxlayın.</div>
          <button onClick={() => setRetry((n) => n + 1)}>Yenidən cəhd et</button>
        </div>
      ) : companyState ? (
        <ScanLanding notFound={companyState === 'notfound'} />
      ) : company ? (
        <StartForm key={company.slug} company={company} initialMode={startMode}
                   onCard={(c) => { accept(c); setToken(c.token); }} />
      ) : (
        <div className="panel muted center">Yüklənir…</div>
      )}
    </div>
  );
}

/** Şirkət bilinmədikdə: müştəri kassadakı/masadakı QR-i saytın içindən oxudur və öz kafesinin səhifəsinə keçir */
function ScanLanding({ notFound }: { notFound: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onScan = (text: string) => {
    const target = qrTarget(text);
    if (!target) {
      feedback(false);
      setError('Bu QR kod sadiqlik kartına aid deyil. Kassadakı və ya masadakı QR kodu oxudun.');
      return;
    }
    feedback(true);
    setScanning(false);
    window.location.assign(target);
  };

  return (
    <div className="panel center">
      <div className="scan-hint" aria-hidden="true">▣</div>
      <h2>QR kodu oxudun</h2>
      <div className="muted">
        {notFound ? 'Bu link köhnədir. ' : ''}Kassada və ya masada olan QR kodu oxudun — kafenin sadiqlik kartı açılacaq.
      </div>
      {scanning && (
        <Suspense fallback={<div className="muted" style={{ marginTop: 14 }}>Kamera açılır…</div>}>
          <div style={{ marginTop: 14 }}>
            <QrScanner onScan={onScan} onError={(t) => { setScanning(false); setError(t); }} />
          </div>
        </Suspense>
      )}
      {scanning
        ? <button className="secondary" onClick={() => setScanning(false)}>Dayandır</button>
        : <button onClick={() => { setError(null); setScanning(true); }}>📷 QR kodu oxut</button>}
      <div className="muted" style={{ marginTop: 12, fontSize: '.85rem' }}>
        Telefonun öz kamerası ilə də oxuda bilərsiniz — link avtomatik açılacaq.
      </div>
      {error && <div className="banner err">{error}</div>}
    </div>
  );
}

/** QR mətnindən saytımızdakı hədəfi çıxarır: /k/slug (kafe) və ya /c/token (kart) */
function qrTarget(text: string): string | null {
  const m = text.match(/\/(k|c)\/([A-Za-z0-9_-]+)/);
  return m ? `/${m[1]}/${m[2]}` : null;
}

/** Azərbaycan nömrəsi: yazdıqca "+994 50 123 45 67" formatı, çıxanda səhv izahı */
function PhoneInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [touched, setTouched] = useState(false);
  const error = touched && value ? azPhoneError(value) : null;
  return (
    <>
      <label htmlFor="phone">Telefon nömrən</label>
      <input id="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="+994 50 123 45 67"
             value={value} aria-invalid={Boolean(error)} aria-describedby="phone-hint"
             onChange={(e) => onChange(formatAzPhone(e.target.value))} onBlur={() => setTouched(true)} />
      <div id="phone-hint" className={`field-hint${error ? ' err' : ''}`}>
        {error ?? 'Azərbaycan mobil nömrəsi: 10, 50, 51, 55, 60, 70, 77, 99'}
      </div>
    </>
  );
}

function StartForm({ company, initialMode, onCard }: {
  company: PublicCompany;
  initialMode: 'signup' | 'login';
  onCard: (card: PublicCard) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const phoneError = azPhoneError(phone);
    if (phoneError) return setError(phoneError);
    setError(null);
    setBusy(true);
    try {
      onCard(mode === 'signup'
        ? await api.signup(company.slug, { name, phone })
        : await api.findCard(company.slug, phone));
    } catch (err) {
      // Nömrə tapılmadısa yeni kart açmağa keçir, nömrəni saxla
      if (mode === 'login' && err instanceof ApiError && err.status === 404) setMode('signup');
      setError(err instanceof Error ? err.message : 'Xəta baş verdi');
    } finally {
      setBusy(false);
    }
  };

  const pick = (m: 'signup' | 'login') => { setMode(m); setError(null); };

  return (
    <div className="panel">
      <nav className="tabs">
        <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => pick('signup')}>Yeni kart</button>
        <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => pick('login')}>Kartım var</button>
      </nav>
      <div className="muted">
        {mode === 'signup'
          ? 'Pulsuzdur. Hər alışda QR kodunu kassaya göstər, möhür yığ.'
          : 'Telefonu dəyişmisən və ya brauzer təmizlənib? Nömrənlə daxil ol — möhürlərin yerindədir.'}
      </div>
      <form onSubmit={submit} noValidate>
        {mode === 'signup' && (
          <>
            <label htmlFor="name">Adın</label>
            <input id="name" autoComplete="given-name" required maxLength={60} placeholder="Məs: Aysel"
                   value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}
        <PhoneInput value={phone} onChange={(v) => { setPhone(v); setError(null); }} />
        <button type="submit" disabled={busy}>
          {busy ? 'Gözləyin…' : mode === 'signup' ? 'Kartımı yarat' : 'Kartıma daxil ol'}
        </button>
      </form>
      {error && <div className="banner err">{error}</div>}
    </div>
  );
}

function CardView({ card, live, onLogout }: { card: PublicCard; live: boolean; onLogout: () => void }) {
  // Yeni vurulan möhürləri animasiya etmək üçün əvvəlki sayı yadda saxla
  const prevStamps = useRef<number | null>(null);
  const animateFrom = prevStamps.current !== null && card.stamps > prevStamps.current ? prevStamps.current : null;

  useEffect(() => {
    if (prevStamps.current !== null && prevStamps.current !== card.stamps) navigator.vibrate?.(120);
    prevStamps.current = card.stamps;
  }, [card.stamps]);

  if (!card.active) {
    return (
      <div className="panel">
        <div className="banner err">Bu kart yenisi ilə əvəz olunub.</div>
        <button onClick={onLogout}>Nömrə ilə yenidən daxil ol</button>
      </div>
    );
  }

  const left = card.stampsNeeded - card.stamps;
  const qrValue = `${window.location.origin}/c/${card.token}`;

  return (
    <>
      <div className="loyalty">
        <div className="top">
          <div>
            <div className="cafe">{card.company.name.toUpperCase()}</div>
            <div className="who">{card.name}</div>
          </div>
          <div className="count">{card.stamps}/{card.stampsNeeded}</div>
        </div>
        <StampGrid stamps={card.stamps} needed={card.stampsNeeded} rewardReady={card.rewardReady}
                   animateFrom={animateFrom} logoUrl={card.company.logoUrl}
                   companyName={card.company.name} />
        <div className="who">
          {card.rewardReady
            ? `Hədiyyən hazırdır: ${card.company.reward}!`
            : `Hədiyyəyə ${left} möhür qaldı${card.rewards ? ` · İndiyədək ${card.rewards} hədiyyə` : ''}`}
        </div>
      </div>

      {card.rewardReady && (
        <div className="banner reward">🎉 Təbriklər! {card.company.reward} — QR kodu kassaya göstər.</div>
      )}

      <div className="qr-box">
        <QRCodeSVG value={qrValue} size={220} level="M" fgColor="#2a1f17" bgColor="#ffffff" marginSize={2} />
        <div className="muted" style={{ marginTop: 8 }}>Bu QR kodu kassada göstər</div>
        <div className={`live-dot${live ? ' on' : ''}`}>{live ? 'Canlı' : 'Yenilənir…'}</div>
      </div>

      <button className="secondary" onClick={onLogout}>Başqa nömrə ilə daxil ol</button>
    </>
  );
}
