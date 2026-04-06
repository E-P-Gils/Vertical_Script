import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import { getPool } from "./db.js";

const SALT_ROUNDS = process.env.BCRYPT_SALT_ROUNDS
  ? Number(process.env.BCRYPT_SALT_ROUNDS)
  : 12;

const JWT_SECRET = process.env.JWT_SECRET || null;
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";

function jsonError(res, status, message) {
  res.status(status).json({ error: message });
}

export function isAuthEnabled() {
  return AUTH_ENABLED;
}

export function isJwtAuthEnabled() {
  return AUTH_ENABLED && !!JWT_SECRET;
}

async function findUserByEmail(email) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, email, password_hash, email_verified, verification_code_hash, verification_expires_at,
            plan_tier, script_credits
     FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function registerUser(req, res) {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");

    if (!email || !password)
      return jsonError(res, 400, "email and password are required");
    if (password.length < 8) return jsonError(res, 400, "password must be at least 8 characters");
    if (!isAuthEnabled()) return jsonError(res, 503, "auth is not enabled on this server");

    const pool = getPool();
    const existing = await findUserByEmail(email);
    if (existing?.email_verified) return jsonError(res, 409, "user already exists (verified)");

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, email_verified, verification_code_hash, verification_expires_at)
       VALUES ($1, $2, true, NULL, NULL)
       ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           email_verified = true,
           verification_code_hash = NULL,
           verification_expires_at = NULL
       RETURNING plan_tier, script_credits`,
      [email, passwordHash]
    );
    const planTier = ins.rows[0]?.plan_tier || "free";
    const scriptCredits = Number(ins.rows[0]?.script_credits ?? 0);
    res.json({ ok: true, planTier, scriptCredits });
  } catch (e) {
    console.error("registerUser failed:", e);
    jsonError(res, 500, "registration failed");
  }
}

export async function loginUser(req, res) {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");

    if (!email || !password) return jsonError(res, 400, "email and password are required");
    if (!isJwtAuthEnabled())
      return jsonError(res, 503, "jwt auth is not enabled on this server");

    const user = await findUserByEmail(email);
    if (!user) return jsonError(res, 401, "invalid credentials");
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return jsonError(res, 401, "invalid credentials");

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      ok: true,
      token,
      planTier: user.plan_tier || "free",
      scriptCredits: Number(user.script_credits ?? 0),
    });
  } catch (e) {
    console.error("loginUser failed:", e);
    jsonError(res, 500, "login failed");
  }
}

export async function verifyEmailCode(req, res) {
  return res.json({ ok: true, verified: true, skipped: true });
}

export function requireAuth(req, res, next) {
  if (!isJwtAuthEnabled()) return next();

  const header = String(req.headers.authorization || "");
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (!token) return jsonError(res, 401, "missing bearer token");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = decoded;
    return next();
  } catch (e) {
    return jsonError(res, 401, "invalid or expired token");
  }
}
