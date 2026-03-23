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
    return { connectionString: normalized, ssl: "require" };
  }

  const host = process.env.PGHOST;
  const port = process.env.PGPORT ? Number(process.env.PGPORT) : 5432;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE || process.env.PGDB;

  if (!host || !user || !database) return null;

  // Many managed Postgres setups require SSL.
  return { host, port, user, password, database, ssl: "require" };
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
}

