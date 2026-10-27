// Azərbaycan mobil nömrələri: +994 + operator kodu + 7 rəqəm. Həm server, həm client eyni qaydanı işlədir.
// Qəbul olunan yazılışlar: +994 50 123 45 67 · 994501234567 · 050 123 45 67 · 50 123 45 67

/** Mobil operator kodları: Azercell 10/50/51, Bakcell 55/99, Nar 70/77, Naxtel 60 */
export const AZ_MOBILE_CODES = ['10', '50', '51', '55', '60', '70', '77', '99'];

/** 9 rəqəmli milli hissə (operator + nömrə) və ya null */
function nationalPart(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00994')) d = d.slice(5);
  else if (d.startsWith('994')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return d.length === 9 ? d : null;
}

/** Düzgün nömrəni "+994501234567" şəklinə salır, yanlışdırsa null */
export function normalizeAzPhone(raw: unknown): string | null {
  const n = nationalPart(String(raw ?? ''));
  if (!n || !AZ_MOBILE_CODES.includes(n.slice(0, 2))) return null;
  return `+994${n}`;
}

/** Yazılarkən göstərmək üçün: "+994 50 123 45 67" (yarımçıq nömrəni də hissə-hissə formatlayır) */
export function formatAzPhone(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('994')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  d = d.slice(0, 9);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return parts.length ? `+994 ${parts.join(' ')}` : '';
}

/** Yanlış nömrə üçün səbəbi deyən mesaj, düzgündürsə null */
export function azPhoneError(raw: unknown): string | null {
  const n = nationalPart(String(raw ?? ''));
  if (!n) return 'Nömrə +994 və 9 rəqəmdən ibarət olmalıdır: +994 50 123 45 67';
  if (!AZ_MOBILE_CODES.includes(n.slice(0, 2))) {
    return `Operator kodu yanlışdır (${n.slice(0, 2)}). Mümkün kodlar: ${AZ_MOBILE_CODES.join(', ')}`;
  }
  return null;
}
