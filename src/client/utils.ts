// localStorage / sessionStorage gizli rejimdə xəta ata bilər — hamısı try/catch ilə
export function safeStorage(kind: 'local' | 'session', key: string) {
  const s = () => (kind === 'local' ? window.localStorage : window.sessionStorage);
  return {
    get(): string | null { try { return s().getItem(key); } catch { return null; } },
    set(v: string) { try { s().setItem(key, v); } catch { /* yox say */ } },
    clear() { try { s().removeItem(key); } catch { /* yox say */ } },
  };
}

/** Azərbaycan dilində sıra sayı şəkilçisi: 10 → "10-cu", 6 → "6-cı" */
export function ordinal(n: number): string {
  const byDigit: Record<number, string> = { 1: 'ci', 2: 'ci', 3: 'cü', 4: 'cü', 5: 'ci', 6: 'cı', 7: 'ci', 8: 'ci', 9: 'cu' };
  const byTens: Record<number, string> = { 1: 'cu', 2: 'ci', 3: 'cu', 4: 'cı', 5: 'ci', 6: 'cı', 7: 'ci', 8: 'ci', 9: 'cı' };
  const last = n % 10;
  if (last) return `${n}-${byDigit[last]}`;
  const tens = Math.floor(n / 10) % 10;
  return `${n}-${tens ? byTens[tens] : 'cü'}`;
}

/** ISO (UTC) vaxtını yerli formata çevirir */
export function fmtDate(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleString('az-AZ') : '—';
}

export function feedback(ok = true) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch { /* səs yoxdur */ }
  navigator.vibrate?.(ok ? 80 : [60, 60, 60]);
}

/** QR mətnindən kart tokenini çıxarır (tam URL və ya sadəcə token) */
export function tokenFromQr(text: string): string | null {
  const m = text.match(/\/c\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(text) ? text : null;
}
