import { getPool } from "./db.js";

/** Stored lowercase on `users.plan_tier` */
export const PLAN_TIERS = Object.freeze(["free", "starter", "professional", "business"]);

export function assertValidPlanTier(tier) {
  const t = String(tier || "").trim().toLowerCase();
  if (!PLAN_TIERS.includes(t)) {
    throw new Error(`Invalid plan tier. Use one of: ${PLAN_TIERS.join(", ")}`);
  }
  return t;
}

export async function getUserPlanRow(userId) {
  const pool = getPool();
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const r = await pool.query(`SELECT id, email, plan_tier, script_credits FROM users WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function setUserPlanTierByUserId(userId, tier) {
  const t = assertValidPlanTier(tier);
  const pool = getPool();
  const id = Number(userId);
  if (!Number.isFinite(id)) throw new Error("invalid user id");
  const r = await pool.query(
    `UPDATE users SET plan_tier = $2 WHERE id = $1 RETURNING id, email, plan_tier`,
    [id, t]
  );
  if (r.rowCount === 0) throw new Error("user not found");
  return r.rows[0];
}
