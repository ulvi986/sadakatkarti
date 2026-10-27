// Şirkətin Hesabatım-dakı rəngləri müştəri səhifəsinə CSS dəyişənləri kimi tətbiq olunur.
// Açıq rəngli kartda ağ yazı oxunmasın deyə yazı rəngi parlaqlığa görə seçilir.
import type { BrandTheme } from '../shared/types';

const DEFAULTS = { primary: '#6b4226', accent: '#e9b949' };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Fonda oxunaqlı yazı rəngi */
const inkOn = (hex: string) => (luminance(hex) > 0.45 ? '#2a1f17' : '#ffffff');

export function applyBrand(theme: BrandTheme | null | undefined) {
  const root = document.documentElement.style;
  const primary = theme?.primary ?? DEFAULTS.primary;
  const accent = theme?.accent ?? DEFAULTS.accent;
  const card = theme?.card ?? primary;
  root.setProperty('--brand', primary);
  root.setProperty('--brand-ink', inkOn(primary));
  root.setProperty('--accent', accent);
  root.setProperty('--accent-ink', inkOn(accent));
  root.setProperty('--card-bg', card);
  root.setProperty('--card-ink', inkOn(card));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', primary);
}
