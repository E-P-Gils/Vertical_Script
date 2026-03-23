import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import crypto from "crypto";

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
  // Registration + email verification should work even if JWT_SECRET
  // isn't configured yet (JWT is only needed for login/protected routes).
  return AUTH_ENABLED;
}

function isJwtAuthEnabled() {
  return AUTH_ENABLED && !!JWT_SECRET;
}

async function findUserByEmail(email) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, email, password_hash, email_verified, verification_code_hash, verification_expires_at
     FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateVerificationCode() {
  // 6-digit numeric code
  const code = Math.floor(100000 + Math.random() * 900000);
  return String(code);
}

function hashVerificationCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function buildSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === "true";
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function sendVerificationEmail({ toEmail, code }) {
  const transport = buildSmtpTransport();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = process.env.VERIFY_EMAIL_SUBJECT || "Your verification code";
  const text =
    process.env.VERIFY_EMAIL_TEXT ||
    `Your confirmation code is: ${code}\n\nEnter it to verify your email. This code expires in 15 minutes.`;

  // If SMTP is not configured, we can't actually send an email.
  // For safety, we always log the code so you can complete verification in dev.
  if (!transport) {
    console.warn(
      "[auth] SMTP not configured; verification code will be printed to server logs.",
      { toEmail }
    );
    console.warn("[auth] Verification code:", code);
    return { sent: false, codeForDev: process.env.AUTH_DEV_RETURN_CODE === "true" ? code : null };
  }

  await transport.sendMail({
    from,
    to: toEmail,
    subject,
    text,
  });
  return { sent: true };
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
    const code = generateVerificationCode();
    const codeHash = hashVerificationCode(code);
    const expiresMs = process.env.VERIFY_CODE_TTL_MINUTES
      ? Number(process.env.VERIFY_CODE_TTL_MINUTES)
      : 15;
    const expiresAt = new Date(Date.now() + expiresMs * 60_000);

    // Upsert pending user (supports re-register/resend).
    await pool.query(
      `INSERT INTO users (email, password_hash, email_verified, verification_code_hash, verification_expires_at)
       VALUES ($1, $2, false, $3, $4)
       ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           email_verified = false,
           verification_code_hash = EXCLUDED.verification_code_hash,
           verification_expires_at = EXCLUDED.verification_expires_at`,
      [email, passwordHash, codeHash, expiresAt]
    );

    const emailResult = await sendVerificationEmail({ toEmail: email, code });

    // Never expose code by default. Only return it if explicitly enabled.
    res.json({
      ok: true,
      verification: {
        sent: emailResult.sent,
        devCode: emailResult.codeForDev || undefined,
      },
    });
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
    if (!user.email_verified) return jsonError(res, 403, "email not verified");

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return jsonError(res, 401, "invalid credentials");

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ ok: true, token });
  } catch (e) {
    console.error("loginUser failed:", e);
    jsonError(res, 500, "login failed");
  }
}

export async function verifyEmailCode(req, res) {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const code = String(body.code || "").trim();

    if (!email || !code) return jsonError(res, 400, "email and code are required");
    if (!isAuthEnabled()) return jsonError(res, 503, "auth is not enabled on this server");

    const user = await findUserByEmail(email);
    if (!user) return jsonError(res, 404, "user not found");
    if (user.email_verified) return res.json({ ok: true, verified: true });

    const expiresAt = user.verification_expires_at
      ? new Date(user.verification_expires_at)
      : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
      return jsonError(res, 400, "verification code missing/expired");
    }
    if (Date.now() > expiresAt.getTime()) {
      return jsonError(res, 400, "verification code expired");
    }

    const codeHash = hashVerificationCode(code);
    if (!user.verification_code_hash || user.verification_code_hash !== codeHash) {
      return jsonError(res, 400, "invalid verification code");
    }

    const pool = getPool();
    await pool.query(
      `UPDATE users
       SET email_verified = true,
           verification_code_hash = NULL,
           verification_expires_at = NULL
       WHERE email = $1`,
      [email]
    );

    return res.json({ ok: true, verified: true });
  } catch (e) {
    console.error("verifyEmailCode failed:", e);
    jsonError(res, 500, "verification failed");
  }
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

