// Verilənlər bazası: Railway-də Postgres (pg), lokalda PGlite (fayl içində Postgres) — SQL hər ikisində eynidir
import fs from 'node:fs';
import { config } from './config.js';

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  stamps_needed INT NOT NULL DEFAULT 9,
  reward TEXT NOT NULL DEFAULT 'Pulsuz məhsul',
  hesabatim_slug TEXT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ
);

-- Loqo və kart rəngləri Hesabatım-dan gəlir (bağlı şirkətlərdə)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_hash TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS theme JSONB;

CREATE TABLE IF NOT EXISTS cards (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id),
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  stamps INT NOT NULL DEFAULT 0,
  total_stamps INT NOT NULL DEFAULT 0,
  rewards INT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'local',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_stamp_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  UNIQUE (company_id, phone)
);
CREATE INDEX IF NOT EXISTS cards_company_idx ON cards (company_id, id DESC);
CREATE INDEX IF NOT EXISTS cards_seen_idx ON cards (last_seen_at) WHERE source = 'hesabatim';

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  card_id INT NOT NULL REFERENCES cards(id),
  company_id INT NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,
  amount INT NOT NULL DEFAULT 1,
  actor TEXT NOT NULL DEFAULT 'system',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_card_idx ON events (card_id, id DESC);
CREATE INDEX IF NOT EXISTS events_company_at_idx ON events (company_id, at);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  company_id INT,
  actor TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  message TEXT,
  status INT,
  duration_ms INT,
  meta JSONB
);
CREATE INDEX IF NOT EXISTS logs_at_idx ON logs (id DESC);
CREATE INDEX IF NOT EXISTS logs_company_idx ON logs (company_id, id DESC);
CREATE INDEX IF NOT EXISTS logs_category_idx ON logs (category, id DESC);

CREATE TABLE IF NOT EXISTS webhook_seen (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function createPg(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1|[\w-]+\.railway\.internal)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('Postgres pool xətası:', e));
  return {
    query: async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[],
    exec: async (sql) => { await pool.query(sql); },
    close: () => pool.end(),
  };
}

async function createPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  return {
    query: async <T>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows,
    exec: async (sql) => { await db.exec(sql); },
    close: () => db.close(),
  };
}

let dbPromise: Promise<Db> | undefined;

export function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const db = config.databaseUrl ? await createPg(config.databaseUrl) : await createPglite(config.pgliteDir);
    await db.exec(SCHEMA);
    console.log(`Baza hazırdır: ${config.databaseUrl ? 'Postgres' : `PGlite (${config.pgliteDir})`}`);
    return db;
  })();
  return dbPromise;
}

/** Tarixləri ISO (UTC) sətirə çevirir */
export const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
