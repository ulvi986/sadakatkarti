// Loglar: hər API sorğusu, giriş cəhdi, möhür, inteqrasiya hadisəsi bazaya yazılır və admin panelə canlı ötürülür.
// Railway loglarında da görünsün deyə hər sətir həm də stdout-a JSON kimi çıxır.
import { config } from './config.js';
import { getDb, iso, type Row } from './db.js';
import { publish } from './realtime.js';
import type { LogCategory, LogEntry, LogLevel } from '../shared/types.js';

export interface LogInput {
  level?: LogLevel;
  category: LogCategory;
  action: string;
  message?: string;
  companyId?: number | null;
  actor?: string | null;
  ip?: string | null;
  status?: number;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

const COLS = ['level', 'category', 'company_id', 'actor', 'ip', 'action', 'message', 'status', 'duration_ms', 'meta'];
let queue: LogInput[] = [];
let flushing = false;

export function toLogEntry(r: Row): LogEntry {
  return {
    id: Number(r.id),
    at: iso(r.at)!,
    level: r.level as LogLevel,
    category: r.category as LogCategory,
    companyId: r.company_id == null ? null : Number(r.company_id),
    actor: (r.actor as string) ?? null,
    ip: (r.ip as string) ?? null,
    action: String(r.action),
    message: (r.message as string) ?? null,
    status: r.status == null ? null : Number(r.status),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    meta: (r.meta as Record<string, unknown>) ?? null,
  };
}

export function log(entry: LogInput) {
  const e = { level: 'info' as LogLevel, ...entry };
  const line = { t: new Date().toISOString(), ...e };
  (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log)(JSON.stringify(line));
  queue.push(e);
  if (queue.length >= 200) void flush();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, 500);
  try {
    const db = await getDb();
    const params: unknown[] = [];
    const values = batch.map((e) => {
      const row = [e.level, e.category, e.companyId ?? null, e.actor ?? null, e.ip ?? null, e.action,
        e.message ?? null, e.status ?? null, e.durationMs ?? null, e.meta ? JSON.stringify(e.meta) : null];
      const start = params.length;
      params.push(...row);
      return `(${row.map((_, i) => `$${start + i + 1}`).join(', ')})`;
    });
    const rows = await db.query(`INSERT INTO logs (${COLS.join(', ')}) VALUES ${values.join(', ')} RETURNING *`, params);
    for (const r of rows) {
      const entry = toLogEntry(r);
      publish('admin', { type: 'log', log: entry });
      // Şirkət öz audit/təhlükəsizlik loglarını görür, xam sorğu loglarını yox
      if (entry.companyId != null && entry.category !== 'request') {
        publish(`company:${entry.companyId}`, { type: 'log', log: entry });
      }
    }
  } catch (e) {
    console.error('Loglar bazaya yazılmadı:', e);
  } finally {
    flushing = false;
  }
}

export function startLogPipeline() {
  setInterval(() => void flush(), 1000).unref();
  // Köhnə logları sil (saatda bir)
  const prune = async () => {
    try {
      const db = await getDb();
      await db.query(`DELETE FROM logs WHERE at < now() - make_interval(days => $1)`, [config.logRetentionDays]);
      await db.query(`DELETE FROM webhook_seen WHERE at < now() - interval '1 day'`);
    } catch (e) {
      console.error('Log təmizləmə xətası:', e);
    }
  };
  setInterval(() => void prune(), 3600_000).unref();
  void prune();
}

export const flushLogs = flush;
