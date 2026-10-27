// SSE (EventSource): bir kanala abunə olur. Şəbəkə qopanda brauzer özü 1 saniyədə yenidən qoşulur,
// server rədd edərsə (403/5xx — məs. deploy zamanı) artan fasilə ilə biz özümüz yenidən cəhd edirik.
// Hər qoşulmada server təzə vəziyyəti göndərir, ona görə qopuş zamanı buraxılan dəyişiklik itmir.
import { useEffect, useRef, useState } from 'react';
import type { LiveMessage, LiveSub } from '../shared/types';

export type LiveState = 'connecting' | 'live' | 'offline';

export function useLive(sub: LiveSub | null, onMessage: (msg: LiveMessage) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const query = sub ? new URLSearchParams(sub as unknown as Record<string, string>).toString() : null;

  useEffect(() => {
    if (!query) return;
    let es: EventSource | null = null;
    let retry = 0;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      setState('connecting');
      es = new EventSource(`/api/live?${query}`);
      es.onmessage = (e) => {
        let msg: LiveMessage;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'subscribed') { retry = 0; setState('live'); }
        else handler.current(msg);
      };
      es.onerror = () => {
        if (closed) return;
        setState('offline');
        if (es?.readyState === EventSource.CLOSED) {
          timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
        }
      };
    };
    connect();

    // Telefon yuxudan oyananda bağlantı ölübsə gözləmədən yenidən qoşul
    const wake = () => {
      if (!document.hidden && es?.readyState === EventSource.CLOSED) {
        window.clearTimeout(timer); retry = 0; connect();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      closed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      es?.close();
    };
  }, [query]);

  return state;
}
