import { Router } from "express";
import { isJwtAuthEnabled } from "./auth.js";
import {
  adminSearchUsers,
  adminGetUserDetail,
  adminSetPlanSlug,
  adminApplyTrial,
  adminExtendSubscription,
  adminSuspendUser,
  adminDeleteUser,
  adminResetPassword,
  adminAddGenerationCredits,
  adminIncrementAuthToken,
  adminInsertLedgerRow,
  adminRevenueByTier,
  adminTotalRevenueCents,
  adminOutstandingInvoices,
  adminGenreUsageStats,
  adminConversionTrialToPaid,
  adminRetentionByTier,
  adminChurnActivityProxy,
  adminSubscriptionsByTier,
  adminHealthStats,
  logAdminAction,
} from "./adminStore.js";
import {
  adminListGeneratingScripts,
  adminMarkScriptFailedAnyUser,
  adminListFailedScripts,
  adminListScriptsForUserId,
} from "./scriptsStore.js";

export function requireAdmin(req, res, next) {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "JWT auth is not enabled on this server." });
  }
  if (req.auth?.planSlug !== "admin") {
    return res.status(403).json({ error: "Admin access only." });
  }
  next();
}

function adminSub(req) {
  return Number(req.auth?.sub);
}

export function createAdminRouter() {
  const router = Router();

  router.get("/users", async (req, res) => {
    try {
      const q = req.query.q;
      const limit = req.query.limit;
      const offset = req.query.offset;
      const rows = await adminSearchUsers({ q, limit, offset });
      res.json({ users: rows });
    } catch (e) {
      console.error("GET /admin/users:", e);
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/users/:id", async (req, res) => {
    try {
      const row = await adminGetUserDetail(req.params.id);
      if (!row) return res.status(404).json({ error: "user not found" });
      res.json({ user: row });
    } catch (e) {
      console.error("GET /admin/users/:id:", e);
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/users/:id/scripts", async (req, res) => {
    try {
      const limit = req.query.limit;
      const rows = await adminListScriptsForUserId(req.params.id, limit);
      res.json({ scripts: rows });
    } catch (e) {
      console.error("GET /admin/users/:id/scripts:", e);
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/plan", async (req, res) => {
    try {
      const planSlug = req.body?.planSlug;
      await adminSetPlanSlug(req.params.id, planSlug, adminSub(req));
      const user = await adminGetUserDetail(req.params.id);
      res.json({ ok: true, user });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/trial", async (req, res) => {
    try {
      const days = req.body?.days;
      const row = await adminApplyTrial(req.params.id, days, adminSub(req));
      res.json({ ok: true, trialEndsAt: row.trial_ends_at });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/subscription-extend", async (req, res) => {
    try {
      const days = req.body?.days;
      const row = await adminExtendSubscription(req.params.id, days, adminSub(req));
      res.json({ ok: true, subscriptionEndsAt: row.subscription_ends_at });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/suspend", async (req, res) => {
    try {
      const suspended = !!req.body?.suspended;
      await adminSuspendUser(req.params.id, suspended, adminSub(req));
      res.json({ ok: true, suspended });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.delete("/users/:id", async (req, res) => {
    try {
      await adminDeleteUser(req.params.id, adminSub(req));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/reset-password", async (req, res) => {
    try {
      const newPassword = req.body?.newPassword;
      await adminResetPassword(req.params.id, newPassword, adminSub(req));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/generation-credits", async (req, res) => {
    try {
      const delta = req.body?.delta;
      const balance = await adminAddGenerationCredits(req.params.id, delta, adminSub(req));
      res.json({ ok: true, generationCredits: balance });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/apply-free-generation", async (req, res) => {
    try {
      const count = req.body?.count ?? 1;
      const n = Math.max(1, Math.min(100, Number(count) || 1));
      const balance = await adminAddGenerationCredits(req.params.id, n, adminSub(req));
      await logAdminAction(adminSub(req), "apply_free_generation", Number(req.params.id), { count: n });
      res.json({ ok: true, generationCredits: balance });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/refund-generation-credit", async (req, res) => {
    try {
      const balance = await adminAddGenerationCredits(req.params.id, 1, adminSub(req));
      await logAdminAction(adminSub(req), "refund_generation_credit", Number(req.params.id), {});
      res.json({ ok: true, generationCredits: balance });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/users/:id/force-logout", async (req, res) => {
    try {
      const v = await adminIncrementAuthToken(req.params.id, adminSub(req));
      res.json({ ok: true, authTokenVersion: v });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.get("/generations/active", async (_req, res) => {
    try {
      const rows = await adminListGeneratingScripts(200);
      res.json({ scripts: rows });
    } catch (e) {
      console.error("GET /admin/generations/active:", e);
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/generations/failed", async (req, res) => {
    try {
      const limit = req.query.limit;
      const rows = await adminListFailedScripts(limit);
      res.json({ scripts: rows });
    } catch (e) {
      console.error("GET /admin/generations/failed:", e);
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.post("/generations/:scriptId/cancel", async (req, res) => {
    try {
      const reason = req.body?.reason || "Cancelled by administrator.";
      const row = await adminMarkScriptFailedAnyUser(req.params.scriptId, reason);
      if (!row) return res.status(404).json({ error: "script not found" });
      await logAdminAction(adminSub(req), "cancel_generation", row.user_id, { scriptId: req.params.scriptId });
      res.json({ ok: true, scriptId: row.id, userId: row.user_id });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.get("/financial/revenue", async (req, res) => {
    try {
      const from = req.query.from || null;
      const to = req.query.to || null;
      const byTier = await adminRevenueByTier(from, to);
      const total = await adminTotalRevenueCents(from, to);
      res.json({
        byTier,
        totalRevenueCents: total,
        note: "Revenue rows are manual ledger entries (type revenue) until payment integration.",
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/financial/churn", async (_req, res) => {
    try {
      const proxy = await adminChurnActivityProxy();
      res.json(proxy);
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/financial/subscriptions", async (_req, res) => {
    try {
      const data = await adminSubscriptionsByTier();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/financial/invoices", async (_req, res) => {
    try {
      const rows = await adminOutstandingInvoices();
      res.json({ invoices: rows, note: "Ledger rows with entry_type=invoice and status=open." });
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.post("/financial/manual-refund", async (req, res) => {
    try {
      const userId = req.body?.userId != null ? Number(req.body.userId) : null;
      const amountCents = Number(req.body?.amountCents);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return res.status(400).json({ error: "amountCents must be a positive number" });
      }
      const description = String(req.body?.description || "Manual refund");
      const row = await adminInsertLedgerRow({
        userId,
        entryType: "refund",
        amountCents: -Math.abs(Math.trunc(amountCents)),
        tierSlug: req.body?.tierSlug || null,
        description,
        status: "recorded",
        reference: req.body?.reference || null,
        createdByAdminId: adminSub(req),
      });
      await logAdminAction(adminSub(req), "manual_refund", userId, { amountCents, id: row.id });
      res.json({ ok: true, ledger: row });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/financial/record-revenue", async (req, res) => {
    try {
      const userId = req.body?.userId != null ? Number(req.body.userId) : null;
      const amountCents = Number(req.body?.amountCents);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return res.status(400).json({ error: "amountCents must be positive" });
      }
      const row = await adminInsertLedgerRow({
        userId,
        entryType: "revenue",
        amountCents: Math.trunc(amountCents),
        tierSlug: req.body?.tierSlug || null,
        description: String(req.body?.description || "Recorded revenue"),
        status: "recorded",
        reference: req.body?.reference || null,
        createdByAdminId: adminSub(req),
      });
      await logAdminAction(adminSub(req), "record_revenue", userId, { amountCents: row.amount_cents });
      res.json({ ok: true, ledger: row });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.post("/financial/invoice", async (req, res) => {
    try {
      const userId = Number(req.body?.userId);
      const amountCents = Number(req.body?.amountCents);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: "userId required" });
      if (!Number.isFinite(amountCents) || amountCents === 0) {
        return res.status(400).json({ error: "amountCents required" });
      }
      const row = await adminInsertLedgerRow({
        userId,
        entryType: "invoice",
        amountCents: Math.trunc(amountCents),
        tierSlug: req.body?.tierSlug || null,
        description: String(req.body?.description || "Invoice"),
        status: "open",
        reference: req.body?.reference || null,
        createdByAdminId: adminSub(req),
      });
      res.json({ ok: true, ledger: row });
    } catch (e) {
      res.status(400).json({ error: e.message || "failed" });
    }
  });

  router.get("/analytics/genres", async (_req, res) => {
    try {
      const genres = await adminGenreUsageStats();
      res.json({ genres });
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/analytics/conversion", async (_req, res) => {
    try {
      const data = await adminConversionTrialToPaid();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/analytics/retention", async (_req, res) => {
    try {
      const data = await adminRetentionByTier();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  router.get("/health", async (_req, res) => {
    try {
      const data = await adminHealthStats();
      const revenueMonth = await adminTotalRevenueCents(
        new Date(Date.now() - 30 * 86400000).toISOString(),
        null
      );
      data.estimatedRevenueLast30dCents = revenueMonth;
      if (data.openaiSpendCentsMonthlyEstimate != null) {
        data.spendVsRevenueHint =
          revenueMonth > 0
            ? `Rough margin (30d revenue vs env cost est.): ${revenueMonth - data.openaiSpendCentsMonthlyEstimate} cents`
            : "Add revenue via Record revenue or ledger — payment not wired yet.";
      }
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || "failed" });
    }
  });

  return router;
}