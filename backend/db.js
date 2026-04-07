import { Pool } from "pg";

let _pool = null;

function buildConnectionConfig() {
  // Render often provides DATABASE_URL; fall back to individual PG* env vars.
  const databaseUrl =
    process.env.DATABASE_URL ||
    process.env.RENDER_POSTGRES_URL ||
    process.env.RENDER_DATABASE_URL ||
    process.env.PG_CONNECTION_STRING ||
    null;
  if (databaseUrl) {
    // pg accepts postgresql:// but normalizing avoids edge cases.
    let normalized = String(databaseUrl);
    if (normalized.startsWith("postgresql://")) {
      normalized = normalized.replace(/^postgresql:\/\//i, "postgres://");
    }
    // Common mistake: people paste the database service name (e.g. "vertical_script")
    // into DATABASE_URL. Render requires the full postgres://... connection string.
    if (!normalized.includes("://")) {
      console.warn(
        "[db] DATABASE_URL/RENDER_* URL does not look like a connection string:",
        databaseUrl
      );
    }
    // pg expects ssl to be boolean or an object. Passing a string can crash in newer pg versions.
    return { connectionString: normalized, ssl: { rejectUnauthorized: false } };
  }

  const host = process.env.PGHOST;
  const port = process.env.PGPORT ? Number(process.env.PGPORT) : 5432;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE || process.env.PGDB;

  if (!host || !user || !database) return null;

  // Many managed Postgres setups require SSL.
  return { host, port, user, password, database, ssl: { rejectUnauthorized: false } };
}

export function getPool() {
  if (_pool) return _pool;
  const cfg = buildConnectionConfig();
  if (!cfg) {
    throw new Error(
      "Postgres config missing. On Render, set DATABASE_URL (full postgres://... connection string). Or set PGHOST+PGUSER+PGDATABASE(+PGPASSWORD)."
    );
  }
  _pool = new Pool(cfg);
  return _pool;
}

export async function initDb() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Upgrade existing schema without requiring migrations.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_hash TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;`);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';`);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_plan_tier_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_plan_tier_check
          CHECK (plan_tier IN ('free', 'starter', 'professional', 'business'));
      END IF;
    END $$;
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS script_credits INTEGER NOT NULL DEFAULT 0;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_scripts (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Generated Script',
      genre TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      english_text TEXT NOT NULL DEFAULT '',
      chinese_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'generating',
      episode_target INTEGER NOT NULL DEFAULT 60,
      episode_done INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_saved_scripts_user_updated ON saved_scripts (user_id, updated_at DESC);`
  );
}

