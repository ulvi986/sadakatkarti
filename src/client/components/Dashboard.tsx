// Şirkət və admin panellərinin ortaq hissələri: göstərici kartları, qrafik, log cədvəli, kart siyahısı
import { useState, type ReactNode } from 'react';
import type { CardListItem, LogEntry, StaffCard } from '../../shared/types';
import type { LiveState } from '../live';
import { fmtDate } from '../utils';
import StampGrid from './StampGrid';

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: 'warn' | 'err' }) {
  return <div className={`stat${tone ? ` ${tone}` : ''}`}><b>{value ?? '–'}</b><span>{label}</span></div>;
}

export function LiveBadge({ state }: { state: LiveState }) {
  const text = state === 'live' ? 'Canlı' : state === 'connecting' ? 'Qoşulur…' : 'Bağlantı yoxdur';
  return <span className={`live-dot${state === 'live' ? ' on' : ''}`}>{text}</span>;
}

/** Tək sıralı sütun qrafiki: hər sütunun üzərinə gələndə dəqiq dəyər görünür */
export function BarChart({ title, data, unit }: { title: string; data: { label: string; value: number }[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 100 / data.length;
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <figure className="chart">
      <figcaption><b>{title}</b><span className="muted">Cəmi {total} {unit}</span></figcaption>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <span className="chart-max muted">{max}</span>
        <svg viewBox="0 0 100 50" preserveAspectRatio="none" role="img"
             aria-label={`${title}: ${data.map((d) => `${d.label} ${d.value}`).join(', ')}`}>
          <line x1="0" y1="50" x2="100" y2="50" className="chart-base" />
          <line x1="0" y1="0.5" x2="100" y2="0.5" className="chart-grid" />
          {data.map((d, i) => {
            const h = (d.value / max) * 48;
            const x = i * W + 0.4;
            const w = Math.max(0.5, W - 0.8);
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)}>
                <rect x={i * W} y="0" width={W} height="50" fill="transparent" />
                {d.value > 0 && (
                  <rect x={x} y={50 - h} width={w} height={h} rx="0.8"
                        className={`chart-bar${hover === i ? ' on' : ''}`} />
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${(hover + 0.5) * W}%` }}>
            <b>{data[hover].value} {unit}</b><span>{data[hover].label}</span>
          </div>
        )}
      </div>
      <div className="chart-axis muted">
        <span>{data[0]?.label}</span><span>{data[data.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

const shortDay = (d: string) => d.slice(5).split('-').reverse().join('.');
export const dayLabel = shortDay;

const LEVEL_ICON = { info: '●', warn: '▲', error: '■' } as const;
const CATEGORY = { request: 'Sorğu', audit: 'Əməliyyat', security: 'Təhlükəsizlik', integration: 'İnteqrasiya', system: 'Sistem' };

export function LogTable({ logs, companyName, onMore, showIp = true }: {
  logs: LogEntry[];
  companyName?: (id: number | null) => string | null;
  onMore?: () => void;
  showIp?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="logs">
        <thead>
          <tr><th>Vaxt</th><th>Səviyyə</th><th>Növ</th><th>Hadisə</th>{companyName && <th>Şirkət</th>}<th>Kim</th>{showIp && <th>IP</th>}</tr>
        </thead>
        <tbody>
          {logs.length === 0 && <tr><td colSpan={7} className="muted center">Log yoxdur</td></tr>}
          {logs.map((l) => (
            <tr key={l.id} className={`lvl-${l.level}`}>
              <td className="nowrap">{fmtDate(l.at)}</td>
              <td className="nowrap"><span className={`lvl lvl-${l.level}`}>{LEVEL_ICON[l.level]} {l.level}</span></td>
              <td>{CATEGORY[l.category]}</td>
              <td>
                <code>{l.action}</code>
                {l.status !== null && <span className="muted"> · {l.status} · {l.durationMs} ms</span>}
                {l.message && <div className="log-msg">{l.message}</div>}
              </td>
              {companyName && <td>{companyName(l.companyId) ?? '—'}</td>}
              <td>{l.actor ?? '—'}</td>
              {showIp && <td className="nowrap">{l.ip ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {onMore && logs.length >= 100 && <button className="secondary" onClick={onMore}>Daha köhnələr</button>}
    </div>
  );
}

export function CardTable({ cards, onPick, showCompany = false }: {
  cards: CardListItem[];
  onPick: (token: string) => void;
  showCompany?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Müştəri</th>{showCompany && <th>Şirkət</th>}<th>Möhür</th><th>Hədiyyə</th><th>Mənbə</th><th>Son möhür</th></tr>
        </thead>
        <tbody>
          {cards.length === 0 && <tr><td colSpan={6} className="muted center">Tapılmadı</td></tr>}
          {cards.map((c) => (
            <tr key={c.token} className="clickable" onClick={() => onPick(c.token)}>
              <td><b>{c.name}</b><div className="muted">{c.phone}</div></td>
              {showCompany && <td>{c.companyName}</td>}
              <td className="nowrap">{c.stamps}/{c.stampsNeeded}{c.stamps >= c.stampsNeeded ? ' 🎁' : ''}</td>
              <td>{c.rewards}</td>
              <td>{c.source === 'hesabatim' ? 'Hesabatım' : 'Lokal'}</td>
              <td className="nowrap">{fmtDate(c.lastStampAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVENT_TEXT = { stamp: 'möhür', redeem: 'hədiyyə verildi', adjust: 'düzəliş', sync: 'sinxron' } as const;

export function CardSummary({ card, children }: { card: StaffCard; children?: ReactNode }) {
  return (
    <>
      <div className="loyalty">
        <div className="top">
          <div>
            <div className="cafe">{card.name}</div>
            <div className="who">{card.phone} · {card.company.name}</div>
          </div>
          <div className="count">{card.stamps}/{card.stampsNeeded}</div>
        </div>
        <StampGrid stamps={card.stamps} needed={card.stampsNeeded} rewardReady={card.rewardReady}
                   logoUrl={card.company.logoUrl} companyName={card.company.name} />
        <div className="who">
          Cəmi {card.totalStamps} möhür · {card.rewards} hədiyyə · {card.source === 'hesabatim' ? 'Hesabatım kartı' : 'Lokal kart'}
          {!card.active && ' · əvəz olunub'}
        </div>
      </div>
      {children}
      {card.history.length > 0 && (
        <ol className="history">
          {card.history.map((h, i) => (
            <li key={i}>
              {h.type === 'stamp' ? `+${h.amount} möhür` : h.type === 'adjust' ? `${h.amount > 0 ? '+' : ''}${h.amount} düzəliş` : `🎁 ${EVENT_TEXT[h.type]}`}
              {' '}— {fmtDate(h.at)} <span className="muted">({h.actor})</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
