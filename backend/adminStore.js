import bcrypt from "bcrypt";
import { getPool } from "./db.js";

const SALT_ROUNDS = process.env.BCRYPT_SALT_ROUNDS ? Number(process.env.BCRYPT_SALT_ROUNDS) : 12;

/** Plans an operator may assign (not `admin`, which is owner-only). */
export const USER_ASSIGNABLE_PLAN_SLUGS = ["free", "starter", "professional"];

export async function logAdminAction(adminUserId, action, targetUserId, payload) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO admin_action_log (admin_user_id, action, target_user_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [adminUserId, String(action), targetUserId || null, JSON.stringify(payload ?? {})]
  );
}

export async function adminSearchUsers({ q, limit = 50, offset = 0 }) {
  const pool = getPool();
  const lim = Math.max(1, Math.min(100, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const search = String(q || "").trim().toLowerCase();
  if (search) {
    const r = await pool.query(
      `SELECT id, email, plan_slug, created_at, email_verified, account_suspended, trial_ends_at,
              subscription_ends_at, generation_credits
       FROM users
       WHERE lower(email) LIKE $1
       ORDER BY id DESC
       LIMIT $2 OFFSET $3`,
      [`%${search}%`, lim, off]
    );
    return r.rows;
  }
  const r = await pool.query(
    `SELECT id, email, plan_slug, created_at, email_verified, account_suspended, trial_ends_at,
            subscription_ends_at, generation_credits
     FROM users
     ORDER BY id DESC
     LIMIT $1 OFFSET $2`,
    [lim, off]
  );
  return r.rows;
}

export async function adminGetUserDetail(userId) {
  const pool = getPool();
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const u = await pool.query(
    `SELECT id, email, plan_slug, created_at, email_verified, account_suspended, trial_ends_at,
            subscription_ends_at, generation_credits, auth_token_version
     FROM users WHERE id = $1`,
    [id]
  );
  const row = u.rows[0];
  if (!row) return null;
  const scriptsCount = await pool.query(`SELECT COUNT(*)::int AS c FROM saved_scripts WHERE user_id = $1`, [id]);
  const billing = await pool.query(
    `SELECT id, entry_type, amount_cents, tier_slug, description, status, reference, created_at
     FROM financial_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [id]
  );
  return {
    ...row,
    scriptsCount: scriptsCount.rows[0]?.c ?? 0,
    billingHistory: billing.rows,
  };
}

export async function adminSetPlanSlug(targetUserId, planSlug, adminId) {
  const slug = String(planSlug || "").trim();
  if (!USER_ASSIGNABLE_PLAN_SLUGS.includes(slug)) {
    throw new Error("invalid plan slug (use free, starter, or professional)");
  }
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(`UPDATE users SET plan_slug = $2 WHERE id = $1 RETURNING id`, [id, slug]);
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "set_plan", id, { planSlug: slug });
  return r.rows[0];
}

export async function adminApplyTrial(targetUserId, days, adminId) {
  const d = Number(days);
  if (![7, 14, 30].includes(d)) throw new Error("trial duration must be 7, 14, or 30 days");
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(
    `UPDATE users SET trial_ends_at = NOW() + ($2::integer * interval '1 day') WHERE id = $1 RETURNING trial_ends_at`,
    [id, d]
  );
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "apply_trial", id, { days: d });
  return r.rows[0];
}

export async function adminExtendSubscription(targetUserId, days, adminId) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1 || d > 3650) throw new Error("days must be 1–3650");
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(
    `UPDATE users SET subscription_ends_at =
        COALESCE(subscription_ends_at, NOW()) + ($2::integer * interval '1 day')
     WHERE id = $1
     RETURNING subscription_ends_at`,
    [id, d]
  );
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "extend_subscription", id, { days: d });
  return r.rows[0];
}

export async function adminSuspendUser(targetUserId, suspended, adminId) {
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(
    `UPDATE users SET account_suspended = $2 WHERE id = $1 RETURNING id`,
    [id, !!suspended]
  );
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, suspended ? "suspend" : "reactivate", id, { suspended: !!suspended });
}

export async function adminDeleteUser(targetUserId, adminId) {
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id]);
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "delete_user", id, {});
}

export async function adminResetPassword(targetUserId, newPassword, adminId) {
  const pw = String(newPassword || "");
  if (pw.length < 8) throw new Error("password must be at least 8 characters");
  const hash = await bcrypt.hash(pw, SALT_ROUNDS);
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id`, [id, hash]);
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "reset_password", id, {});
}

export async function adminAddGenerationCredits(targetUserId, delta, adminId) {
  const d = Math.trunc(Number(delta));
  if (!Number.isFinite(d) || d === 0) throw new Error("delta must be a non-zero integer");
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(
    `UPDATE users SET generation_credits = GREATEST(0, generation_credits + $2) WHERE id = $1 RETURNING generation_credits`,
    [id, d]
  );
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "generation_credits_delta", id, { delta: d });
  return r.rows[0].generation_credits;
}

export async function adminIncrementAuthToken(targetUserId, adminId) {
  const pool = getPool();
  const id = Number(targetUserId);
  if (!Number.isFinite(id)) throw new Error("invalid user");
  const r = await pool.query(
    `UPDATE users SET auth_token_version = auth_token_version + 1 WHERE id = $1 RETURNING auth_token_version`,
    [id]
  );
  if (r.rowCount === 0) throw new Error("user not found");
  await logAdminAction(adminId, "force_logout_all", id, {});
  return r.rows[0].auth_token_version;
}

export async function adminInsertLedgerRow({
  userId,
  entryType,
  amountCents,
  tierSlug,
  description,
  status,
  reference,
  createdByAdminId,
}) {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO financial_ledger (user_id, entry_type, amount_cents, tier_slug, description, status, reference, created_by_admin_id)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'recorded'), $7, $8)
     RETURNING *`,
    [
      userId ?? null,
      entryType,
      amountCents,
      tierSlug || null,
      description || null,
      status || null,
      reference || null,
      createdByAdminId || null,
    ]
  );
  return r.rows[0];
}

export async function adminRevenueByTier(fromIso, toIso) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT COALESCE(tier_slug, '') AS tier_slug, COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
     FROM financial_ledger
     WHERE entry_type = 'revenue'
       AND ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at <= $2)
     GROUP BY tier_slug
     ORDER BY tier_slug NULLS LAST`,
    [fromIso || null, toIso || null]
  );
  return r.rows;
}

export async function adminTotalRevenueCents(fromIso, toIso) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
     FROM financial_ledger
     WHERE entry_type = 'revenue'
       AND ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at <= $2)`,
    [fromIso || null, toIso || null]
  );
  return Number(r.rows[0]?.total ?? 0);
}

export async function adminOutstandingInvoices() {
  const pool = getPool();
  const r = await pool.query(
    `SELECT fl.*, u.email
     FROM financial_ledger fl
     LEFT JOIN users u ON u.id = fl.user_id
     WHERE fl.entry_type = 'invoice' AND fl.status = 'open'
     ORDER BY fl.created_at DESC
     LIMIT 200`
  );
  return r.rows;
}

export async function adminGenreUsageStats() {
  const pool = getPool();
  const r = await pool.query(
    `SELECT genre, COUNT(*)::int AS cnt
     FROM saved_scripts
     WHERE genre IS NOT NULL AND trim(genre) <> ''
     GROUP BY genre
     ORDER BY cnt DESC
     LIMIT 40`
  );
  return r.rows;
}

export async function adminConversionTrialToPaid() {
  const pool = getPool();
  const converted = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM users
     WHERE trial_ends_at IS NOT NULL
       AND plan_slug IN ('starter', 'professional')`
  );
  const trials = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE trial_ends_at IS NOT NULL`);
  const c = converted.rows[0]?.c ?? 0;
  const t = trials.rows[0]?.c ?? 0;
  return {
    trialsStarted: t,
    convertedToPaidPlan: c,
    rate: t ? c / t : null,
    note: "Paid = starter/professional; no payment webhook yet — plans must be set manually or later via billing.",
  };
}

export async function adminRetentionByTier() {
  const pool = getPool();
  const retained = await pool.query(`
    WITH span AS (
      SELECT user_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM saved_scripts
      GROUP BY user_id
      HAVING COUNT(*) >= 2 AND EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) >= 7 * 86400
    )
    SELECT u.plan_slug, COUNT(*)::int AS retained_users
    FROM span s
    JOIN users u ON u.id = s.user_id
    GROUP BY u.plan_slug
    ORDER BY u.plan_slug
  `);
  const totals = await pool.query(`SELECT plan_slug, COUNT(*)::int AS total_users FROM users GROUP BY plan_slug ORDER BY plan_slug`);
  return {
    retainedByTier: retained.rows,
    usersByTier: totals.rows,
    note: "Retention proxy: users with 2+ scripts ≥7 days apart.",
  };
}

export async function adminChurnActivityProxy() {
  const pool = getPool();
  const now = Date.now();
  const currStart = new Date(now - 30 * 86400000);
  const prevStart = new Date(now - 60 * 86400000);
  const prev = await pool.query(
    `SELECT COUNT(DISTINCT user_id)::int AS c FROM saved_scripts WHERE updated_at >= $1 AND updated_at < $2`,
    [prevStart.toISOString(), currStart.toISOString()]
  );
  const curr = await pool.query(
    `SELECT COUNT(DISTINCT user_id)::int AS c FROM saved_scripts WHERE updated_at >= $1`,
    [currStart.toISOString()]
  );
  const a = prev.rows[0]?.c ?? 0;
  const b = curr.rows[0]?.c ?? 0;
  return {
    distinctUsersWithScriptTouchPrior30d: a,
    distinctUsersWithScriptTouchLast30d: b,
    approximateNetChange: b - a,
    note: "Not SaaS churn — compares distinct users touching scripts in two 30-day windows.",
  };
}

export async function adminSubscriptionsByTier() {
  const pool = getPool();
  const all = await pool.query(`
    SELECT plan_slug, COUNT(*)::int AS users FROM users GROUP BY plan_slug ORDER BY plan_slug
  `);
  const windowed = await pool.query(`
    SELECT plan_slug, COUNT(*)::int AS users
    FROM users
    WHERE subscription_ends_at IS NOT NULL AND subscription_ends_at > NOW()
    GROUP BY plan_slug
    ORDER BY plan_slug
  `);
  return {
    allUsersByTier: all.rows,
    activeSubscriptionEndDateByTier: windowed.rows,
    note: "Active subscription = subscription_ends_at > now (set via Admin → extend subscription).",
  };
}

export async function adminHealthStats() {
  const pool = getPool();
  const concurrent = await pool.query(`SELECT COUNT(*)::int AS c FROM saved_scripts WHERE status = 'generating'`);
  const statusCounts = await pool.query(`SELECT status, COUNT(*)::int AS c FROM saved_scripts GROUP BY status`);
  const avgComplete = await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS secs
     FROM saved_scripts WHERE status = 'complete'`
  );
  const rows = Object.fromEntries(statusCounts.rows.map((x) => [x.status, x.c]));
  const failed = rows.failed ?? 0;
  const complete = rows.complete ?? 0;
  const denom = failed + complete;
  const spend = process.env.ADMIN_OPENAI_SPEND_CENTS_MONTHLY
    ? Number(process.env.ADMIN_OPENAI_SPEND_CENTS_MONTHLY)
    : null;
  return {
    activeConcurrentGenerations: concurrent.rows[0]?.c ?? 0,
    failedGenerationRate: denom ? failed / denom : null,
    averageCompleteGenerationSeconds: avgComplete.rows[0]?.secs ?? null,
    statusBreakdown: rows,
    openaiSpendCentsMonthlyEstimate: Number.isFinite(spend) ? spend : null,
    openaiVsRevenueNote:
      "Revenue from financial_ledger (manual). Set ADMIN_OPENAI_SPEND_CENTS_MONTHLY for a rough monthly cost estimate.",
  };
}
