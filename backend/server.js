/**
 * Backend for vertical script generator.
 * Load .env from project root; expects OPENAI_API_KEY and optional OPENAI_FINETUNED_MODEL.
 */
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import OpenAI from "openai";
import Stripe from "stripe";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getSeriesNames } from "./nameEngine.js";
import { generateLogline, SUPPORTED_GENRES } from "./loglineEngine.js";
import {
  updateCharacterNameRegistryFromEpisode,
  normalizeEpisodeCharacterNames,
  loadCharacterNameRegistry,
} from "./characterNameRegistry.js";
import { fixMergedWordIssuesPhase2, fixMergedWordIssuesPhase2Detailed } from "./mergedWordsFix.js";
import { auditMergedWords } from "./mergedWordsAudit.js";
import { initDb, getPool } from "./db.js";
import { loginUser, registerUser, requireAuth, verifyEmailCode, isJwtAuthEnabled } from "./auth.js";
import {
  getUserPlanRow,
  setUserPlanTierByUserId,
  PLAN_TIERS,
  assertValidPlanTier,
} from "./userPlan.js";
import {
  createGeneratingScript,
  updateScriptProgress,
  markScriptFailed,
  markScriptComplete,
  getScriptForUser,
  listScriptsForUser,
  deleteScriptForUser,
  refundCreditForScriptIfEligible,
  markInterruptedGeneratingScripts,
  countGeneratingScriptsForUser,
  MAX_CONCURRENT_GENERATIONS_PER_USER,
} from "./scriptsStore.js";
import { loadDynamicMergePatterns } from "./mergePatternRegistry.js";
import {
  structuralOpeningGateThreshold,
  tagEpisodeEvents,
  passesBasicFormatCheck,
  hasQualityCollapse,
  hasSentenceLevelMerges,
  extractOpeningFingerprint,
  findMostSimilarPriorOpening,
  detectDuplicateEpisodes,
  measureRepetitionAgainstRecent,
  buildNameAnchors,
  lineHasCollapseLexicon,
  measureVerticalEpisodeLengthBudget,
} from "./episodeGatesCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
dotenv.config({ path: join(rootDir, ".env") });

const CHARACTER_NAME_REGISTRY_PATH = join(
  rootDir,
  "character-name-registry.json"
);
const DYNAMIC_MERGE_PATTERNS_PATH = join(
  rootDir,
  "backend",
  "merging_audit",
  "dynamic-merge-patterns-promoted.json"
);

const app = express();
const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
// Stripe webhooks must receive the raw body for signature verification.
app.post("/vsinfinite/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const secretKey = process.env.STRIPE_SECRET_KEY || null;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;
  if (!secretKey || !webhookSecret) {
    return res.status(503).send("Stripe is not configured");
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
  const sig = String(req.headers["stripe-signature"] || "");
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (e) {
    return res.status(400).send(`Webhook signature verification failed.`);
  }

  // Idempotency: store Stripe event id (Stripe retries deliveries).
  let isNewEvent = false;
  try {
    const pool = getPool();
    const ins = await pool.query(
      `INSERT INTO stripe_webhook_events (id, type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [evt.id, evt.type, JSON.stringify(evt)]
    );
    isNewEvent = ins.rowCount > 0;
  } catch (e) {
    // If the DB is down, fail the webhook so Stripe retries instead of silently losing grants.
    console.error("[stripe] store event failed:", e);
    return res.status(503).send("Temporary error");
  }
  if (!isNewEvent) return res.status(200).json({ received: true, duplicate: true });

  const pool = getPool();

  function assertPlanTier(t) {
    const allowed = new Set(["free", "starter", "professional", "business"]);
    const x = String(t || "").trim().toLowerCase();
    return allowed.has(x) ? x : null;
  }

  try {
    if (evt.type === "checkout.session.completed") {
      const session = evt.data?.object;
      const mode = String(session?.mode || "");
      const paid = String(session?.payment_status || "") === "paid";
      if (mode === "payment" && paid) {
        const email = String(session?.metadata?.userEmail || session?.customer_details?.email || "")
          .trim()
          .toLowerCase();
        const credits = Math.trunc(Number(session?.metadata?.scriptCredits || session?.metadata?.credits));
        if (email && Number.isFinite(credits) && credits !== 0) {
          await pool.query(
            `UPDATE users SET script_credits = GREATEST(0, script_credits + $2::integer)
             WHERE lower(trim(email)) = $1`,
            [email, credits]
          );
        } else {
          console.warn("[stripe] checkout.session.completed missing userEmail or credits metadata", {
            id: session?.id,
          });
        }
      }
      if (mode === "subscription" && paid) {
        const uid = Math.trunc(Number(session?.metadata?.userId));
        const tier = assertPlanTier(session?.metadata?.planTier);
        const cust = session?.customer != null ? String(session.customer) : null;
        const subId = session?.subscription != null ? String(session.subscription) : null;
        if (Number.isFinite(uid) && uid > 0 && tier) {
          await pool.query(
            `UPDATE users SET
               plan_tier = $2,
               stripe_customer_id = COALESCE($3, stripe_customer_id),
               stripe_subscription_id = COALESCE($4, stripe_subscription_id),
               subscription_cancel_at_period_end = FALSE
             WHERE id = $1`,
            [uid, tier, cust, subId]
          );
        } else {
          console.warn("[stripe] checkout.session.completed subscription missing userId/planTier", {
            id: session?.id,
          });
        }
      }
    }

    if (evt.type === "invoice.paid") {
      const inv = evt.data?.object;
      const subRef = inv?.subscription;
      if (!subRef) {
        /* one-off invoice, not subscription */
      } else {
        const br = String(inv?.billing_reason || "");
        if (br === "subscription_create" || br === "subscription_cycle") {
          const sub = await stripe.subscriptions.retrieve(String(subRef));
          const md = sub?.metadata || {};
          const uid = Math.trunc(Number(md.userId));
          const credits = Math.trunc(Number(md.monthlyCredits));
          const tier = assertPlanTier(md.planTier);
          const amt = Number(inv?.amount_paid ?? 0);
          if (Number.isFinite(uid) && uid > 0 && tier && Number.isFinite(credits) && credits > 0 && amt > 0) {
            await pool.query(
              `UPDATE users SET
                 plan_tier = $2,
                 script_credits = GREATEST(0, script_credits + $3::integer),
                 stripe_customer_id = COALESCE($4, stripe_customer_id),
                 stripe_subscription_id = COALESCE($5, stripe_subscription_id),
                 subscription_cancel_at_period_end = $6,
                 subscription_current_period_end = to_timestamp($7::double precision)
               WHERE id = $1`,
              [
                uid,
                tier,
                credits,
                inv?.customer != null ? String(inv.customer) : null,
                String(subRef),
                !!sub.cancel_at_period_end,
                Number(sub.current_period_end) || 0,
              ]
            );
          } else {
            console.warn("[stripe] invoice.paid subscription missing metadata or zero payment", {
              invoice: inv?.id,
              uid,
              tier,
              credits,
              amt,
            });
          }
        }
      }
    }

    if (evt.type === "customer.subscription.updated") {
      const sub = evt.data?.object;
      const uid = Math.trunc(Number(sub?.metadata?.userId));
      const cpe = Number(sub?.current_period_end);
      if (Number.isFinite(uid) && uid > 0 && Number.isFinite(cpe) && cpe > 0) {
        await pool.query(
          `UPDATE users SET
             subscription_cancel_at_period_end = $2,
             subscription_current_period_end = to_timestamp($3::double precision)
           WHERE id = $1`,
          [uid, !!sub.cancel_at_period_end, cpe]
        );
      }
    }

    if (evt.type === "customer.subscription.deleted") {
      const sub = evt.data?.object;
      const uid = Math.trunc(Number(sub?.metadata?.userId));
      if (Number.isFinite(uid) && uid > 0) {
        await pool.query(
          `UPDATE users SET
             plan_tier = 'free',
             stripe_subscription_id = NULL,
             subscription_cancel_at_period_end = FALSE,
             subscription_current_period_end = NULL
           WHERE id = $1`,
          [uid]
        );
      }
    }
  } catch (e) {
    console.error("[stripe] handler failed:", e);
    // Return 500 so Stripe retries; idempotency table prevents double grants.
    return res.status(500).send("Webhook handler error");
  }

  return res.status(200).json({ received: true });
});
// Translation endpoint may receive the full English script in one request.
// Increase body limit to avoid HTTP 413 on larger seasons.
app.use(express.json({ limit: "20mb" }));

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    console.warn(`[stripe] Could not parse ${name} as JSON`);
    return fallback;
  }
}

function getPublicBaseUrl(req) {
  const envUrl = String(process.env.PUBLIC_APP_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const origin = String(req.headers.origin || "").trim();
  if (origin) return origin.replace(/\/+$/, "");
  return "";
}

/** Create a Stripe Checkout Session and return { url }. */
app.post("/vsinfinite/stripe/create-checkout-session", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "JWT auth is not enabled on this server." });
  }
  const secretKey = process.env.STRIPE_SECRET_KEY || null;
  if (!secretKey) return res.status(503).json({ error: "Stripe is not configured." });

  const uid = Number(req.auth?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "Unauthorized" });
  const me = await getUserPlanRow(uid);
  if (!me?.email) return res.status(404).json({ error: "user not found" });

  const body = req.body || {};
  const pack = String(body.pack || "").trim();
  const providedPriceId = String(body.priceId || body.price_id || "").trim();
  const kind = String(body.kind || "").trim().toLowerCase(); // "payment" | "subscription"

  const packToPrice = parseJsonEnv("STRIPE_PACK_PRICE_MAP_JSON", {});
  const priceToCredits = parseJsonEnv("STRIPE_PRICE_CREDITS_MAP_JSON", {});
  const subPackMap = parseJsonEnv("STRIPE_SUBSCRIPTION_PACK_MAP_JSON", {});
  const priceToSubDetails = parseJsonEnv("STRIPE_SUBSCRIPTION_PRICE_DETAILS_JSON", {});

  const mode = kind === "subscription" ? "subscription" : "payment";

  let priceId = providedPriceId;
  let subPlanTier = "";
  let subMonthlyCredits = 0;

  if (mode === "subscription") {
    if (priceId) {
      const det = priceToSubDetails[priceId];
      if (det) {
        subPlanTier = String(det.planTier || "");
        subMonthlyCredits = Math.trunc(Number(det.monthlyCredits));
      }
    } else if (pack && subPackMap[pack]) {
      const spec = subPackMap[pack];
      priceId = String(spec.price || spec.priceId || "");
      subPlanTier = String(spec.planTier || "");
      subMonthlyCredits = Math.trunc(Number(spec.monthlyCredits));
    } else {
      priceId = pack ? String(packToPrice[pack] || "") : "";
      const det = priceId ? priceToSubDetails[priceId] : null;
      if (det) {
        subPlanTier = String(det.planTier || "");
        subMonthlyCredits = Math.trunc(Number(det.monthlyCredits));
      }
    }
  } else {
    priceId = providedPriceId || (pack ? String(packToPrice[pack] || "") : "");
  }

  if (!priceId || !/^price_/.test(priceId)) {
    return res.status(400).json({ error: "Unknown or missing priceId/pack." });
  }

  if (mode === "subscription") {
    const tierOk = /^(starter|professional|business)$/.test(String(subPlanTier).toLowerCase());
    if (!tierOk || !Number.isFinite(subMonthlyCredits) || subMonthlyCredits <= 0) {
      return res.status(503).json({
        error:
          "Subscription pack misconfigured. Set STRIPE_SUBSCRIPTION_PACK_MAP_JSON (or STRIPE_SUBSCRIPTION_PRICE_DETAILS_JSON for each price).",
      });
    }
  }

  const allowedPrices = String(process.env.STRIPE_ALLOWED_PRICE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedPrices.length && !allowedPrices.includes(priceId)) {
    return res.status(400).json({ error: "priceId is not allowed." });
  }

  const publicBase = getPublicBaseUrl(req);
  const successUrl =
    String(process.env.STRIPE_SUCCESS_URL || "").trim() ||
    (publicBase ? `${publicBase}/?stripe=success` : "");
  const cancelUrl =
    String(process.env.STRIPE_CANCEL_URL || "").trim() ||
    (publicBase ? `${publicBase}/?stripe=cancel` : "");
  if (!successUrl || !cancelUrl) {
    return res.status(503).json({
      error: "Missing PUBLIC_APP_URL (or STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL).",
    });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

  const creditsForPrice = Math.trunc(Number(priceToCredits?.[priceId]));
  const metadata = {
    userId: String(uid),
    userEmail: String(me.email).trim().toLowerCase(),
    // For one-time packs we grant via webhook metadata.scriptCredits
    scriptCredits:
      mode === "payment" && Number.isFinite(creditsForPrice) ? String(creditsForPrice) : "",
    pack: pack || "",
    priceId,
    planTier: mode === "subscription" ? String(subPlanTier).toLowerCase() : "",
    monthlyCredits: mode === "subscription" ? String(subMonthlyCredits) : "",
  };

  if (mode === "payment") {
    if (!metadata.scriptCredits) {
      return res.status(503).json({
        error:
          "Credits mapping missing for this priceId. Set STRIPE_PRICE_CREDITS_MAP_JSON on the server.",
      });
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      customer_email: metadata.userEmail,
      subscription_data:
        mode === "subscription"
          ? {
              metadata: {
                userId: metadata.userId,
                userEmail: metadata.userEmail,
                planTier: metadata.planTier,
                monthlyCredits: metadata.monthlyCredits,
                pack: metadata.pack,
                priceId: metadata.priceId,
              },
            }
          : undefined,
    });
    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error("[stripe] create checkout session failed:", e);
    return res.status(500).json({ error: "Failed to create Stripe Checkout Session." });
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FINETUNED_MODEL =
  process.env.OPENAI_FINETUNED_MODEL ||
  "ft:gpt-4.1-mini-2025-04-14:personal:vertical-genre:DJdSjUra";
const PLANNER_MODEL =
  process.env.OPENAI_PLANNER_MODEL || "gpt-4.1-mini";
const RECAP_MODEL =
  process.env.OPENAI_RECAP_MODEL || PLANNER_MODEL;
/** Model for EN→ZH screenplay translation (defaults to planner; not the fine-tuned writer). */
const TRANSLATION_MODEL =
  process.env.OPENAI_TRANSLATION_MODEL || PLANNER_MODEL;

/** General-purpose generator model — used for main episode generation instead of the fine-tuned
 *  model to avoid overfitting loops. Fine-tuned model acts as style advisor and corrective passer. */
const GENERATOR_MODEL =
  process.env.OPENAI_GENERATOR_MODEL || "gpt-4.1";

const NAME_VALIDATION_MODEL =
  process.env.OPENAI_NAME_VALIDATION_MODEL || PLANNER_MODEL;
const GENERATION_MODE = String(process.env.GENERATION_MODE || "two_pass").trim().toLowerCase();
const ENABLE_TWO_PASS_EPISODE = GENERATION_MODE === "two_pass";
/** Single-pass main writer (GENERATOR_MODEL): capped temp ≤ 0.7 to reduce drift vs two-pass render (~0.45). */
const PRIMARY_EPISODE_TEMPERATURE = Math.min(
  0.7,
  Math.max(0.1, parseFloat(process.env.PRIMARY_EPISODE_TEMPERATURE || "0.6") || 0.6)
);

/**
 * Soft per-episode length budget (English body text).
 * Calibration: prior output ran ~215 EN pages / 60 eps (~3.3k chars/ep, ~920 chars/page).
 * Regular episodes target ~1,650 chars. ESTABLISHING episodes (1–N) get a larger budget so the
 * protagonist's world, backstory, and an electric opening have room to breathe — Phase A fixes the
 * quality regression caused by a uniform, too-tight budget. Tune via EPISODE_TARGET_CHARS /
 * ESTABLISHING_EPISODES / ESTABLISHING_LENGTH_MULTIPLIER.
 */
const EPISODE_TARGET_CHARS = Math.max(
  900,
  Math.min(6000, parseInt(process.env.EPISODE_TARGET_CHARS || "1650", 10) || 1650)
);
const EPISODE_HARD_MAX_CHARS = Math.round(EPISODE_TARGET_CHARS * 1.15);
const EPISODE_TARGET_WORDS_LOW = Math.round((EPISODE_TARGET_CHARS / 6.2) * 0.9);
const EPISODE_TARGET_WORDS_HIGH = Math.round((EPISODE_TARGET_CHARS / 6.2) * 1.1);

/** Early episodes that establish the world + protagonist backstory get extra room. */
const ESTABLISHING_EPISODES = Math.max(
  0,
  Math.min(6, parseInt(process.env.ESTABLISHING_EPISODES || "3", 10) || 3)
);
const ESTABLISHING_LENGTH_MULTIPLIER = Math.max(
  1,
  Math.min(2.5, parseFloat(process.env.ESTABLISHING_LENGTH_MULTIPLIER || "1.6") || 1.6)
);

const PRIMARY_EPISODE_MAX_TOKENS = (() => {
  const fromEnv = parseInt(process.env.PRIMARY_EPISODE_MAX_TOKENS || "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.max(768, Math.min(4096, fromEnv));
  }
  // ~2 chars/token for formatted screenplay text — soft cap aligned with hard char budget.
  return Math.max(768, Math.min(4096, Math.round(EPISODE_HARD_MAX_CHARS / 2)));
})();

/** Per-episode length plan: establishing episodes get a larger char budget + token cap. */
function getEpisodeLengthPlan(ep, total) {
  const isEstablishing = ep <= ESTABLISHING_EPISODES;
  const mult = isEstablishing ? ESTABLISHING_LENGTH_MULTIPLIER : 1;
  const targetChars = Math.round(EPISODE_TARGET_CHARS * mult);
  const hardMaxChars = Math.round(targetChars * 1.15);
  const wordsLow = Math.round((targetChars / 6.2) * 0.9);
  const wordsHigh = Math.round((targetChars / 6.2) * 1.1);
  const maxTokens = Math.max(
    768,
    Math.min(4096, Math.round(PRIMARY_EPISODE_MAX_TOKENS * mult))
  );
  return { ep, total, isEstablishing, targetChars, hardMaxChars, wordsLow, wordsHigh, maxTokens };
}

/**
 * Generic pacing/quality principles (no per-episode numbers) for shared system prompts.
 * Per-episode budgets + opening/backstory specifics are injected via the user prompt.
 */
const EPISODE_QUALITY_DIRECTIVE =
  `PACING & QUALITY (vertical drama — tight but vivid, never thin):\n` +
  `- Keep scenes lean, but NEVER sacrifice context, character clarity, or concrete grounding to save space. The audience must always know who we are with, where we are, and what just changed.\n` +
  `- Cut only true filler and literal repetition — do NOT strip backstory, world detail, motive, or vivid specificity.\n` +
  `- OPEN ELECTRIC: the first moment of every episode must be charged and specific (conflict, danger, desire, humiliation, or a shock). Never open on a neutral, context-free chore.\n` +
  `- Deliver at least one CONCRETE new development each episode (a reveal, reversal, escalation, or a real shift in the relationships). Never substitute vague restated menace ("someone is watching", "the threat is closer") for an actual plot beat.`;

/** Per-episode length directive (numbers tailored to establishing vs regular episodes). */
function buildEpisodeLengthDirective(ep, total) {
  const plan = getEpisodeLengthPlan(ep, total);
  const lines = [
    `LENGTH & DENSITY BUDGET (vertical pacing — tight but vivid):`,
    `- Aim for about ${plan.wordsLow}–${plan.wordsHigh} words (~${plan.targetChars} characters); hard maximum ~${plan.hardMaxChars} characters.`,
    `- Use ${plan.isEstablishing ? "3–4" : "2–3"} focused scenes.`,
    `- Cut ONLY true filler: a beat already shown, or vague restated tension when nothing concrete changes. Keep all grounding, motive, and world detail.`,
  ];
  if (plan.isEstablishing) {
    lines.push(
      `- This is an ESTABLISHING episode — spend the extra room to ground the heroine's world and reveal backstory (see the OPENING and BACKSTORY requirements).`
    );
  }
  return lines.join("\n");
}

/** Per-episode electric-opening directive. */
function buildOpeningDirective(ep, total) {
  const isEstablishing = ep <= ESTABLISHING_EPISODES;
  const lines = [
    `ELECTRIC OPENING (the most important 5 seconds — do NOT open flat or context-free):`,
    `- Drop us into a charged, specific moment with immediate stakes — conflict, danger, desire, humiliation, or a shock. NOT a neutral chore (e.g. tidying, walking, generic prep).`,
    `- Within the first few lines the viewer must grasp WHO the heroine is in this moment and WHAT is at stake — ground us fast, no vague menace.`,
    `- The first line of action or dialogue should hit hard enough that stopping the video feels impossible.`,
  ];
  if (isEstablishing) {
    lines.push(
      `- Because this is an early episode, the opening must also quickly convey the heroine's ordinary world and her core wound or desire so the audience bonds with her immediately.`
    );
  }
  return lines.join("\n");
}

/** Backstory mandate for establishing episodes (empty for later episodes). */
function buildBackstoryDirective(ep) {
  if (ep > ESTABLISHING_EPISODES) return "";
  return [
    `PROTAGONIST BACKSTORY (establishing episodes 1–${ESTABLISHING_EPISODES}):`,
    `- Reveal concrete, specific backstory for the heroine through action and dialogue (never a narrated info-dump): her history, what she lost or wants, why she is in this situation, and the wound that drives her.`,
    `- Draw directly from the PROTAGONIST STORY BIBLE and the backstory reveal ladder above when they are provided — honor any "BACKSTORY TO REVEAL THIS EPISODE" item.`,
    `- Make her point of view and emotional stakes unmistakable so the audience is invested early.`,
  ].join("\n");
}

/**
 * Phase 2 — soft length gate. When prompts (Phase 1) fail to keep an episode under the hard
 * char budget, condense it with a bounded rewrite loop before recap/persist. Distinct from the
 * runaway collapse gate (EPISODE_MAX_CHARS ~24k): this targets normal-but-overlong episodes.
 */
const ENABLE_EPISODE_LENGTH_TRIM =
  String(process.env.ENABLE_EPISODE_LENGTH_TRIM ?? "true").trim().toLowerCase() !== "false";
const MAX_LENGTH_TRIM_ATTEMPTS = Math.max(
  1,
  Math.min(3, parseInt(process.env.MAX_LENGTH_TRIM_ATTEMPTS || "1", 10) || 1)
);

/**
 * Phase D — Script Doctor. After a draft clears all structural/quality/repetition gates, score it
 * against a craft rubric (hook strength, concrete escalation, voice, backstory progress). If it
 * falls below the threshold, do ONE bounded punch-up rewrite that improves only the weak areas
 * while preserving plot, names, format, and the cliffhanger. Off → behaves exactly as before.
 */
const ENABLE_SCRIPT_DOCTOR =
  String(process.env.ENABLE_SCRIPT_DOCTOR ?? "true").trim().toLowerCase() !== "false";
const SCRIPT_DOCTOR_MIN_SCORE = Math.max(
  1,
  Math.min(5, parseInt(process.env.SCRIPT_DOCTOR_MIN_SCORE || "4", 10) || 4)
);
const MAX_SCRIPT_DOCTOR_REWRITES = Math.max(
  1,
  Math.min(2, parseInt(process.env.MAX_SCRIPT_DOCTOR_REWRITES || "1", 10) || 1)
);
const ENABLE_TRIMMED_CONTEXT =
  String(process.env.ENABLE_TRIMMED_CONTEXT || "true").trim().toLowerCase() !== "false";
const CONTEXT_TAIL_LINES = Math.max(
  8,
  Math.min(40, parseInt(process.env.CONTEXT_TAIL_LINES || "14", 10) || 14)
);
const ANCHOR_ENFORCEMENT_MODE = String(process.env.ANCHOR_ENFORCEMENT_MODE || "warn")
  .trim()
  .toLowerCase(); // off | warn | enforce

/** Opening-chunk embeddings vs prior episodes (semantic nearness beyond lexical repetition). */
const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const ENABLE_EPISODE_EMBEDDING_GATE =
  String(process.env.ENABLE_EPISODE_EMBEDDING_GATE || "true").trim().toLowerCase() !== "false";
const EMBEDDING_SIMILARITY_THRESHOLD = Math.min(
  0.995,
  Math.max(0.5, parseFloat(process.env.EMBEDDING_SIMILARITY_THRESHOLD || "0.88") || 0.88)
);
const EMBEDDING_CHUNK_CHARS = Math.max(
  400,
  Math.min(8000, parseInt(process.env.EMBEDDING_CHUNK_CHARS || "2000", 10) || 2000)
);

/** Aligned with detectDuplicateEpisodes STRUCTURAL_FLAG (0.7) — opening fingerprint vs prior episodes. */
const STRUCTURAL_OPENING_GATE_THRESHOLD = structuralOpeningGateThreshold();

/** Bounded regen loops — verify trigger cleared after each attempt. */
const MAX_REPETITION_REGEN_ATTEMPTS = Math.max(
  1,
  Math.min(6, parseInt(process.env.MAX_REPETITION_REGEN_ATTEMPTS || "3", 10) || 3)
);
const MAX_MERGED_WORD_REGEN_ATTEMPTS = Math.max(
  1,
  Math.min(6, parseInt(process.env.MAX_MERGED_WORD_REGEN_ATTEMPTS || "3", 10) || 3)
);
const MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS = Math.max(
  1,
  Math.min(6, parseInt(process.env.MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS || "3", 10) || 3)
);

const ENABLE_PLOT_CONTRACT_GATE =
  String(process.env.ENABLE_PLOT_CONTRACT_GATE || "true").trim().toLowerCase() !== "false";
const MAX_PLOT_CONTRACT_REGEN_ATTEMPTS = Math.max(
  1,
  Math.min(5, parseInt(process.env.MAX_PLOT_CONTRACT_REGEN_ATTEMPTS || "2", 10) || 2)
);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  // Do not hard-exit: allow the server to start for auth + other non-OpenAI routes.
  // Endpoints that call OpenAI will fail later with a clear error.
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || "",
  // Allow slower responses on free Render / high latency routes
  timeout: 600_000, // 10 minutes in milliseconds
  maxRetries: 2,
});
const DYNAMIC_MERGE_PATTERNS = loadDynamicMergePatterns(DYNAMIC_MERGE_PATTERNS_PATH);
if (DYNAMIC_MERGE_PATTERNS.length) {
  console.log(
    `Loaded ${DYNAMIC_MERGE_PATTERNS.length} dynamic merge patterns from ${DYNAMIC_MERGE_PATTERNS_PATH}`
  );
}

// ---------------------------------------------------------------------------
// Genre logline normalization ("custom summary" hardening)
// ---------------------------------------------------------------------------

const GENRE_LOGLINE_NORMALIZER_SYSTEM_PROMPT = `You are a development exec for vertical, romance-forward serialized dramas.

You will receive:
- genre
- three main character names (heroine, male1=cold lead, male2=warm lead)
- a user-provided premise

Goal: rewrite the premise into a tight vertical-series "genre bible" that makes long multi-episode generation stable:
- Keep the SAME three main characters only as protagonists (heroine + two male leads). Never replace them.
- Lock the story to ONE primary setting hub so the series cannot drift into unrelated locations unless the premise explicitly demands it.
- Make stakes and the central obstacle/threat explicit.
- Provide 2–4 simple RULES/CONSTRAINTS that remain true across episodes (these prevent narrative drift).
- Keep romance/power dynamics central for vertical pacing.

Genre guidance:
- Horror: define a clear THREAT, rules of the threat, and escalation stakes; prioritize dread/atmosphere over action-gore.
- Crime: define the crime/secret, the pressure source, and rules about evidence/blackmail/legal risk.
- Fantasy/Sci-Fi/Superhero: define the power system in 1 sentence + rules/limits; avoid inventing new magic/tech every episode.
- Drama/Romance: define the social stakes (family/company/reputation) + rules (e.g. contract marriage, hidden identity).
- Monster/Werewolf: define the creature/pack hierarchy + rules and consequences.

Output ONLY valid JSON:
{
  "logline": "1–2 sentences",
  "setting_hub": "short phrase",
  "stakes": "1 sentence",
  "central_obstacle": "1 sentence",
  "threat": "optional; 1 sentence (use for Horror/Monster/Werewolf if relevant)",
  "rules": ["rule 1", "rule 2", "rule 3"]
}`;

async function normalizeGenreLogline({ rawLogline, genre, names }) {
  const clean = safeStr(rawLogline).slice(0, 1500);
  if (!clean) return null;
  const payload = {
    genre: safeStr(genre) || "Romance",
    heroine: names?.heroine || null,
    male1: names?.coldCeo || null,
    male2: names?.warmFriend || null,
    premise: clean,
  };
  const completion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: GENRE_LOGLINE_NORMALIZER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    max_tokens: 450,
    temperature: 0.25,
  });
  const rawContent = completion.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const parsed = JSON.parse(objMatch[0]);
    if (!parsed || typeof parsed.logline !== "string" || !parsed.logline.trim()) return null;
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.map((r) => safeStr(r)).filter(Boolean).slice(0, 4)
      : [];
    return {
      logline: parsed.logline.trim().slice(0, 1500),
      setting_hub:
        typeof parsed.setting_hub === "string"
          ? parsed.setting_hub.trim().slice(0, 140)
          : "",
      stakes: typeof parsed.stakes === "string" ? parsed.stakes.trim().slice(0, 350) : "",
      central_obstacle:
        typeof parsed.central_obstacle === "string"
          ? parsed.central_obstacle.trim().slice(0, 350)
          : "",
      threat: typeof parsed.threat === "string" ? parsed.threat.trim().slice(0, 350) : "",
      rules,
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name engine: mix-and-match first/last + family names (see nameEngine.js)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 1: Season blueprint schema and prompts (used in Phase 2 for one-shot outline)
// ---------------------------------------------------------------------------
//
// SeasonBlueprint = {
//   series_title: string,
//   heroine: string,
//   male1: string,
//   male2: string,
//   genre: "WEREWOLF" | "NON_WEREWOLF",
//   episodes: EpisodePlan[]
// }
//
// EpisodePlan = {
//   episode: number,
//   arc_phase: "hook" | "escalation" | "turning_point" | "endgame" | "finale",
//   title: string,
//   setting_focus: string,
//   emotional_focus: string,
//   heroine_state: string,
//   male1_state: string,
//   male2_state: string,
//   main_conflict: string,
//   key_events: string[],
//   twist_or_reveal: string,
//   cliffhanger_type: string,
//   cliffhanger: string
// }
//
// Arc ranges for 60 episodes: hook 1-5, escalation 6-20, turning_point 21-40, endgame 41-55, finale 56-60.

const BLUEPRINT_ARC_RANGES = Object.freeze({
  hook: [1, 5],
  escalation: [6, 20],
  turning_point: [21, 40],
  endgame: [41, 55],
  finale: [56, 60],
});

function getArcPhaseForEpisode(ep, total = 60) {
  if (ep <= 0) return "hook";
  const n = Math.min(ep, total);
  if (n <= 5) return "hook";
  if (n <= 20) return "escalation";
  if (n <= 40) return "turning_point";
  if (n <= 55) return "endgame";
  return "finale";
}

const BLUEPRINT_SYSTEM_PROMPT = `You are a season planner for female-led vertical romance dramas.

The user will give you: language, genre (WEREWOLF or NON_WEREWOLF), total episode count (e.g. 60), the three main character names (heroine, cold male lead, warm male lead), and a short series logline.
They may also give you high-level trope controls.

You must output a single JSON object (no other text, no markdown) with this exact structure:

{
  "series_title": "A short title for the series",
  "heroine": "Full name as given",
  "male1": "Full name as given",
  "male2": "Full name as given",
  "genre": "WEREWOLF or NON_WEREWOLF",
  "tropes": {
    "romantic": ["..."],
    "conflict": ["..."],
    "supernatural": ["..."]
  },
  "characters": [
    {
      "name": "Heroine's full name",
      "role": "heroine_protagonist",
      "goal": "Her long-term season goal in one sentence (e.g., expose a conspiracy, save her family, escape a toxic marriage).",
      "traits": ["underdog", "resilient", "smart"],
      "taboos": ["becoming a villain", "suddenly forgetting her core values"]
    },
    {
      "name": "Cold male lead full name",
      "role": "cold_male_lead",
      "goal": "His long-term goal in one sentence.",
      "traits": ["powerful", "proud", "controlled"],
      "taboos": ["becoming pure comic relief", "changing profession mid-season without a planned turning point"]
    },
    {
      "name": "Warm male lead full name",
      "role": "warm_male_lead",
      "goal": "His long-term goal in one sentence.",
      "traits": ["protective", "patient", "loyal"],
      "taboos": ["becoming main villain", "randomly disappearing with no payoff"]
    }
  ],
  "protagonist_bible": {
    "wound": "The defining past hurt that shaped the heroine (1 sentence).",
    "ghost": "The specific past event or person that still haunts her (1 sentence).",
    "secret": "Something she actively hides from the world and/or the male leads (1 sentence).",
    "want": "Her conscious external goal this season (1 sentence) — should align with her character 'goal'.",
    "need": "What she actually needs to learn or heal internally to become whole (1 sentence).",
    "the_lie": "The false belief about herself or the world she must overcome by the finale (1 sentence).",
    "voice": "How she speaks and carries herself — 2-3 concrete, specific traits (not generic adjectives).",
    "backstory_beats": [
      { "beat": "A concrete backstory fact or memory, revealable through action/dialogue (never narration).", "reveal_by_episode": 2 },
      { "beat": "A deeper backstory revelation that recontextualizes who she is.", "reveal_by_episode": 8 },
      { "beat": "The deepest secret or origin, saved for maximum impact.", "reveal_by_episode": 22 }
    ]
  },
  "episodes": [
    {
      "episode": 1,
      "arc_phase": "hook",
      "title": "Episode title",
      "setting_focus": "school | office | family_mansion | hospital | banquet | werewolf_territory | other",
      "emotional_focus": "humiliation | yearning | betrayal | revenge | redemption | reunion",
      "heroine_state": "One sentence: where she is in life and with the men",
      "male1_state": "One sentence: cold lead's stance",
      "male2_state": "One sentence: warm lead's stance",
      "main_conflict": "One sentence: core conflict this episode",
      "key_events": ["Event 1", "Event 2", "Event 3"],
      "twist_or_reveal": "One sentence: twist or reveal",
      "shock_type": "reveal | reversal | betrayal | new_player | raised_stake | secret_exposed | alliance_shift | loss | ultimatum | other",
      "shock": "One concrete sentence: the single NEW escalation or development this episode delivers (a reveal, reversal, betrayal, new player, raised stake, etc.). Must be specific and must NOT repeat any other episode's shock. NEVER vague restated menace like 'someone is watching' or 'the threat is closer'.",
      "cliffhanger_type": "emotional | plot_twist | danger | reversal",
      "cliffhanger": "One sentence: how the episode ends to hook the next",
      "hook_type": "meet_cute | humiliation | danger | secret_overheard | other",
      "conflict_type": "family_pressure | money_business | social_status | secret_reveal | rival_scheme | romantic_tension | supernatural_danger | other",
      "unique_scene": "One concrete, never-before-seen scene specific to this episode only. Name the exact location, the characters present, and the single most important thing that happens. This scene MUST appear in the episode and MUST NOT repeat anything from prior episodes.",
      "micro_beats": [
        "Hook beat: 1 short sentence describing the opening emotional moment (0–5 seconds).",
        "Conflict beat: 1–2 short sentences describing the main conflict for this episode (5–30 seconds).",
        "Mini-twist beat: 1 short sentence describing a twist or shift in power/emotion near the end of the episode.",
        "Cliffhanger beat: 1 short sentence describing how the final lines end on a hook that points directly into the next episode."
      ]
    }
  ]
}


Trope control:
- The optional "tropes" object can contain three arrays of high-level tropes:
  - romantic: e.g. ["secret_billionaire", "contract_marriage", "childhood_sweethearts", "forbidden_love"]
  - conflict: e.g. ["hidden_heir", "corporate_war", "family_feud", "revenge_plot"]
  - supernatural: e.g. ["monster_awakening", "cursed_bloodline", "prophetic_dreams"]
- If tropes are provided, you MUST weave them through the whole season:
  - At least one romantic trope should show up clearly every 3–4 episodes.
  - At least one conflict trope should drive external stakes in each arc_phase.
  - Supernatural tropes (when present) should be introduced early, escalated in the middle, and paid off in the finale.

Season arc rules (macro-structure):
- Produce exactly one object per episode in order (episode 1 through the total given).
- arc_phase must follow the season arc: episodes 1–5 "hook" (setup), 6–20 "escalation", 21–40 "turning_point", 41–55 "endgame", 56–60 "finale".
- Same heroine and two male leads in every episode; their states evolve but names never change.
- Story must have a clear beginning, middle, and end across the full season; no resets.

Character role locking:
- You MUST include the "characters" array with exactly three entries (heroine, cold male lead, warm male lead) on every blueprint. Downstream script generation copies these into every episode prompt; omitting the array breaks cast consistency.
- The "characters" array must describe the heroine and the two main male leads using stable roles, goals, traits, and taboos.
- These roles MUST remain consistent across all episodes: do NOT turn the heroine into a villain, swap the cold/warm male leads' archetypes, or radically change professions/alignments unless the arc_phase and episode plan clearly mark a turning point.
- If a turning point changes a character’s alignment (e.g., warm lead betrays heroine), it must be foreshadowed and then stay consistent afterward; no random flip-flopping.

Protagonist Story Bible (backstory + reveal ladder) — REQUIRED:
- You MUST include the "protagonist_bible" object. It is the emotional engine of the season: the heroine's wound, ghost, secret, want vs. need, and the_lie she believes drive every choice she makes.
- "want" is the external goal she chases; "need" is the internal truth she must learn. The season arc is her slowly overcoming "the_lie" and moving from want toward need, culminating in the finale.
- "backstory_beats" is a REVEAL LADDER: 3 to 5 concrete backstory beats, ordered by "reveal_by_episode" ascending. Dole backstory out gradually through action and dialogue — NEVER dump it all at once.
  - At least one beat must land in episodes 1–3 (so the audience bonds with her early), at least one in the first third, and the deepest/origin secret should be saved for a later, high-impact episode.
  - Every beat must connect to her wound, secret, or the_lie, and recontextualize how we see her.
- Per-episode plans must be CONSISTENT with the bible: the heroine's emotional_focus, heroine_state, and choices should flow from her wound and the want-vs-need tension. On a backstory_beats reveal episode, the episode's twist_or_reveal or a key_event should deliver that beat.

Shock Ledger (one concrete escalation per episode) — REQUIRED, genre-agnostic:
- EVERY episode MUST have a "shock" field: one concrete, specific NEW development that moves the story forward — a reveal, reversal, betrayal, new player entering, a raised stake, a secret exposed, an alliance shift, a loss, or an ultimatum. Pick the matching "shock_type".
- Each episode's "shock" must be UNIQUE across the entire season. Do NOT reuse the same development twice. Track them like a ledger: no two episodes deliver the same beat.
- FORBIDDEN as a shock: vague, contentless menace such as "someone is watching", "the threat is closer than we thought", "they'll strike soon", "danger is coming", or any restated tension where nothing concrete actually changes. A shock must name WHAT changed (who did what, what was revealed, what was lost or gained).
- Rotate "shock_type" across the season so escalations feel varied (do not deliver 3+ "reveal" episodes in a row).
- The "shock" should be the engine of the episode's twist_or_reveal/cliffhanger — they should be consistent with each other, not three unrelated events.
- In finale episodes, shocks should resolve or pay off existing threads (final confrontations, truths landing, choices made) rather than introducing brand-new mysteries.

Per-episode structure rules (micro-structure):
- Every episode must be planned as HOOK → CONFLICT → MINI-TWIST → CLIFFHANGER.
- The "micro_beats" array MUST always have exactly four entries in this exact order:
  1) Hook beat (opening emotional moment).
  2) Conflict beat (core conflict of this episode).
  3) Mini-twist beat (shift/reveal near the end).
  4) Cliffhanger beat (final lines that hook into the next episode).
- The HOOK beat must be short, vivid, and emotional (intimacy, humiliation, jealousy, shock, or danger focused on the heroine).
- The CONFLICT beat must be concrete (what exactly goes wrong, who pushes against the heroine).
- The MINI-TWIST beat should be smaller than the episode’s cliffhanger, but still change power/emotion or information.
- The CLIFFHANGER beat must directly grow out of this episode’s conflict and mini-twist; do NOT introduce a completely new subplot just for the last line.

Variety and pacing:
- For episodes 1–10 especially: plan a strong OPENING hook (e.g. intimacy/tension, heroine bullied or in danger, male lead’s presence/physical appeal) and a strong CLOSING hook (e.g. male lead saves/defends her, rescue, charged moment, reveal). PG-13 only.
- Vary the main conflict_type across the season: every 3–5 episodes, rotate between family pressure, money/business/contracts, social reputation/public humiliation, secrets/reveals, rival schemes, and romantic tension. Do NOT let 4+ episodes in a row revolve around the same physical scenario (e.g. chase → corner → forced kiss).
- Physical closeness beats (kisses, grabs, cornering) should be planned as spikes, not the only conflict: after early hook episodes, focus escalation on external stakes (family approval, deals, inheritances, pack politics, social status) and heroine leverage.

Finale shaping:
- Episodes in arc_phase "finale" (typically 56–60) must clearly move the story toward resolution: fewer new villains, more payoffs of existing secrets and conflicts.

Output only valid JSON. No commentary before or after.`;

/** Continuation chunks: only the episodes array; first chunk carries series + characters. */
const BLUEPRINT_CHUNK_CONTINUE_SYSTEM_PROMPT = `You are a season planner for female-led vertical romance dramas, continuing the SAME series outline.

Return ONE JSON object with a single top-level key: "episodes".

"episodes" must be an array of episode plan objects. Each object MUST include:
episode (number), arc_phase, title, setting_focus, emotional_focus, heroine_state, male1_state, male2_state, main_conflict, key_events (array of strings), twist_or_reveal, shock_type, shock, cliffhanger_type, cliffhanger, hook_type, conflict_type, unique_scene, micro_beats (array of exactly 4 strings).

The "shock" field is REQUIRED on every episode: one concrete, UNIQUE new development (reveal/reversal/betrayal/new_player/raised_stake/etc.). Never reuse a shock and never use vague restated menace ("someone is watching", "the threat is closer").

arc_phase: episodes 1–5 "hook", 6–20 "escalation", 21–40 "turning_point", 41–55 "endgame", 56+ "finale".

Valid JSON only — no markdown, no prose outside the object.`;

function buildBlueprintPrompt({ logline, names, genre, episodeCount, tropes }) {
  const total = Math.max(1, Math.min(120, episodeCount || 60));
  const heroine = (names && names.heroine) || "EMMA LIN";
  const male1 = (names && names.coldCeo) || "ADRIAN LUO";
  const male2 = (names && names.warmFriend) || "LIAM CHEN";
  const familyName = names && names.familyName;
  const corporationName = names && names.corporationName;
  const genreTag = String(genre || "Romance").trim() || "Romance";
  const cleanLogline = safeStr(logline).slice(0, 1500);

  let tropesLine = "";
  if (tropes && typeof tropes === "object") {
    const romantic = Array.isArray(tropes.romantic) ? tropes.romantic : [];
    const conflict = Array.isArray(tropes.conflict) ? tropes.conflict : [];
    const supernatural = Array.isArray(tropes.supernatural) ? tropes.supernatural : [];
    const parts = [];
    if (romantic.length)
      parts.push(`romantic_tropes=[${romantic.slice(0, 6).join(", ")}]`);
    if (conflict.length)
      parts.push(`conflict_tropes=[${conflict.slice(0, 6).join(", ")}]`);
    if (supernatural.length)
      parts.push(`supernatural_tropes=[${supernatural.slice(0, 6).join(", ")}]`);
    if (parts.length) {
      tropesLine = `TROPE CONTROLS: ${parts.join(" | ")}.`;
    }
  }

  const lines = [
    `[LANG=EN] [GENRE=${genreTag}] [EPISODES=${total}]`,
    `[HEROINE=${heroine}] [MALE1=${male1}] [MALE2=${male2}]`,
    familyName
      ? familyName.endsWith(" Pack")
        ? `Optional pack for this series: the ${familyName}.`
        : `Optional dynasty/family name for this series: the ${familyName} family.`
      : "",
    corporationName ? `Optional corporation for finance/boardroom storylines: ${corporationName}.` : "",
    cleanLogline ? `[LOGLINE] ${cleanLogline}` : "",
    tropesLine,
    `Generate a full ${total}-episode season outline in the exact JSON format described. One entry in "episodes" per episode, in order.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** First `{` … matching `}` outside of JSON strings (avoids greedy-regex mistakes). */
function extractFirstBalancedJsonObject(text) {
  const s = String(text || "").trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseBlueprintFromContent(content) {
  let raw = (content || "").trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  const tryParseObject = (s) => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && Array.isArray(parsed.episodes) && parsed.episodes.length > 0) return parsed;
    } catch (_) {}
    return null;
  };

  const repaired = raw
    .replace(/[\u201C\u201D\u2018\u2019]/g, '"')
    .replace(/,\s*([\]}])/g, "$1");
  const direct = tryParseObject(raw) || tryParseObject(repaired);
  if (direct) return direct;

  const candidates = [];
  const balanced = extractFirstBalancedJsonObject(raw);
  if (balanced) candidates.push(balanced);
  const balancedRep = extractFirstBalancedJsonObject(repaired);
  if (balancedRep && balancedRep !== balanced) candidates.push(balancedRep);
  const greedy = raw.match(/\{[\s\S]*\}/);
  if (greedy && greedy[0] !== balanced) candidates.push(greedy[0]);
  if (!candidates.length && raw.startsWith("{")) candidates.push(raw);

  for (const cand of candidates) {
    if (!cand) continue;
    const p = tryParseObject(cand) || tryParseObject(cand.replace(/,\s*([\]}])/g, "$1"));
    if (p) return p;
  }
  return null;
}

/**
 * The episode writer only sees character roles if blueprint.characters is present.
 * Models sometimes omit the array (or truncate JSON); fill from locked name tags so
 * constraints apply for every genre the same way.
 */
function hydrateBlueprintCharactersFromNames(blueprint, names) {
  if (!blueprint || typeof blueprint !== "object" || !names) return blueprint;
  const filled = Array.isArray(blueprint.characters)
    ? blueprint.characters.filter((c) => c && typeof c.name === "string" && c.name.trim())
    : [];
  if (filled.length >= 3) return blueprint;

  const h = safeStr(names.heroine).trim() || "HEROINE";
  const m1 = safeStr(names.coldCeo).trim() || "COLD_MALE_LEAD";
  const m2 = safeStr(names.warmFriend).trim() || "WARM_MALE_LEAD";

  blueprint.characters = [
    {
      name: h,
      role: "heroine_protagonist",
      goal: "Carry the season’s emotional arc; grow from underdog to agency without losing core values.",
      traits: ["underdog", "resilient", "emotionally driven"],
      taboos: [
        "recast or merge with another love-interest",
        "random alignment flip without a planned turning point",
      ],
    },
    {
      name: m1,
      role: "cold_male_lead",
      goal: "Embody power, pride, and guarded desire toward the heroine; evolve without swapping archetypes with the warm lead.",
      traits: ["powerful", "controlled", "protective underneath"],
      taboos: [
        "swap roles with the warm male lead",
        "become comic relief only",
        "change profession or family tie without set-up",
      ],
    },
    {
      name: m2,
      role: "warm_male_lead",
      goal: "Offer steadiness and loyalty; compete for the heroine without becoming the main villain unless foreshadowed.",
      traits: ["protective", "patient", "loyal"],
      taboos: [
        "merge into the cold lead’s personality",
        "vanish for many episodes with no payoff",
      ],
    },
  ];
  return blueprint;
}

/** Same bullets as blueprint context, when generation runs without a season outline. */
function formatFallbackCharacterConstraints(names) {
  if (!names || !names.heroine || !names.coldCeo || !names.warmFriend) return "";
  const lines = [
    "CHARACTER ROLE CONSTRAINTS (locked cast — same for every genre; do NOT break these):",
    `- ${names.heroine} | role: heroine_protagonist | taboos: do not swap her with a different heroine; do not rewrite her as parent/guardian of the male leads unless the logline already says so.`,
    `- ${names.coldCeo} | role: cold_male_lead | taboos: do not merge with ${names.warmFriend}; do not randomly become her father/brother unless the logline already establishes that.`,
    `- ${names.warmFriend} | role: warm_male_lead | taboos: do not merge with ${names.coldCeo}; stay a distinct person and relationship vector.`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Calls the fine-tuned vdrama model once at generation start to produce a style guide
 * specific to this logline: character voices, dialogue rhythm, pacing rules, and format
 * conventions. The output is injected into GENERATOR_MODEL's system prompt for all 60 episodes.
 */
async function generateVdramaStyleGuide({ logline, names, genre }) {
  const heroine = safeStr(names?.heroine) || "the heroine";
  const male1   = safeStr(names?.coldCeo)  || "the cold lead";
  const male2   = safeStr(names?.warmFriend) || "the warm lead";

  const prompt =
    `You are a vertical drama script expert. Based on the logline and characters below, ` +
    `produce a STYLE GUIDE for a script writer generating this series.\n\n` +
    `Genre: ${genre}\n` +
    `Logline: ${safeStr(logline).slice(0, 800)}\n` +
    `Characters: ${heroine} (heroine), ${male1} (cold lead), ${male2} (warm lead)\n\n` +
    `The style guide must cover exactly these five sections — be specific and concrete:\n\n` +
    `CHARACTER VOICES:\n` +
    `- ${heroine}: describe her speech pattern, sentence length, typical emotional register\n` +
    `- ${male1}: describe his speech pattern, formality level, how he expresses conflict\n` +
    `- ${male2}: describe his speech pattern, warmth level, how he contrasts with ${male1}\n\n` +
    `DIALOGUE RHYTHM: Describe the overall pacing — short punchy exchanges vs longer speeches, ` +
    `how tension is built through dialogue, typical line length.\n\n` +
    `SCENE PACING: How scenes open and close, typical scene length, when to cut vs linger. ` +
    `Each episode is SHORT (~${EPISODE_TARGET_CHARS} characters total, 2–3 scenes only).\n\n` +
    `EMOTIONAL BEATS: The dominant emotional textures of this specific story — ` +
    `what feelings should recur, what the audience should feel at the end of each episode.\n\n` +
    `FORMAT RULES (non-negotiable for vertical drama):\n` +
    `- Scene headings: INT./EXT. LOCATION — DAY/NIGHT on its own line\n` +
    `- Character cues: ALL CAPS name on its own line, dialogue on the next line\n` +
    `- Action lines: 1–2 sentences maximum, no long prose blocks\n` +
    `- Episode length: ~${EPISODE_TARGET_WORDS_LOW}–${EPISODE_TARGET_WORDS_HIGH} words (~${EPISODE_TARGET_CHARS} characters) per episode\n` +
    `- Episode boundary lines ("EPISODE N" / "END EPISODE N") are NOT written by the model — the export pipeline adds them. Scripts start with the cold open or first INT./EXT. heading.\n` +
    `- No chapter headings, no scene numbers, no (CONT'D) spam\n\n` +
    `Output only the five sections above. No preamble or closing remarks.`;

  try {
    const resp = await openai.chat.completions.create({
      model: FINETUNED_MODEL,
      max_tokens: 700,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: "You are a vertical drama script expert. Produce concise, specific style guides.",
        },
        { role: "user", content: prompt },
      ],
    });
    return safeStr(resp.choices?.[0]?.message?.content).trim();
  } catch (err) {
    console.warn("VDrama style guide generation failed:", err?.message || err);
    return "";
  }
}

/**
 * Calls PLANNER_MODEL once at generation start to produce genre-specific tone and atmosphere
 * notes. Injected alongside the vdrama style guide into GENERATOR_MODEL's system prompt.
 */
async function generateGenreStyleNotes({ genre, logline }) {
  const prompt =
    `You are a script development consultant specialising in ${genre} drama.\n\n` +
    `Logline: ${safeStr(logline).slice(0, 800)}\n\n` +
    `Produce GENRE STYLE NOTES for a writer generating a 60-episode ${genre} vertical drama series. ` +
    `Cover exactly these four sections:\n\n` +
    `TONE & ATMOSPHERE: The dominant mood — gritty, glamorous, tense, romantic, dangerous, etc. ` +
    `What should every scene feel like to a viewer?\n\n` +
    `STAKES & CONFLICT: What kinds of conflict drive this genre forward? ` +
    `What should the audience fear losing, and what should they want the heroine to gain?\n\n` +
    `PACING CONVENTIONS: How fast should this genre move? ` +
    `Where should episodes slow down (intimacy, revelation) vs accelerate (danger, betrayal)?\n\n` +
    `WHAT TO AVOID: List 4–5 clichés or lazy patterns specific to ${genre} drama ` +
    `that the writer must actively avoid — be specific (e.g. "don't resolve every threat with a fistfight", ` +
    `"don't repeat the same rescue-from-danger beat more than twice").\n\n` +
    `Output only the four sections. No preamble or closing remarks.`;

  try {
    const resp = await openai.chat.completions.create({
      model: PLANNER_MODEL,
      max_tokens: 500,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: "You are a script development consultant. Produce concise, specific genre notes.",
        },
        { role: "user", content: prompt },
      ],
    });
    return safeStr(resp.choices?.[0]?.message?.content).trim();
  } catch (err) {
    console.warn("Genre style notes generation failed:", err?.message || err);
    return "";
  }
}

function normalizeBlueprintEpisodeChunk(eps, start, end) {
  if (!Array.isArray(eps)) return null;
  const need = end - start + 1;
  if (eps.length < need) return null;
  const slice = eps.slice(0, need);
  for (let i = 0; i < slice.length; i++) {
    const exp = start + i;
    if (!slice[i] || typeof slice[i] !== "object") return null;
    slice[i] = { ...slice[i], episode: exp };
  }
  return slice;
}

async function openaiBlueprintChatCreate(body) {
  const withJson = { ...body, response_format: { type: "json_object" } };
  try {
    return await openai.chat.completions.create(withJson);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/response_format|json_object|unsupported|json mode/i.test(msg)) {
      return await openai.chat.completions.create(body);
    }
    throw err;
  }
}

async function generateSeasonBlueprintChunked({ total, logline, genre, names, tropes }) {
  // Smaller chunks = smaller JSON per response = fewer parse failures from the planner model.
  const chunkSpan = 8;
  const numChunks = Math.ceil(total / chunkSpan);
  console.log(
    `[blueprint] chunked planner v2: ${total} episodes → ${numChunks} chunk(s) of up to ${chunkSpan} episodes`
  );
  let blueprint = null;

  for (let ci = 0; ci < numChunks; ci++) {
    const start = ci * chunkSpan + 1;
    const end = Math.min((ci + 1) * chunkSpan, total);
    const count = end - start + 1;
    const isFirst = ci === 0;

    let chunkOk = false;
    let lastChunkErr = /** @type {Error | null} */ (null);

    for (let attempt = 1; attempt <= 4 && !chunkOk; attempt++) {
      const userContent = isFirst
        ? buildBlueprintPrompt({ logline, names, genre, episodeCount: total, tropes }) +
          `\n\nReturn ONE JSON object with keys: series_title, heroine, male1, male2, genre, tropes, characters (exactly 3 entries), protagonist_bible, episodes.\n` +
          `CRITICAL: "episodes" MUST contain exactly ${count} objects — episode numbers ${start} through ${end} only (not the full ${total}-episode season).\n` +
          `Each episode object must follow the full per-episode schema (including micro_beats with exactly 4 strings).\n` +
          (attempt > 1
            ? `\n(Attempt ${attempt}/4: reply was invalid or wrong length. Valid JSON only; exactly ${count} episodes.)`
            : "")
        : [
            `[CONTINUE SAME SERIES] [GENRE=${String(genre || "Romance").trim() || "Romance"}] [TOTAL_EPISODES=${total}]`,
            `[HEROINE=${(names && names.heroine) || "HEROINE"}] [MALE1=${(names && names.coldCeo) || "MALE1"}] [MALE2=${(names && names.warmFriend) || "MALE2"}]`,
            `[LOGLINE] ${safeStr(logline).slice(0, 1200)}`,
            "",
            `Return JSON with ONLY the key "episodes": an array of exactly ${count} objects for episodes ${start} through ${end} inclusive.`,
            `Use the same per-episode fields as the season planner (episode, arc_phase, title, setting_focus, emotional_focus, heroine_state, male1_state, male2_state, main_conflict, key_events, twist_or_reveal, shock_type, shock, cliffhanger_type, cliffhanger, hook_type, conflict_type, unique_scene, micro_beats[4]).`,
            `The "shock" field is REQUIRED and must be a concrete, UNIQUE new development — never reused, never vague menace ("someone is watching", "the threat is closer").`,
            attempt > 1
              ? `\n(Attempt ${attempt}/4: valid JSON only; exactly ${count} episodes in order.)`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

      const maxTok = Math.min(16384, Math.max(4096, count * 520));

      try {
        const completion = await openaiBlueprintChatCreate({
          model: PLANNER_MODEL,
          messages: [
            {
              role: "system",
              content: isFirst
                ? `${BLUEPRINT_SYSTEM_PROMPT}\n\nWhen the user asks for a partial episode range, still include every required top-level key; only limit the "episodes" array to that range.`
                : BLUEPRINT_CHUNK_CONTINUE_SYSTEM_PROMPT,
            },
            { role: "user", content: userContent },
          ],
          max_tokens: maxTok,
          temperature: attempt <= 2 ? 0.4 : 0.18,
          frequency_penalty: 0.35,
          presence_penalty: 0.08,
        });

        const finish = completion.choices?.[0]?.finish_reason;
        if (finish === "length") {
          console.warn(
            `Blueprint chunk ${ci + 1}/${numChunks} attempt ${attempt}/4: truncated (max_tokens=${maxTok})`
          );
        }

        const content = safeStr(completion.choices?.[0]?.message?.content).trim();
        let parsed = null;
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = parseBlueprintFromContent(content);
        }

        if (!parsed || !Array.isArray(parsed.episodes)) {
          lastChunkErr = new Error("invalid JSON structure");
          console.warn(
            `Blueprint chunk ${ci + 1}/${numChunks} attempt ${attempt}/4: parse failed (len=${content.length})`
          );
          continue;
        }

        const norm = normalizeBlueprintEpisodeChunk(parsed.episodes, start, end);
        if (!norm) {
          lastChunkErr = new Error(`expected ${count} episodes, got ${parsed.episodes.length}`);
          console.warn(`Blueprint chunk ${ci + 1}/${numChunks} attempt ${attempt}/4: ${lastChunkErr.message}`);
          continue;
        }

        if (isFirst) {
          blueprint = parsed;
          blueprint.episodes = norm;
        } else {
          blueprint.episodes.push(...norm);
        }
        chunkOk = true;
      } catch (err) {
        lastChunkErr = err instanceof Error ? err : new Error(String(err));
        console.warn(`Blueprint chunk ${ci + 1}/${numChunks} attempt ${attempt}/4:`, lastChunkErr.message);
      }
    }

    if (!chunkOk) {
      throw lastChunkErr || new Error(`Blueprint chunk ${start}-${end} failed`);
    }
  }

  if (!blueprint || !Array.isArray(blueprint.episodes) || blueprint.episodes.length !== total) {
    throw new Error(
      `Blueprint merge mismatch: have ${blueprint?.episodes?.length ?? 0} episodes, need ${total}`
    );
  }

  hydrateBlueprintCharactersFromNames(blueprint, names);
  return blueprint;
}

async function generateSeasonBlueprintSingleShot({ total, logline, genre, names, tropes }) {
  const userContentBase = buildBlueprintPrompt({
    logline,
    names,
    genre,
    episodeCount: total,
    tropes,
  });
  const blueprintMaxTokens = Math.min(16384, Math.max(8192, total * 150));
  let lastError = /** @type {Error | null} */ (null);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const retryHint =
      attempt > 1
        ? `\n\nRetry ${attempt}/3: Invalid JSON or wrong episode count. ONE JSON object only. "episodes" must have exactly ${total} entries.`
        : "";

    try {
      const completion = await openaiBlueprintChatCreate({
        model: PLANNER_MODEL,
        messages: [
          { role: "system", content: BLUEPRINT_SYSTEM_PROMPT },
          { role: "user", content: userContentBase + retryHint },
        ],
        max_tokens: blueprintMaxTokens,
        temperature: attempt === 1 ? 0.5 : 0.2,
        frequency_penalty: 0.4,
        presence_penalty: 0.08,
      });

      const choice = completion.choices?.[0];
      if (choice?.finish_reason === "length") {
        console.warn(
          `Blueprint single-shot attempt ${attempt}/3: truncated (max_tokens=${blueprintMaxTokens})`
        );
      }

      const content = safeStr(choice?.message?.content).trim();
      let blueprint = null;
      try {
        blueprint = JSON.parse(content);
      } catch {
        blueprint = parseBlueprintFromContent(content);
      }

      if (!blueprint || !Array.isArray(blueprint.episodes)) {
        lastError = new Error("Failed to parse season blueprint JSON");
        console.warn(`Blueprint single-shot attempt ${attempt}/3: parse failed (len=${content.length})`);
        continue;
      }
      if (blueprint.episodes.length < total) {
        lastError = new Error(`Blueprint has ${blueprint.episodes.length} episodes; need ${total}`);
        console.warn(`Blueprint single-shot attempt ${attempt}/3: ${lastError.message}`);
        continue;
      }
      if (blueprint.episodes.length > total) {
        blueprint.episodes = blueprint.episodes.slice(0, total);
      }

      hydrateBlueprintCharactersFromNames(blueprint, names);
      return blueprint;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Blueprint single-shot attempt ${attempt}/3:`, lastError.message);
    }
  }

  throw lastError || new Error("Failed to parse season blueprint JSON");
}

// ── Shock Ledger validation + repair (Phase C) ──────────────────────────────
// Vague, contentless "menace" that does not describe a concrete development.
const VAGUE_SHOCK_PATTERNS = [
  /someone\s+is\s+watching/i,
  /being\s+watched/i,
  /watching\s+from\s+the\s+shadows/i,
  /the\s+threat\s+(is|grows|gets|feels|seems)\s+(closer|nearer|bigger|worse|real)/i,
  /closer\s+than\s+(we|they|she|he)\s+(thought|realized|expected)/i,
  /they\s*('|’)?\s*ll\s+strike/i,
  /danger\s+(is\s+)?(coming|near|approaching|looming)/i,
  /something\s+(is\s+)?(wrong|coming|off|amiss|brewing)/i,
  /(a\s+)?storm\s+is\s+(coming|brewing)/i,
  /nothing\s+(is\s+)?(as|what)\s+it\s+seems/i,
  /trouble\s+is\s+(coming|brewing|near)/i,
  /the\s+walls\s+(are\s+)?closing\s+in/i,
  /time\s+is\s+running\s+out/i,
];

const SHOCK_STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","her","his","she",
  "he","they","them","is","are","was","were","be","been","being","that","this","it","as","by",
  "from","into","about","over","more","than","thought","someone","something","when","who","whom",
  "while","after","before","then","now","new","one","will","would","could","should","has","have",
  "had","not","out","up","down","off","their","there","here","what","which","into","onto",
]);

function shockTokenSet(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !SHOCK_STOPWORDS.has(w))
  );
}

function shockJaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Returns ordered list of shock-ledger problems: missing, vague, or duplicate. */
function detectShockLedgerIssues(blueprint) {
  const issues = [];
  if (!blueprint || !Array.isArray(blueprint.episodes)) return issues;
  const eps = blueprint.episodes;
  const tokenSets = new Array(eps.length).fill(null);

  for (let i = 0; i < eps.length; i++) {
    const p = eps[i];
    const epNum = p?.episode ?? i + 1;
    const shock = typeof p?.shock === "string" ? p.shock.trim() : "";
    if (!shock || shock.length < 8) {
      issues.push({ episode: epNum, idx: i, reason: "missing", shock });
      continue;
    }
    if (VAGUE_SHOCK_PATTERNS.some((re) => re.test(shock))) {
      issues.push({ episode: epNum, idx: i, reason: "vague", shock });
      tokenSets[i] = shockTokenSet(shock);
      continue;
    }
    tokenSets[i] = shockTokenSet(shock);
  }

  const flagged = new Set(issues.map((x) => x.idx));
  for (let i = 0; i < eps.length; i++) {
    if (flagged.has(i)) continue;
    const ts = tokenSets[i];
    if (!ts) continue;
    for (let j = 0; j < i; j++) {
      if (!tokenSets[j]) continue;
      if (shockJaccard(ts, tokenSets[j]) >= 0.6) {
        issues.push({
          episode: eps[i].episode ?? i + 1,
          idx: i,
          reason: "duplicate",
          shock: eps[i].shock,
          duplicateOf: eps[j].episode ?? j + 1,
        });
        flagged.add(i);
        break;
      }
    }
  }

  issues.sort((a, b) => a.idx - b.idx);
  return issues;
}

const SHOCK_REPAIR_SYSTEM_PROMPT = `You are a story editor fixing the "shock ledger" of a vertical drama season.
Each episode must deliver ONE concrete, unique escalation (a reveal, reversal, betrayal, new player, raised stake, secret exposed, alliance shift, loss, or ultimatum).
You will be given the full ledger of every episode's current shock, plus a list of episodes to FIX (because their shock is missing, vague, or a duplicate).
For each episode to fix, write a NEW shock that:
- Is concrete and specific (name what actually changes — who does what, what is revealed, what is lost or gained).
- Is UNIQUE — different from every other shock in the ledger (including the ones you are not fixing).
- Is consistent with that episode's arc phase, conflict, and cliffhanger context.
- Is NEVER vague menace ("someone is watching", "the threat is closer", "danger is coming", "something is wrong").
Output ONLY a JSON object: { "fixes": [ { "episode": <number>, "shock_type": "<type>", "shock": "<one concrete sentence>" } ] }. No prose, no markdown.`;

async function repairShockLedger({ blueprint, issues, logline, genre, names }) {
  const eps = blueprint.episodes;
  const batch = issues.slice(0, 24);
  if (!batch.length) return 0;

  const ledger = eps
    .map((p, i) => `Ep ${p?.episode ?? i + 1} [${p?.arc_phase || "?"}]: ${typeof p?.shock === "string" && p.shock.trim() ? p.shock.trim() : "(missing)"}`)
    .join("\n");

  const toFix = batch
    .map((it) => {
      const p = eps[it.idx] || {};
      const dup = it.duplicateOf ? ` (duplicates Ep ${it.duplicateOf})` : "";
      return `Ep ${it.episode} — problem: ${it.reason}${dup}. Context: arc=${p.arc_phase || "?"}; conflict=${safeStr(p.main_conflict)}; twist=${safeStr(p.twist_or_reveal)}; cliffhanger=${safeStr(p.cliffhanger)}.`;
    })
    .join("\n");

  const userPrompt = [
    `[GENRE=${String(genre || "Romance").trim() || "Romance"}]`,
    `[HEROINE=${(names && names.heroine) || "HEROINE"}] [MALE1=${(names && names.coldCeo) || "MALE1"}] [MALE2=${(names && names.warmFriend) || "MALE2"}]`,
    logline ? `[LOGLINE] ${safeStr(logline).slice(0, 800)}` : "",
    "",
    "FULL SHOCK LEDGER (every episode — your new shocks must not duplicate any of these):",
    ledger,
    "",
    "EPISODES TO FIX (write a new concrete, unique shock for each):",
    toFix,
  ]
    .filter(Boolean)
    .join("\n");

  const completion = await openaiBlueprintChatCreate({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: SHOCK_REPAIR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: Math.min(4096, Math.max(800, batch.length * 130)),
    temperature: 0.5,
    frequency_penalty: 0.3,
  });

  const content = safeStr(completion.choices?.[0]?.message?.content).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const obj = extractFirstBalancedJsonObject(content);
    if (obj) {
      try {
        parsed = JSON.parse(obj);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || !Array.isArray(parsed.fixes)) return 0;

  const byEpisode = new Map();
  for (let i = 0; i < eps.length; i++) {
    const num = eps[i]?.episode ?? i + 1;
    byEpisode.set(num, i);
  }

  let merged = 0;
  for (const fix of parsed.fixes) {
    if (!fix || typeof fix.shock !== "string" || !fix.shock.trim()) continue;
    const idx = byEpisode.get(Number(fix.episode));
    if (idx == null || !eps[idx]) continue;
    eps[idx].shock = fix.shock.trim();
    if (typeof fix.shock_type === "string" && fix.shock_type.trim()) {
      eps[idx].shock_type = fix.shock_type.trim();
    }
    merged++;
  }
  return merged;
}

/** Validate + repair the shock ledger after generation. Degrades gracefully; never throws. */
async function reconcileShockLedger({ blueprint, logline, genre, names }) {
  try {
    let issues = detectShockLedgerIssues(blueprint);
    if (!issues.length) {
      console.log("[shock-ledger] clean — every episode has a unique, concrete shock");
      return { ok: true, fixed: 0, remaining: 0 };
    }
    const total = Array.isArray(blueprint?.episodes) ? blueprint.episodes.length : 0;
    // If the planner ignored the field wholesale, prompts still enforce shocks at generation
    // time — avoid a huge/expensive repair call and just log.
    if (total > 0 && issues.filter((i) => i.reason === "missing").length > total / 2) {
      console.warn(
        `[shock-ledger] planner omitted shocks on >50% of episodes (${issues.length}/${total}); skipping repair, relying on per-episode prompts`
      );
      return { ok: true, fixed: 0, remaining: issues.length };
    }

    console.log(`[shock-ledger] ${issues.length} issue(s) detected; attempting repair`);
    let fixedTotal = 0;
    for (let attempt = 1; attempt <= 2 && issues.length; attempt++) {
      const merged = await repairShockLedger({ blueprint, issues, logline, genre, names });
      if (!merged) break;
      fixedTotal += merged;
      issues = detectShockLedgerIssues(blueprint);
    }
    if (issues.length) {
      console.warn(`[shock-ledger] ${issues.length} issue(s) remain after repair`);
    } else {
      console.log(`[shock-ledger] repaired ${fixedTotal} shock(s); ledger now clean`);
    }
    return { ok: true, fixed: fixedTotal, remaining: issues.length };
  } catch (e) {
    console.warn("[shock-ledger] reconcile failed:", e?.message || e);
    return { ok: false, fixed: 0, remaining: -1 };
  }
}

async function generateSeasonBlueprint({ episodeCount, logline, genre, names, tropes }) {
  const total = Math.max(1, Math.min(120, episodeCount || 60));
  let blueprint = null;

  if (total > 15) {
    try {
      blueprint = await generateSeasonBlueprintChunked({ total, logline, genre, names, tropes });
    } catch (chunkErr) {
      console.warn(
        "[blueprint] chunked planner failed, falling back to single-shot:",
        chunkErr?.message || chunkErr
      );
    }
  } else {
    console.log(`[blueprint] single-shot planner (${total} episodes ≤ 15)`);
  }

  if (!blueprint) {
    blueprint = await generateSeasonBlueprintSingleShot({ total, logline, genre, names, tropes });
  }

  await reconcileShockLedger({ blueprint, logline, genre, names });
  return blueprint;
}

const EPISODE_SUMMARY_SYSTEM_PROMPT = `You are a story planner for female-led vertical romance dramas.

You will be given:
- A short logline for the whole series.
- A JSON object with "episodes": an array of episode plans for ONE season, each including fields like: episode, arc_phase, title, main_conflict, key_events, twist_or_reveal, shock, cliffhanger, hook_type, conflict_type, and micro_beats.

Your task:
- For EACH episode in order, write a short prose episode summary that the scriptwriter will follow beat-for-beat.
- Each summary must:
  - Be 3–6 sentences maximum.
  - Explicitly follow the HOOK → CONFLICT → MINI-TWIST → CLIFFHANGER pattern implied by micro_beats.
  - Clearly include the episode's SHOCK — its one concrete new development (reveal/reversal/betrayal/etc.) — as an event that actually happens.
  - Mention the heroine and at least one male lead by name where relevant.
  - Stay consistent with the "arc_phase" (hook, escalation, turning_point, endgame, finale).
- Do NOT invent brand-new villains, conspiracies, supernatural systems, or locations that are not implied by the episode plans; focus on clarifying and stitching together what is already there.

Output format:
- Output a single JSON object (no other text, no markdown) with:
{
  "episode_summaries": [
    { "episode": 1, "summary": "..." },
    { "episode": 2, "summary": "..." }
  ]
}

Each "summary" should be plain text (no newlines inside, no quotes beyond simple dialogue if needed).`;

function parseEpisodeSummariesFromContent(content) {
  const raw = (content || "").trim();
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const parsed = JSON.parse(objMatch[0]);
    if (!parsed || !Array.isArray(parsed.episode_summaries)) return null;
    const map = new Map();
    for (const item of parsed.episode_summaries) {
      if (
        item &&
        typeof item.episode === "number" &&
        typeof item.summary === "string" &&
        item.summary.trim()
      ) {
        map.set(item.episode, item.summary.trim());
      }
    }
    return map;
  } catch (_) {
    return null;
  }
}

async function generateEpisodeSummaries({ blueprint, logline, genre }) {
  if (!blueprint || !Array.isArray(blueprint.episodes) || !blueprint.episodes.length) {
    return null;
  }
  const payload = {
    logline: safeStr(logline).slice(0, 1500),
    genre: String(genre || "Romance").trim() || "Romance",
    episodes: blueprint.episodes,
  };
  const userContent = JSON.stringify(payload);

  const completion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: EPISODE_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 4096,
    temperature: 0.5,
  });

  const rawContent = completion.choices?.[0]?.message?.content;
  const content =
    typeof rawContent === "string" && rawContent.trim() ? rawContent.trim() : "";
  const map = parseEpisodeSummariesFromContent(content);
  return map;
}

const RECAP_SYSTEM_PROMPT = `You are an assistant that summarizes vertical drama episodes.

Given the full script text for ONE episode, write a single concise sentence (15–35 words) that describes what happens to the heroine and how the episode ends, focusing on the emotional and plot cliffhanger.

Output ONLY the sentence. No bullet points, no extra commentary.`;

const EPISODE_STATE_SYSTEM_PROMPT = `You summarize ONE episode into strict JSON.
Return ONLY JSON in this exact shape:
{
  "location": "last scene location (short phrase)",
  "ending": "one sentence ending/cliffhanger state",
  "character_state": "one sentence emotional position of heroine + two male leads"
}`;

const NARRATIVE_RESET_SYSTEM_PROMPT = `You create a compact narrative reset for long-running serialized scripts.
Given recap lines and cast names, return ONLY text under 400 tokens with:
1) Current cast emotional positions
2) Central conflict status
3) Unresolved threads (max 6 bullets)
4) Immediate next-step pressure
Do not add new plotlines.`;

async function summarizeEpisode({ episodeNumber, text }) {
  const clean = safeStr(text);
  if (!clean) return null;

  const completion = await openai.chat.completions.create({
    model: RECAP_MODEL,
    messages: [
      { role: "system", content: RECAP_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Episode ${episodeNumber} script:\n\n${clean.slice(
          0,
          8000
        )}`,
      },
    ],
    max_tokens: 96,
    temperature: 0.4,
    frequency_penalty: 0.5,
    presence_penalty: 0.0,
  });

  const rawContent = completion.choices?.[0]?.message?.content;
  const recap =
    typeof rawContent === "string" && rawContent.trim()
      ? rawContent.trim()
      : null;
  return recap;
}

async function summarizeEpisodeState({ episodeNumber, text }) {
  const clean = safeStr(text);
  if (!clean) return null;
  const completion = await openai.chat.completions.create({
    model: RECAP_MODEL,
    messages: [
      { role: "system", content: EPISODE_STATE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Episode ${episodeNumber} script:\n\n${clean.slice(0, 7000)}`,
      },
    ],
    max_tokens: 180,
    temperature: 0.2,
  });
  const raw = safeStr(completion.choices?.[0]?.message?.content);
  const jsonMatch = raw.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      episode: episodeNumber,
      location: safeStr(parsed.location).slice(0, 120),
      ending: safeStr(parsed.ending).slice(0, 260),
      character_state: safeStr(parsed.character_state).slice(0, 320),
    };
  } catch {
    return null;
  }
}

async function buildFullNarrativeReset(episodeRecaps, names, logline, episodeNumber) {
  const recaps = Array.isArray(episodeRecaps)
    ? episodeRecaps
        .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber)
        .slice(-16)
    : [];
  if (!recaps.length) return "";
  const recapText = recaps.map((r) => `Ep ${r.episode}: ${safeStr(r.recap)}`).join("\n");
  const completion = await openai.chat.completions.create({
    model: RECAP_MODEL,
    messages: [
      { role: "system", content: NARRATIVE_RESET_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `LOGLINE:\n${safeStr(logline).slice(0, 700)}\n\n` +
          `CAST:\nHeroine=${safeStr(names?.heroine)}\nMale1=${safeStr(names?.coldCeo)}\nMale2=${safeStr(names?.warmFriend)}\n\n` +
          `RECAPS:\n${recapText}`,
      },
    ],
    max_tokens: 420,
    temperature: 0.25,
  });
  return safeStr(completion.choices?.[0]?.message?.content).slice(0, 2600);
}

/**
 * Phase 1c — Format all prior episode opening fingerprints into a compact
 * "EPISODE OPENING HISTORY" block injected into every episode prompt.
 * Covers ALL previous episodes (not a sliding window) so patterns that
 * haven't repeated in 10 episodes are still banned.
 */
function formatOpeningHistory(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const prev = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber && r.openingFingerprint)
    .sort((a, b) => a.episode - b.episode);
  if (!prev.length) return "";

  const rows = prev.map((r) => {
    const fp = r.openingFingerprint;
    return `  Ep ${String(r.episode).padStart(2, " ")}: ${fp.location.slice(0, 40).padEnd(40, " ")} | ${fp.action.padEnd(22, " ")} | ${fp.dialogue_type}`;
  });

  return [
    "EPISODE OPENING HISTORY — every prior episode's opening structure (location | first action | dialogue type).",
    "You MUST write an opening that is structurally different from ALL entries below.",
    "Different location, different first action, different dialogue type — the audience must never feel déjà vu:",
    ...rows,
  ].join("\n");
}

function formatRecapContext(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const prev = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber)
    .slice(-6); // expanded from -3
  if (!prev.length) return "";
  const lines = ["RECENT EPISODE RECAPS (actual story so far):"];
  for (const r of prev) {
    lines.push(`  Ep ${r.episode}: ${r.recap}`);
  }
  return lines.join("\n");
}

/**
 * Compact full-series history — all recaps truncated to 90 chars each.
 * Gives the model the complete story arc so it cannot "forget" events from earlier episodes.
 * Only injected when ep > 3 (no history yet to speak of before then).
 */
function formatSeriesHistoryBlock(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const all = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber);
  if (all.length < 3) return ""; // not enough history to be useful
  const lines = [
    "FULL SERIES HISTORY — every episode written so far (characters carry all of this forward; never contradict or reset):",
  ];
  for (const r of all) {
    lines.push(`  Ep ${r.episode}: ${safeStr(r.recap).slice(0, 90)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Simple event tagging: detect big repeated set-pieces to steer away from.
// ---------------------------------------------------------------------------

/**
 * Extracts the opening beat fingerprint of an episode:
 * first scene heading + first 2-3 non-cue, non-metadata lines.
 * Stored per recap so the model can be shown exactly what it used before.
 */
function extractOpeningBeat(text) {
  const lines = safeStr(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const beats = [];
  for (const line of lines) {
    if (beats.length >= 3) break;
    if (/^EPISODE\s+\d+/i.test(line)) continue;
    if (/^END\s+(OF\s+)?EPISODE/i.test(line)) continue;
    // Skip ALL CAPS character cue headers
    if (/^[A-Z][A-Z0-9\s'\-]{1,40}$/.test(line) && !/[.!?,]/.test(line) && line.length <= 44) continue;
    // Skip standalone parentheticals
    if (/^\([^)]+\)$/.test(line)) continue;
    beats.push(line);
  }
  return beats.join(" ").slice(0, 220);
}

function cosineEmbeddingSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

function sliceTextForEpisodeEmbedding(text, maxChars) {
  const t = safeStr(text).replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  return t.slice(0, maxChars);
}

async function fetchEpisodeChunkEmbedding(chunk) {
  const trimmed = safeStr(chunk).trim();
  if (trimmed.length < 40) return null;
  const input = trimmed.slice(0, 8191);
  try {
    const r = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input,
    });
    const emb = r.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
  } catch (e) {
    console.warn("fetchEpisodeChunkEmbedding:", e?.message || e);
    return null;
  }
}

function bestPriorEmbeddingSimilarity(vec, priorEmbeddings) {
  if (!vec || !Array.isArray(priorEmbeddings)) return { sim: 0, ep: 0 };
  let bestSim = 0;
  let bestEp = 0;
  for (let i = 0; i < priorEmbeddings.length; i++) {
    const prev = priorEmbeddings[i];
    if (!prev) continue;
    const sim = cosineEmbeddingSimilarity(vec, prev);
    if (sim > bestSim) {
      bestSim = sim;
      bestEp = i + 1;
    }
  }
  return { sim: bestSim, ep: bestEp };
}

/**
 * Phase 3a — Blueprint setting match checker.
 * Returns { match: boolean, confidence: 0–1, normalizedSetting: string }
 *
 * Fuzzy: blueprint says "royal throne room", fingerprint extracts "THRONE ROOM" → match.
 * Strategy:
 *   1. Normalise both strings (lowercase, strip articles/filler, split to keywords).
 *   2. Count shared keywords with length > 3.
 *   3. confidence = shared / total keywords in the blueprint setting (recall-oriented:
 *      we only care whether the blueprint's key nouns appear in the opening location,
 *      not whether every word in the location matches the blueprint).
 *   4. match = confidence >= 0.5 OR any single "anchor word" (≥6 chars) appears in both.
 */
function blueprintSettingMatches(openingFingerprint, settingFocus) {
  const empty = { match: true, confidence: 1, normalizedSetting: "" };
  if (!settingFocus || typeof settingFocus !== "string") return empty;
  if (!openingFingerprint || openingFingerprint.location === "UNKNOWN") return empty;

  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "of", "in", "at", "on", "near",
    "inside", "outside", "with", "from", "into", "during", "main",
    "upper", "lower", "inner", "outer", "old", "new", "grand", "royal",
    "int", "ext",
  ]);

  const tokenize = (str) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const settingTokens = tokenize(settingFocus);
  const locationTokens = new Set(tokenize(openingFingerprint.location));

  if (!settingTokens.length) return empty;

  const shared = settingTokens.filter((w) => locationTokens.has(w));
  const confidence = shared.length / settingTokens.length;

  // Anchor word: any single keyword ≥ 6 chars present in both is sufficient for a match
  // (e.g. "library", "throne", "harbour", "palace" are unambiguous anchors)
  const hasAnchor = settingTokens.some((w) => w.length >= 6 && locationTokens.has(w));

  return {
    match: confidence >= 0.5 || hasAnchor,
    confidence,
    normalizedSetting: settingTokens.join(" "),
  };
}

function formatRecentEventConstraints(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const allPrev = recaps.filter((r) => typeof r.episode === "number" && r.episode < episodeNumber);
  const recent = allPrev.slice(-6); // expanded from -3
  if (!recent.length) return "";

  const recentTags = new Set();
  const dockScanEps = [];
  const skepticEps = [];
  for (const r of recent) {
    if (Array.isArray(r.tags)) {
      for (const t of r.tags) {
        if (t) recentTags.add(t);
      }
      if (r.tags.includes("dock_beach_scan_open")) dockScanEps.push(r.episode);
      if (r.tags.includes("skeptic_dismissal")) skepticEps.push(r.episode);
    }
  }

  // All-time tag counts (not just recent window) for patterns that should NEVER repeat freely
  const allTimeEpsWithTag = (tag) =>
    allPrev.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag)).map((r) => r.episode);

  const parts = [];

  // Standard big set-piece avoidance (exclude the new opening/relationship tags — handled separately)
  const excludedTags = ["dock_beach_scan_open", "skeptic_dismissal", "threat_confirmed", "library_research_open"];
  const setpieceTags = Array.from(recentTags).filter((t) => !excludedTags.includes(t));
  if (setpieceTags.length) {
    parts.push(
      "RECENT BIG SET-PIECES (avoid repeating as the main device this episode): " +
      setpieceTags.join(", ") + "."
    );
  }

  // Dock/beach scan ban — if used ≥2 times in the recent window
  if (dockScanEps.length >= 2) {
    parts.push(
      `OPENING BEAT BANNED: Do NOT open this episode with the heroine standing alone at the dock, beach, or water's edge scanning the ocean or checking equipment. ` +
      `That exact beat was used in recent episodes (${dockScanEps.join(", ")}). ` +
      `Start somewhere completely different — indoors, mid-action, mid-conversation, or from a secondary character's perspective.`
    );
  }

  // Library/archive opening ban — ≥3 uses all-time is clearly a crutch; ban it hard
  const libraryEpsAll = allTimeEpsWithTag("library_research_open");
  if (libraryEpsAll.length >= 3) {
    parts.push(
      `OPENING LOCATION BANNED (library overused): The library, archive, or research room has been used as an episode opening ${libraryEpsAll.length} times (eps ${libraryEpsAll.slice(-5).join(", ")}). ` +
      `Do NOT open this episode in any room full of books, scrolls, or tomes. ` +
      `Choose a completely different location — outdoor setting, a battlefield, a court chamber, a personal room, a market, or a new location introduced by this episode's blueprint plan.`
    );
  } else if (libraryEpsAll.length >= 1) {
    // Softer warning before the hard ban
    parts.push(
      `OPENING CAUTION: The library/archive has already been used as an opening setting in episode(s) ${libraryEpsAll.join(", ")}. ` +
      `Strongly prefer a different opening location this episode.`
    );
  }

  // Skeptic dismissal ban — "still chasing ghosts?" must NEVER repeat; ban after any single use
  const skepticAllEps = allTimeEpsWithTag("skeptic_dismissal");
  if (skepticAllEps.length >= 1) {
    parts.push(
      `DIALOGUE PERMANENTLY BANNED: Do NOT use any variation of "still chasing ghosts/shadows/monsters/ghosts in dusty books?" as the cold male lead's opening line. ` +
      `That dismissive line was already used in episode(s) ${skepticAllEps.join(", ")} and must never appear again in this series. ` +
      `He must open with something fresh — urgency, strategy, grudging respect, new information, or a direct challenge.`
    );
  }

  // Locked confirmed facts — inject once threat has been directly witnessed
  const threatConfirmedEp = allPrev.find((r) => Array.isArray(r.tags) && r.tags.includes("threat_confirmed"));
  if (threatConfirmedEp) {
    parts.push(
      `LOCKED SERIES FACT (established in episode ${threatConfirmedEp.episode}, cannot be undone): ` +
      `The threat/creature was directly witnessed and confirmed real by the main characters. ` +
      `No character may question whether it exists or treat it as rumor/imagination from this point forward. ` +
      `Reactions must be tactical, protective, or fear-based — NOT dismissive.`
    );
  }

  // Explicit opening beat ban — show the model the actual text of recent episode openings
  // so it cannot default to the same console/signal/approach structure episode after episode.
  const openingBeats = allPrev
    .slice(-10)
    .filter((r) => r.openingBeat && typeof r.openingBeat === "string" && r.openingBeat.length > 20)
    .map((r) => `  Ep ${r.episode}: "${r.openingBeat.slice(0, 160)}"`)
    .filter(Boolean);
  if (openingBeats.length >= 2) {
    parts.push(
      "FORBIDDEN OPENING STRUCTURES — the following are the ACTUAL OPENINGS already used in prior episodes.\n" +
      "Do NOT start this episode with the same location, the same first character action, or the same beat type " +
      "(e.g. character at a console/screen, signal/readings discussion, someone approaching from behind).\n" +
      "Write an opening the audience has not seen before:\n" +
      openingBeats.join("\n")
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------

const V2_SYSTEM_PROMPT = `You are a vertical episode writer for short-form / vertical dramas.

The user sends you a JSON object that describes one episode:
- episode number, total_episodes_for_show, arc_phase (hook / escalation / lock_in / spin_out)
- protagonist_type, core_theme, content_rating
- logline (season summary)
- scenes: list of scene_id, location, beat_type, characters

You MUST respond with ONLY a JSON array of blocks. Each block: block_id, episode, scene_id, type ("action" or "dialogue"), speaker (ALL CAPS for dialogue, null for action), text.

Follow the plan, write vivid action and natural dialogue. Strong hook in the first blocks, end on a cliffhanger or question. No commentary—only the JSON array.`;

function arcPhase(ep, total) {
  if (ep <= 0) return "unknown";
  if (ep <= 3) return "hook";
  if (ep <= 7) return "escalation";
  if (ep <= 21) return "lock_in";
  return "spin_out";
}

function buildEpisodeInput(ep, total, logline, genre) {
  const isWerewolf = (genre || "").toUpperCase() === "WEREWOLF";
  const phase = arcPhase(ep, total);
  return {
    show_id: "generated",
    episode: ep,
    total_episodes_for_show: total,
    arc_phase: phase,
    cliffhanger_flag: true,
    hook_profile: { visual_3s: true, theme_7s: true, emotion_21s: true },
    protagonist_type: "underdog_female",
    core_theme: isWerewolf ? "werewolf_curse" : "forbidden_romance",
    content_rating: "PG-13",
    logline: (logline || "").trim().slice(0, 1500),
    scenes: [
      { scene_id: `E${ep}_S1`, location: "INT. LOCATION - DAY", beat_type: "generic_drama", arc_phase: phase, characters: null },
      { scene_id: `E${ep}_S2`, location: "INT. / EXT. - DAY OR NIGHT", beat_type: "generic_drama", arc_phase: phase, characters: null },
    ],
  };
}

function safeStr(val) {
  if (val == null) return "";
  if (typeof val === "string") return val.trim();
  return String(val).trim();
}

function estimatePromptTokens(text) {
  // Approximate for telemetry only (English-heavy prompts).
  const s = safeStr(text);
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function titleCaseName(name) {
  const s = safeStr(name);
  if (!s) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const parts = w.split("-");
      return parts
        .map((p) =>
          p ? p[0].toUpperCase() + (p.length > 1 ? p.slice(1) : "") : p
        )
        .join("-");
    })
    .join(" ");
}

function normalizeNameKeyLoose(name) {
  return safeStr(name)
    .replace(/[’]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function levenshteinDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

function nameSimilarity(a, b) {
  const na = normalizeNameKeyLoose(a);
  const nb = normalizeNameKeyLoose(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

function extractAllCapsCueLines(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    // Character cue-ish: ALL CAPS name with optional parenthetical.
    if (!/^[A-Z0-9 '\-]+(?:\s*\([^)]*\))?$/.test(trimmed)) continue;
    if (/[.!?]/.test(trimmed)) continue;
    if (trimmed.length > 60) continue;
    out.push(trimmed);
  }
  return out;
}

function extractCueBaseNameFromHeaderLine(line) {
  let s = String(line || "").trim();
  const parenIdx = s.indexOf("(");
  if (parenIdx >= 0) s = s.slice(0, parenIdx).trimEnd();
  // Drop POV suffix from base.
  s = s.replace(/\s+POV$/i, "").trimEnd();
  // Drop possessive for base-key matching.
  s = s.replace(/('S|'s)$/i, "").trimEnd();
  return s;
}

const PLOT_CONTRACT_HEAVY_TAGS = new Set([
  "dock_beach_scan_open",
  "skeptic_dismissal",
  "library_research_open",
]);

function sortedTagSignature(tags) {
  if (!Array.isArray(tags) || !tags.length) return "";
  return [...new Set(tags)].sort().join("|");
}

function blueprintPlotKeywordProbe(plan) {
  const mc = safeStr(plan?.main_conflict);
  const ke = Array.isArray(plan?.key_events)
    ? plan.key_events.map((x) => safeStr(x)).join(" ")
    : safeStr(plan?.key_events);
  const blob = `${mc} ${ke}`.toLowerCase();
  const words = blob.match(/[a-z]{6,}/g) || [];
  const stop = new Set([
    "episode",
    "because",
    "however",
    "another",
    "something",
    "nothing",
    "everything",
    "someone",
    "against",
    "through",
    "between",
    "reveals",
    "discovers",
    "confronts",
    "realizes",
    "finally",
    "becomes",
    "decides",
    "attempts",
    "promises",
    "threatens",
  ]);
  const seen = new Set();
  const candidates = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    if (stop.has(w)) continue;
    candidates.push(w);
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates.slice(0, 3);
}

function blueprintKeywordViolations(episodeText, plan) {
  const violations = [];
  if (!plan || typeof plan !== "object") return violations;
  const top = blueprintPlotKeywordProbe(plan);
  if (top.length < 2) return violations;
  const body = safeStr(episodeText).toLowerCase();
  const missing = top.filter((w) => !body.includes(w));
  if (missing.length === top.length) {
    violations.push(
      `blueprint_keywords_absent: work the plan's vocabulary into the script (e.g. ${top.join(", ")})`
    );
  }
  return violations;
}

function looksLikeSupportingPlotCueName(base) {
  const t = safeStr(base);
  if (t.length < 3 || t.length > 48) return false;
  if (/^(INT|EXT|ANGLE|ON)\b/i.test(t)) return false;
  return true;
}

function supportingCastCueViolations(episodeText, seriesNames, registryPath) {
  const violations = [];
  if (!episodeText || !seriesNames || !registryPath) return violations;
  let registry = null;
  try {
    registry = loadCharacterNameRegistry(registryPath);
  } catch (_) {
    return violations;
  }
  if (!registry?.canonicalByKey) return violations;

  const trioHeaders = new Set(
    [seriesNames.heroine, seriesNames.coldCeo, seriesNames.warmFriend]
      .filter(Boolean)
      .map((n) => normalizeNameKeyLoose(n))
  );

  const cueLines = extractAllCapsCueLines(episodeText);
  const seenCue = new Set();

  for (const cueLine of cueLines) {
    const base = extractCueBaseNameFromHeaderLine(cueLine);
    if (!looksLikeSupportingPlotCueName(base)) continue;
    const nk = normalizeNameKeyLoose(base);
    if (!nk || trioHeaders.has(nk)) continue;

    let bestH = "";
    let bestSim = 0;
    for (const entry of Object.values(registry.canonicalByKey)) {
      const h = entry?.header;
      if (!h) continue;
      const sim = nameSimilarity(base, h);
      if (sim > bestSim) {
        bestSim = sim;
        bestH = h;
      }
    }
    if (bestSim < 0.88 || !bestH) continue;

    const partsB = base.trim().split(/\s+/);
    const partsH = bestH.trim().split(/\s+/);
    const lastB = partsB.length ? partsB[partsB.length - 1].toUpperCase() : "";
    const lastH = partsH.length ? partsH[partsH.length - 1].toUpperCase() : "";
    if (lastB && lastH && lastB !== lastH) continue;

    const normB = normalizeNameKeyLoose(base);
    const normH = normalizeNameKeyLoose(bestH);
    if (normB === normH) continue;

    if (!seenCue.has(normB)) {
      seenCue.add(normB);
      violations.push(
        `supporting_cast_cue_drift: cue "${base.trim()}" should match registry name "${bestH.trim()}"`
      );
    }
  }
  return violations;
}

function evaluatePlotContractViolations({
  episodeNumber,
  episodeText,
  episodeRecaps,
  blueprintPlan,
  seriesNames,
  registryPath,
}) {
  const violations = [];
  const tags = tagEpisodeEvents(episodeText);
  const sig = sortedTagSignature(tags);

  if (episodeNumber > 1 && Array.isArray(episodeRecaps)) {
    const prev = episodeRecaps.find((r) => r.episode === episodeNumber - 1);
    const prevTags = Array.isArray(prev?.tags) ? prev.tags : [];
    const prevSig = sortedTagSignature(prevTags);
    if (sig && prevSig && sig === prevSig) {
      violations.push(
        `event_tags_duplicate_previous_episode: ${sig.replace(/\|/g, ", ")}`
      );
    }

    const currHeavySet = new Set(tags.filter((t) => PLOT_CONTRACT_HEAVY_TAGS.has(t)));
    if (currHeavySet.size) {
      let streak = 0;
      for (let back = 1; back <= 5; back++) {
        const r = episodeRecaps.find((x) => x.episode === episodeNumber - back);
        const prevT = new Set(Array.isArray(r?.tags) ? r.tags : []);
        const shared = [...currHeavySet].some((t) => prevT.has(t));
        if (shared) streak++;
        else break;
      }
      if (streak >= 2) {
        violations.push(
          `heavy_event_tag_streak: opening/structural beat(s) ${[...currHeavySet].join(", ")} repeat across too many consecutive episodes`
        );
      }
    }
  }

  violations.push(...blueprintKeywordViolations(episodeText, blueprintPlan));
  violations.push(...supportingCastCueViolations(episodeText, seriesNames, registryPath));

  return { violations, tags };
}

function detectMainTrioNameMismatches(episodeText, names) {
  if (!episodeText || typeof episodeText !== "string") return [];
  if (!names) return [];

  const expected = [
    { key: normalizeNameKeyLoose(names.heroine), header: String(names.heroine).toUpperCase(), prose: titleCaseName(names.heroine), canonicalKey: "HEROINE" },
    { key: normalizeNameKeyLoose(names.coldCeo), header: String(names.coldCeo).toUpperCase(), prose: titleCaseName(names.coldCeo), canonicalKey: "MALE1" },
    { key: normalizeNameKeyLoose(names.warmFriend), header: String(names.warmFriend).toUpperCase(), prose: titleCaseName(names.warmFriend), canonicalKey: "MALE2" },
  ].filter((x) => x.key);

  if (!expected.length) return [];

  const cueLines = extractAllCapsCueLines(episodeText);
  const mismatches = [];

  for (const cueLine of cueLines) {
    const base = extractCueBaseNameFromHeaderLine(cueLine);
    const cueKey = normalizeNameKeyLoose(base);
    if (!cueKey) continue;

    for (const ex of expected) {
      if (cueKey === ex.key) continue;
      const sim = nameSimilarity(cueKey, ex.key);
      if (sim >= 0.92) {
        mismatches.push({
          expectedCanonicalKey: ex.canonicalKey,
          expectedHeader: ex.header,
          foundVariant: cueLine,
          locationHint: "cue header line",
        });
      }
    }
  }

  // Deduplicate by foundVariant.
  const seen = new Set();
  return mismatches.filter((m) => {
    const k = m.expectedCanonicalKey + "::" + m.foundVariant;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Directly fixes detected main-trio name variants in cue header lines.
 * Previously detection logged mismatches but never applied corrections — this is the fix.
 */
function applyMainTrioNameCorrections(episodeText, mismatches) {
  if (!mismatches || !mismatches.length || !episodeText) return episodeText;
  const lines = String(episodeText).split(/\r?\n/);
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    // Only operate on lines that look like character cue headers (ALL CAPS, optional parens)
    if (!/^[A-Z0-9 '\-]+(?:\s*\([^)]*\))?$/.test(trimmed)) return line;
    if (/[.!?]/.test(trimmed) || trimmed.length > 60) return line;
    // Extract base name (strip parenthetical, POV suffix, possessive)
    let base = trimmed;
    const parenIdx = base.indexOf("(");
    if (parenIdx >= 0) base = base.slice(0, parenIdx).trimEnd();
    base = base.replace(/\s+POV$/i, "").trimEnd();
    base = base.replace(/('S|'s)$/i, "").trimEnd();
    if (!base) return line;
    for (const mm of mismatches) {
      const variant = String(mm.foundVariant || "").trim();
      const expected = String(mm.expectedHeader || "").trim();
      if (!variant || !expected || variant === expected) continue;
      if (base === variant) {
        return line.replace(variant, expected);
      }
    }
    return line;
  }).join("\n");
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

async function validateMainTrioNameConsistencyWithLLM({
  episodeText,
  names,
  episodeNumber,
}) {
  if (!names) return null;
  const expected = [
    { expectedCanonicalKey: "HEROINE", expectedHeader: String(names.heroine).toUpperCase(), expectedProse: titleCaseName(names.heroine) },
    { expectedCanonicalKey: "MALE1", expectedHeader: String(names.coldCeo).toUpperCase(), expectedProse: titleCaseName(names.coldCeo) },
    { expectedCanonicalKey: "MALE2", expectedHeader: String(names.warmFriend).toUpperCase(), expectedProse: titleCaseName(names.warmFriend) },
  ];

  const cueLines = extractAllCapsCueLines(episodeText);
  const payload = cueLines.slice(0, 120); // cap to avoid token bloat

  const validation = await openai.chat.completions.create({
    model: NAME_VALIDATION_MODEL,
    messages: [
      { role: "system", content: NAME_CONSISTENCY_VALIDATION_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `EPISODE_NUMBER: ${episodeNumber}\n` +
          `EXPECTED_CANONICAL_NAMES:\n` +
          JSON.stringify(expected) +
          `\n\nCUE_LINES:\n` +
          payload.join("\n"),
      },
    ],
    max_tokens: 320,
    temperature: 0.2,
    frequency_penalty: 1.0,
    presence_penalty: 0.2,
  });

  const raw = validation.choices?.[0]?.message?.content;
  const json = extractJsonObject(raw);
  return json;
}

/** Words that are all-caps in action lines but must not be treated as character names when splitting merged cues. */
const MERGE_SPLIT_NAME_BLOCKLIST = new Set(
  [
    "AND",
    "THE",
    "BUT",
    "FOR",
    "NOT",
    "NOW",
    "ALL",
    "CAN",
    "HER",
    "HIS",
    "ITS",
    "OUR",
    "OUT",
    "OFF",
    "SHE",
    "THEY",
    "THEM",
    "THEN",
    "THAN",
    "THIS",
    "THAT",
    "THERE",
    "THESE",
    "THOSE",
    "WHAT",
    "WHEN",
    "WITH",
    "FROM",
    "INTO",
    "OVER",
    "UNDER",
    "ABOVE",
    "AFTER",
    "BEFORE",
    "WHILE",
    "DURING",
    "SUDDENLY",
    "SLOWLY",
    "FINALLY",
    "MEANWHILE",
    "WITHOUT",
    "INSIDE",
    "OUTSIDE",
    "BEHIND",
    "BESIDE",
    "ACROSS",
    "AROUND",
    "AGAINST",
    "THROUGH",
    "TOWARD",
    "EVERYONE",
    "SOMEONE",
    "SOMETHING",
    "NOTHING",
    "EVERYWHERE",
    "SILENCE",
    "FOOTSTEPS",
    "CHAOS",
    "BACK",
    "JUST",
    "ONLY",
    "EVEN",
    "STILL",
    "ALSO",
    "VERY",
    "MORE",
    "MOST",
    "SOME",
    "MANY",
    "MUCH",
    "SUCH",
    "INT",
    "EXT",
  ].map((w) => w.toUpperCase())
);

/**
 * Repairs common model mistakes: character cue glued to parenthetical or dialogue (e.g. LUKESorry, LUKE(mocking)Well).
 * Preserves intentional lines (scene headings, most action).
 */
function normalizeEpisodeScriptFormatting(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const raw of lines) {
    const m = raw.match(/^(\s*)(.*)$/);
    const indent = m ? m[1] : "";
    let rest = m ? m[2] : raw;
    let guard = 0;
    while (rest && guard++ < 10) {
      const t = rest.trimStart();
      const leadWs = rest.slice(0, rest.length - t.length);
      if (
        /^(INT\.|EXT\.|INT\/|EXT\/|I\/E\.|EST\.|FADE\s|CUT\s|DISSOLVE|END\s+OF\s+EPISODE|EPISODE\s+\d+)/i.test(
          t
        )
      ) {
        break;
      }
      // NAME(parenthetical)Dialogue — missing line breaks
      const parenMerge = t.match(/^([A-Z][A-Z0-9'\-]{1,20})(\([^)]+\))\s*(.+)$/);
      if (parenMerge && parenMerge[3].trim()) {
        const name = parenMerge[1].toUpperCase();
        if (!MERGE_SPLIT_NAME_BLOCKLIST.has(name)) {
          out.push(indent + leadWs + name);
          out.push(indent + leadWs + parenMerge[2]);
          rest = indent + leadWs + parenMerge[3].trimStart();
          continue;
        }
      }
      // NAME + DialogueWord (no space): LUKE + Sorry…
      const capMerge = t.match(/^([A-Z][A-Z0-9'\-]{1,20})([A-Z][a-z]{2,}[^\n]*)$/);
      if (capMerge) {
        const name = capMerge[1].toUpperCase();
        const dialogue = capMerge[2];
        if (!MERGE_SPLIT_NAME_BLOCKLIST.has(name) && name.length >= 2 && name.length <= 22) {
          out.push(indent + leadWs + name);
          rest = indent + leadWs + dialogue;
          continue;
        }
      }
      break;
    }
    out.push(rest || raw);
  }
  return out.join("\n");
}

/** "EPISODE 12" / common model typos — not real scene headings; app adds canonical markers when streaming. */
const SYNTHETIC_EPISODE_HEADING =
  /^\s*EP(?:ISODE|OSODE|ISDE|OSDE)\s+(\d+)\s*$/i;

function syntheticEpisodeNumberFromLine(line) {
  const m = String(line || "").trim().match(SYNTHETIC_EPISODE_HEADING);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Removes duplicate episode headings, END markers, and truncates when the model
 * packs multiple episode blocks into one response (e.g. EPISODE 27 … EPISODE 28 …).
 */
function stripEpisodeStructuralNoise(text, expectedEpisodeNumber) {
  if (!text || typeof text !== "string") return text;
  let lines = text.replace(/\r\n/g, "\n").split("\n");

  const spillIdx = lines.findIndex((raw) => {
    const n = syntheticEpisodeNumberFromLine(raw);
    return n != null && n > expectedEpisodeNumber;
  });
  if (spillIdx >= 0) {
    lines = lines.slice(0, spillIdx);
  }

  lines = lines.filter((raw) => syntheticEpisodeNumberFromLine(raw) == null);

  const standaloneEnd = /^\s*END\s+OF\s+(?:EPISODE|EPOSODE|EPISODES?|EPODES)\b/i;
  lines = lines.filter((l) => !standaloneEnd.test(l));

  const inlineEnd =
    /\s*\(\s*END\s+OF\s+(?:EPISODE|EPOSODE|EPISODES?|EPODES)\b[^)]*\)\s*$/i;
  lines = lines.map((l) => l.replace(inlineEnd, "").trimEnd());

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Heuristic repair for LLM token-boundary failures (enteringthe, Lucasthis, etc.).
 * Skips scene headings, episode markers, and short ALL-CAPS slug lines.
 */
function shouldSkipMergedWordFix(trimmed) {
  const t = trimmed.trim();
  if (!t) return true;
  if (/^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(t)) return true;
  if (/^EPISODE\s+\d/i.test(t)) return true;
  if (/^(FADE\s|CUT\s|DISSOLVE\b)/i.test(t)) return true;
  if (/^ONSCREEN\b/i.test(t)) return false;
  // Short slug-only lines (names, transitions in caps)
  if (!/[a-z]/.test(t) && t.length <= 48) return true;
  return false;
}

function fixMergedWordSpacingInLine(line) {
  const m = line.match(/^(\s*)(.*)$/);
  const indent = m ? m[1] : "";
  let body = m ? m[2] : line;
  const trimmed = body.trim();
  if (!trimmed || shouldSkipMergedWordFix(trimmed)) return line;

  let t = body;
  t = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  t = t.replace(/([.!?])([A-Z])/g, "$1 $2");
  t = t.replace(/([,;:])([A-Za-z])/g, "$1 $2");
  t = t.replace(/\bhisthere's\b/gi, "his there's");
  t = t.replace(/\bhisthere\b/gi, "his there");

  const glued = [
    [/\benteringthe\b/gi, "entering the"],
    [/\bnearbythe\b/gi, "nearby the"],
    [/\bsharplyand\b/gi, "sharply and"],
    [/\bcloseragain\b/gi, "closer again"],
    [/\bagainabout\b/gi, "again about"],
    [/\btogetherthen\b/gi, "together then"],
    [/\bLucasthis\b/gi, "Lucas this"],
    [/\bstiffensher\b/gi, "stiffens her"],
    [/\bherselfconsciously\b/gi, "herself consciously"],
    [/\bsomeoneelse\b/gi, "someone else"],
    [/\bwithoutwarning\b/gi, "without warning"],
    [/\bfrombehind\b/gi, "from behind"],
    [/\belsein\b/gi, "else in"],
    [/\bdresseda\b/gi, "dressed a"],
    [/\btoithis\b/gi, "to it his"],
    [/\bforithis\b/gi, "for it his"],
  ];
  for (const [re, rep] of glued) t = t.replace(re, rep);

  t = t.replace(/ {2,}/g, " ");
  return indent + t;
}

function fixMergedWordsEpisodeText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .split(/\r?\n/)
    .map((ln) => fixMergedWordSpacingInLine(ln))
    .join("\n");
}

function hasMergedWordIssues(text) {
  if (!text || typeof text !== "string") return false;
  const report = auditMergedWords(text);
  // Trigger retry if more than 1 merged word remains after post-processing.
  return report.totals.mergedTotal > 1;
}

const PROMPT_LEAK_LINE_PATTERNS = [
  /\bEND\s+OF\s+PREVIOUS\s+EPISODE\b/i,
  /\bWrite\s+episode\s+\d+\s+now\b/i,
  /\bcontinuing\s+directly\b/i,
  /\bline\s+spacing\s+separator\b/i,
  /\bmarking\s+transition\b/i,
  /\bCONTINUATION\s+REQUIREMENT\b/i,
  /\bCHARACTER\s+MANIFEST\b/i,
  /\bDo\s+NOT\s+output\b/i,
  /\bOutput\s+only\b.*\b(script|screenplay|content)\b/i,
  /\[\[\s*INTERNAL_CONTEXT_(?:BEGIN|END)\s*\]\]/i,
  /\[\[\s*DO_NOT_OUTPUT_INTERNAL_CONTEXT\s*\]\]/i,
  /\[\[\s*STORY_STATE_(?:BEGIN|END)\s*\]\]/i,
  /\[\[\s*DO_NOT_OUTPUT_STORY_STATE\s*\]\]/i,
  /\btoken\s+limit\b/i,
  /\bconversation\s+history\b/i,
  /\bmemory\s+retention\b/i,
  /\bsystem\s+messages?\b/i,
  /\bformatting\s+conventions?\b/i,
  /\bfont\s+size\s+style\b/i,
  /\bpage\s+number\s+line\s+spacing\b/i,
  /\binternal\s+context\s+markers?\b/i,
  /\bexplicit\s+content\s+disclaimers?\b/i,
  /\bcall-to-action\s+instructions?\b/i,
  /\bindustry\s+formatting\b/i,
  // Blueprint / prompt structure headers
  /\bCONTEXT\s+BUDGET\s+MODE\b/i,
  /\bEDITORIAL\s+COURSE\s+CORRECTION\b/i,
  /^BANNED\s+PATTERNS\s*:/i,
  /^REQUIRED\s+ADVANCES\s*:/i,
  /^FRESH\s+LOCATIONS\s*:/i,
  /^NARRATIVE\s+STATE\s*:/i,
  /\bTHIS\s+EPISODE'?S\s+PLAN\b/i,
  /\bTHIS\s+EPISODE'?S\s+SUMMARY\b/i,
  /\bMICRO[-\s]?STRUCTURE\b.*follow\s+this\s+order/i,
  /\bUNIQUE\s+SCENE\s*\(REQUIRED\b/i,
  /\bEPISODE\s+OPENING\s+HISTORY\b/i,
  /\bSERIES\s+HISTORY\b/i,
  /\bcharacter_state\s*:/i,
  /\blast_ending\s*:/i,
  /\brole\s*:\s*(heroine|cold_male|warm_male|protagonist)/i,
  /\bSetting\s*\(REQUIRED\s*[—-]/i,
  /\bEmotional\s+focus\s*\(REQUIRED\b/i,
];

function isMessyEpisodeDivider(line) {
  const t = String(line || "").trim();
  if (!t) return false;
  if (/^(?:-\d+\s+){2,}EP(?:ISODE|OSODE|ISDE|ODES?)\s*\d+/i.test(t)) return true;
  if (/^-{2,}\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s*\d+/i.test(t)) return true;
  if (/^-{2,}\s*$/.test(t)) return true;
  return false;
}

function sanitizeEpisodePromptLeaks(text, episodeNumber) {
  if (!text || typeof text !== "string") return { text, stripped: [] };
  const stripped = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) {
      kept.push(raw);
      continue;
    }

    if (PROMPT_LEAK_LINE_PATTERNS.some((re) => re.test(t))) {
      stripped.push({ line: i + 1, reason: "prompt_leak", text: t.slice(0, 220) });
      continue;
    }

    if (isMessyEpisodeDivider(t)) {
      stripped.push({ line: i + 1, reason: "dash_separator_noise", text: t.slice(0, 220) });
      continue;
    }

    // Remove explicit episode wrappers if model leaks them; pipeline adds canonical wrappers.
    if (/^\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*$/i.test(t)) {
      stripped.push({ line: i + 1, reason: "episode_heading_noise", text: t });
      continue;
    }
    if (/^\s*END\s+(?:OF\s+)?EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*$/i.test(t)) {
      stripped.push({ line: i + 1, reason: "episode_end_noise", text: t });
      continue;
    }

    kept.push(raw);
  }

  let cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) cleaned = `[Episode ${episodeNumber} content unavailable]`;

  // Canonical wrappers required by Phase 2.
  cleaned = `EPISODE ${episodeNumber}\n\n${cleaned}\n\nEND EPISODE ${episodeNumber}`;
  return { text: cleaned, stripped };
}

function finalizeEpisodeText(text, episodeNumber, names = null) {
  if (!text || typeof text !== "string") return text;
  // Phase 2 sequential normalisation:
  // 1) Strip prompt/meta leaks and enforce canonical EPISODE / END EPISODE wrappers
  // 2) Fix END EPISODE newline swallow + lowercase→uppercase boundary merges
  // 3) Strip structural noise and apply other spacing/line-break repairs.
  const sanitized = sanitizeEpisodePromptLeaks(text, episodeNumber);
  if (sanitized.stripped.length) {
    console.warn(
      `Sanitizer stripped ${sanitized.stripped.length} leak/noise lines in episode ${episodeNumber}:`,
      sanitized.stripped.slice(0, 12)
    );
  }
  const characterNames = names
    ? [names.heroine, names.coldCeo, names.warmFriend].filter(Boolean)
    : [];
  const mergeNorm = fixMergedWordIssuesPhase2Detailed(sanitized.text, {
    dynamicPatterns: DYNAMIC_MERGE_PATTERNS,
    characterNames,
  });
  let t = mergeNorm.text;
  if (!mergeNorm.idempotent || mergeNorm.logs.some((x) => x.count > 0)) {
    console.warn(`Merge normalizer metrics episode ${episodeNumber}:`, mergeNorm.logs);
  }
  t = stripEpisodeStructuralNoise(t, episodeNumber);
  t = fixMergedWordsEpisodeText(t);
  const normalized = normalizeEpisodeScriptFormatting(t).trim();
  return `EPISODE ${episodeNumber}\n\n${normalized
    .replace(/^\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*/i, "")
    .replace(/\s*END\s+EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*$/i, "")
    .trim()}\n\nEND EPISODE ${episodeNumber}`;
}

function splitScenesForAnchorValidation(text) {
  const lines = safeStr(text).split(/\r?\n/);
  const scenes = [];
  let current = null;
  const isHeading = (line) => /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(line.trim());
  for (const raw of lines) {
    const line = safeStr(raw);
    if (!line) continue;
    if (isHeading(line)) {
      if (current) scenes.push(current);
      current = { heading: line, lines: [] };
      continue;
    }
    if (!current) current = { heading: "IMPLIED SCENE", lines: [] };
    current.lines.push(line);
  }
  if (current) scenes.push(current);
  return scenes;
}

function buildSceneAnchors(names) {
  const out = new Set();
  const addName = (full) => {
    const s = safeStr(full);
    if (!s) return;
    out.add(s.toLowerCase());
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts[0]) out.add(parts[0].toLowerCase());
    if (parts.length > 1 && parts[parts.length - 1]) out.add(parts[parts.length - 1].toLowerCase());
  };
  addName(names?.heroine);
  addName(names?.coldCeo);
  addName(names?.warmFriend);
  return [...out];
}

function validateSceneAnchors(episodeText, names) {
  const scenes = splitScenesForAnchorValidation(episodeText);
  const nameAnchors = buildSceneAnchors(names);
  const actionVerbRe =
    /\b(steps?|walks?|turns?|looks?|stares?|grabs?|holds?|opens?|closes?|leans?|nods?|shakes?|runs?|sits?|stands?|moves?|whispers?|says?|asks?|answers?|breathes?|freezes?|reaches?)\b/i;
  const failures = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const sceneText = [s.heading, ...s.lines].join("\n");
    const hasName = nameAnchors.some((n) =>
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sceneText)
    );
    const hasActionVerb = actionVerbRe.test(sceneText);
    if (!hasName || !hasActionVerb) {
      failures.push({
        sceneIndex: i + 1,
        heading: s.heading,
        hasName,
        hasActionVerb,
      });
    }
  }
  return {
    sceneCount: scenes.length,
    failureCount: failures.length,
    failures,
    pass: failures.length === 0,
  };
}

async function rewriteEpisodeForAnchors({
  userContent,
  episodeText,
  episodeNumber,
  totalEpisodes,
  names,
}) {
  const anchorPrompt =
    userContent +
    "\n\nANCHOR ENFORCEMENT REWRITE:\n" +
    `This is episode ${episodeNumber} of ${totalEpisodes}. Rewrite the episode so that every scene includes:\n` +
    "- At least one canonical main-character name mention (heroine or one of the two male leads).\n" +
    "- At least one concrete action verb in action lines.\n" +
    "- Keep screenplay formatting and continuity; do not output lists or abstract vocabulary runs.\n\n" +
    "Current draft to fix:\n\n" +
    episodeText;
  const completion = await openai.chat.completions.create({
    model: FINETUNED_MODEL,
    messages: [
      { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
      { role: "user", content: anchorPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.4,
    frequency_penalty: 0.9,
    presence_penalty: 0.4,
  });
  const out = completion.choices?.[0]?.message?.content;
  return typeof out === "string" ? out.trim() : "";
}

/** Body character count, excluding the canonical EPISODE n / END EPISODE n wrappers. */
function episodeBodyCharCount(text) {
  const body = safeStr(text)
    .replace(/^\s*EPISODE\s+\d+\s*/i, "")
    .replace(/\s*END\s+EPISODE\s+\d+\s*$/i, "")
    .trim();
  return body.length;
}

/**
 * Phase 2 length gate helper: ask the model to condense an overlong episode to the budget while
 * preserving scenes, beats, dialogue, names, and formatting. Returns "" on failure.
 */
async function condenseEpisodeToBudget({
  episodeText,
  episodeNumber,
  totalEpisodes,
  attempt = 1,
  lenPlan = null,
}) {
  const plan = lenPlan || getEpisodeLengthPlan(episodeNumber, totalEpisodes);
  const condensePrompt =
    `This is episode ${episodeNumber} of ${totalEpisodes} of a vertical drama. ` +
    `The draft below is TOO LONG for the vertical format. Condense it to about ` +
    `${plan.targetChars} characters ` +
    `(~${plan.wordsLow}–${plan.wordsHigh} words); ` +
    `hard maximum ${plan.hardMaxChars} characters.\n\n` +
    (attempt > 1
      ? `(Attempt ${attempt}/${MAX_LENGTH_TRIM_ATTEMPTS}: the previous condense was still too long — cut harder.)\n\n`
      : "") +
    `Rules:\n` +
    `- Preserve the SAME scenes, characters, story beats, and the ending/cliffhanger.\n` +
    `- PROTECT THE OPENING: keep the electric cold open (the first scene's charged moment, its grounding, and its first strong line) intact — trim from the middle, not the hook.\n` +
    `- Keep all main character names and their exact spellings.\n` +
    `- Cut ONLY redundancy: trim repeated emotional beats, restated tension, and filler dialogue. ` +
    `Do NOT delete backstory, motive, world detail, or context — tighten existing lines rather than deleting plot or grounding.\n` +
    `- Keep screenplay format: INT./EXT. headings, ALL CAPS cues on their own line, dialogue on the next line.\n` +
    `- Do NOT add "EPISODE ${episodeNumber}" / "END EPISODE ${episodeNumber}" — the pipeline adds those.\n` +
    `- Output ONLY the condensed screenplay (no notes).\n\n` +
    `DRAFT TO CONDENSE:\n\n${episodeText}`;
  const completion = await openai.chat.completions.create({
    model: FINETUNED_MODEL,
    messages: [
      { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
      { role: "user", content: condensePrompt },
    ],
    max_tokens: plan.maxTokens,
    temperature: 0.3,
    frequency_penalty: 0.6,
    presence_penalty: 0.2,
  });
  const out = completion.choices?.[0]?.message?.content;
  return typeof out === "string" ? out.trim() : "";
}

// ── Phase D — Script Doctor (rubric scoring + bounded punch-up) ─────────────
const SCRIPT_DOCTOR_SYSTEM_PROMPT = `You are a sharp vertical-drama script doctor. You evaluate ONE episode draft against a craft rubric and report scores plus concrete, actionable weaknesses.
Score each dimension 1-5 (5 = excellent, 1 = poor):
- "hook": Does the OPENING grab instantly? Is the first moment charged, specific, and grounded (who/what/stakes clear fast), or flat/context-free?
- "escalation": Does a concrete NEW development actually happen on screen (a reveal, reversal, betrayal, raised stake)? Penalize vague restated menace ("someone is watching", "the threat is closer") where nothing changes.
- "voice": Are the characters' voices distinct and specific (not interchangeable)? Is the dialogue vivid rather than generic?
- "backstory": If this episode is REQUIRED to land a backstory beat (told below), did it deliver it through action/dialogue? If no backstory is required this episode, score 5.
- "overall": Your holistic read of whether this episode is compelling vertical drama.
Output ONLY JSON: { "hook": n, "escalation": n, "voice": n, "backstory": n, "overall": n, "weaknesses": ["short actionable fix", ...] }.
List weaknesses ONLY for dimensions scoring below 4; keep each under 18 words and specific. No prose, no markdown.`;

const SCRIPT_DOCTOR_REWRITE_SYSTEM_PROMPT = `You are a vertical-drama script doctor performing a precise punch-up pass.
You will receive an episode draft, the episode's plan, and a short list of weaknesses to fix.
Rewrite the episode to fix ONLY those weaknesses while keeping everything that already works.
Hard rules:
- Preserve the SAME plot, scenes, characters (exact name spellings), and the ending cliffhanger. Do NOT invent a new subplot.
- Strengthen the OPENING into an electric, specific, grounded hook if hook was weak.
- If escalation was weak, make the episode's concrete new development land clearly on screen (no vague menace).
- If voice was weak, sharpen distinct character voices and dialogue specificity.
- If backstory was weak and a beat is required, deliver it through action/dialogue (never a narrated info-dump).
- Keep screenplay format: INT./EXT. headings, ALL CAPS character cues on their own line, dialogue on the next line.
- Do NOT add "EPISODE n" / "END EPISODE n" markers — the pipeline injects those.
- Output ONLY the revised screenplay text (no notes, no JSON).`;

function buildDoctorPlanContext(plan, bible, episodeNumber) {
  const lines = [];
  if (plan && typeof plan === "object") {
    if (plan.title) lines.push(`Title: ${plan.title}`);
    if (plan.main_conflict) lines.push(`Main conflict: ${plan.main_conflict}`);
    if (plan.shock) lines.push(`REQUIRED shock (concrete new development): ${plan.shock}`);
    if (plan.cliffhanger) lines.push(`Cliffhanger: ${plan.cliffhanger}`);
    if (Array.isArray(plan.micro_beats) && plan.micro_beats[0]) {
      lines.push(`Intended hook beat: ${plan.micro_beats[0]}`);
    }
  }
  const beats = bible && Array.isArray(bible.backstory_beats) ? bible.backstory_beats : [];
  const dueBeat = beats.find(
    (b) => b && typeof b === "object" && Number(b.reveal_by_episode) === episodeNumber && b.beat
  );
  if (dueBeat) {
    lines.push(`REQUIRED backstory beat this episode: ${dueBeat.beat}`);
  } else {
    lines.push(`No backstory beat is required this episode (score backstory 5 unless it actively hurts).`);
  }
  return lines.join("\n");
}

async function scoreEpisodeWithDoctor({ episodeText, episodeNumber, totalEpisodes, plan, bible }) {
  const planContext = buildDoctorPlanContext(plan, bible, episodeNumber);
  const userPrompt =
    `Episode ${episodeNumber} of ${totalEpisodes}.\n\n` +
    `EPISODE PLAN / REQUIREMENTS:\n${planContext}\n\n` +
    `EPISODE DRAFT:\n${episodeText}`;
  const completion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: SCRIPT_DOCTOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 400,
    temperature: 0.2,
  });
  const content = safeStr(completion.choices?.[0]?.message?.content).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const obj = extractFirstBalancedJsonObject(content);
    if (obj) {
      try {
        parsed = JSON.parse(obj);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const clampScore = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(5, Math.round(n)));
  };
  const scores = {
    hook: clampScore(parsed.hook),
    escalation: clampScore(parsed.escalation),
    voice: clampScore(parsed.voice),
    backstory: clampScore(parsed.backstory),
    overall: clampScore(parsed.overall),
  };
  const dims = [scores.hook, scores.escalation, scores.voice, scores.backstory].filter(
    (n) => n != null
  );
  const minDim = dims.length ? Math.min(...dims) : null;
  const weaknesses = Array.isArray(parsed.weaknesses)
    ? parsed.weaknesses.filter((w) => typeof w === "string" && w.trim()).map((w) => w.trim())
    : [];
  return { scores, minDim, weaknesses };
}

async function punchUpEpisode({
  episodeText,
  episodeNumber,
  totalEpisodes,
  weaknesses,
  plan,
  bible,
  lenPlan,
  generatorSystemPrompt = "",
}) {
  const planContext = buildDoctorPlanContext(plan, bible, episodeNumber);
  const weaknessList = weaknesses.length
    ? weaknesses.map((w, i) => `${i + 1}. ${w}`).join("\n")
    : "Strengthen the opening hook, ensure a concrete new development lands, and sharpen distinct character voices.";
  const budget = lenPlan || getEpisodeLengthPlan(episodeNumber, totalEpisodes);
  const userPrompt =
    `Episode ${episodeNumber} of ${totalEpisodes}.\n\n` +
    `EPISODE PLAN / REQUIREMENTS:\n${planContext}\n\n` +
    `WEAKNESSES TO FIX (fix only these; keep everything else):\n${weaknessList}\n\n` +
    `Keep the rewrite within about ${budget.targetChars} characters (hard max ~${budget.hardMaxChars}).\n\n` +
    `EPISODE DRAFT TO IMPROVE:\n${episodeText}`;
  const systemPrompt = generatorSystemPrompt
    ? SCRIPT_DOCTOR_REWRITE_SYSTEM_PROMPT +
      "\n\n" +
      generatorSystemPrompt.slice(EPISODE_TEXT_SYSTEM_PROMPT.length)
    : SCRIPT_DOCTOR_REWRITE_SYSTEM_PROMPT;
  const completion = await openai.chat.completions.create({
    model: GENERATOR_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: budget.maxTokens,
    temperature: 0.5,
    frequency_penalty: 0.8,
    presence_penalty: 0.4,
  });
  const out = completion.choices?.[0]?.message?.content;
  return typeof out === "string" ? out.trim() : "";
}

function blocksToScriptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const lines = [];
  let lastScene = null;
  for (const b of blocks) {
    const sceneId = safeStr(b.scene_id);
    if (sceneId && sceneId !== lastScene) {
      const loc = safeStr(b.location) || "INT. SCENE - DAY";
      lines.push(loc.startsWith("INT") || loc.startsWith("EXT") ? loc : `INT. ${loc} - DAY`);
      lastScene = sceneId;
    }
    const type = safeStr(b.type || b.block_type || "action").toLowerCase();
    const text = safeStr(b.text);
    if (!text) continue;
    if (type === "dialogue" && (b.speaker != null && b.speaker !== "")) {
      lines.push(safeStr(b.speaker).toUpperCase() || "CHARACTER");
      lines.push(text);
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

// Editor prompt to gently reshape finales / endings toward resolution.
const ENDING_EDIT_SYSTEM_PROMPT = `You are an experienced story editor for serialized vertical romance dramas.

Your sole task is to lightly EDIT the episode script you are given so that the ENDING lands as a satisfying resolution instead of a cliffhanger.

Rules:
- Keep the overall episode structure, tone, and key events the same; do NOT rewrite the whole story from scratch.
- Focus almost entirely on the FINAL SCENE and the LAST 3–6 PARAGRAPHS.
- Remove or rewrite any lingering cliffhanger-style beats (new threats, "this has only begun", "someone watches from the shadows", surprise powerful figures introduced in the last scene, or teaser questions).
- Do NOT introduce any brand-new villains, bosses, institutions, or mysterious figures in the final scene.
- Make sure the last scene clearly LOWERS immediate danger and shows safety, acceptance, or a chosen future for the heroine and her relationships.
- The LAST LINE must feel like a complete, satisfying ending for this season (quiet moment, hopeful plan, or emotionally grounded closure), not a teaser.

Output:
- Return the FULL edited episode script in the same format (scene headings, dialogue, and action lines), but with the ending adjusted to satisfy the rules above.
- Preserve mandatory screenplay line breaks: scene headings and character cues on their own lines; never concatenate a character name with dialogue or parentheticals on one line.
- Do NOT add commentary or explanation—only the edited script.`;

function parseBlocksFromContent(content) {
  const raw = (content || "").trim();
  const jsonMatch = raw.match(/\s*(\[[\s\S]*\])\s*$/);
  const str = jsonMatch ? jsonMatch[1] : raw;
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

const SCRIPT_TRANSLATION_SYSTEM_PROMPT = `You are a professional screenplay translator for short-form vertical dramas.

You will receive ONE episode of an English script. Translate it into Simplified Chinese (简体中文).

Rules:
- Output ONLY the translated script for this episode. No preamble, notes, or markdown.
- Preserve line breaks and blank lines: the output should have the same paragraph structure as the input.
- Keep scene headings in standard English abbreviations (INT., EXT., DAY, NIGHT, CONTINUED, CUT TO:, FADE IN/OUT, V.O., O.S., etc.). You may translate the location name within a scene heading, but keep the INT./EXT. prefix and DAY/NIGHT suffix in English.
- Keep CHARACTER NAMES in ALL CAPS exactly as in the source (same spelling). Translate dialogue, action lines, and parentheticals into natural Simplified Chinese.
- CRITICAL — episode structure markers: keep the following lines in English exactly as they appear in the source. Do NOT translate, rephrase, or omit them:
  • Lines that begin with "EPISODE" followed by a number (e.g. "EPISODE 1", "EPISODE 7") — copy verbatim.
  • Lines that begin with "END EPISODE" followed by a number (e.g. "END EPISODE 1", "END EPISODE 7") — copy verbatim.
- Preserve emotional tone and subtext of dialogue (make it sound natural spoken Chinese drama, not stiff or overly literal).
- Do not add or remove scenes, lines, or episode markers.`;

async function translateEpisodeScriptToChinese(episodeNumber, totalEpisodes, englishText, { retries = 3, retryDelayMs = 4000 } = {}) {
  const src = safeStr(englishText);
  if (!src) return "";
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: TRANSLATION_MODEL,
        messages: [
          { role: "system", content: SCRIPT_TRANSLATION_SYSTEM_PROMPT },
          {
            role: "user",
            content: `This is episode ${episodeNumber} of ${totalEpisodes}.\n\n${src}`,
          },
        ],
        max_tokens: 4096,
        temperature: 0.35,
      });
      const out = completion.choices?.[0]?.message?.content;
      return typeof out === "string" ? out.trim() : "";
    } catch (err) {
      lastErr = err;
      const isRateLimit = err?.status === 429 && !/insufficient_quota/i.test(err?.message || "");
      // Only retry on transient rate limits, not hard quota or other errors
      if (isRateLimit && attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        console.warn(`Translation rate-limited on episode ${episodeNumber}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})…`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Plain-text episode generation (no JSON parsing) ---------------------------

const EPISODE_TEXT_SYSTEM_PROMPT = `You are a vertical drama scriptwriter focused on female-led romance dramas.

The user will give you control tags (language, genre, total episode count, episode index), a short series summary, and THREE MAIN CHARACTER NAMES via tags like:
[HEROINE=...] [MALE1=...] [MALE2=...]

This is always ONE SINGLE SERIES told over many episodes. All  episodes in the run must share:
- The same heroine (female protagonist), the same two main male leads, the same supporting cast names.
- A continuous plot line with clear beginning, middle, and end across the whole season.
- Stable relationships and history between characters that evolve, but are never reset or forgotten.
- The protagonists NEVER get replaced: do NOT switch to a new set of main characters mid-season. You may introduce supporting characters, but every episode must include the heroine and at least one of the two male leads, and the main plot must remain about this trio.

CRITICAL BOUNDARY RULE (never violate):
- The prompt may include STORY STATE sections wrapped in markers such as [[STORY_STATE_BEGIN]] ... [[STORY_STATE_END]].
- These markers and their contents are private continuity scaffolding. NEVER reproduce marker text, instruction text, transition notes, or any meta-commentary in output.
- Output ONLY screenplay content (scene headings, action, dialogue). No instructions, no notes, no boundary tokens.

If the logline explicitly gives character names, you may align the provided HEROINE/MALE1/MALE2 tags with those names, but once the names are fixed you MUST keep them consistent in every episode.

You must write ONE EPISODE of a short-form / vertical drama script with these rules:
- The clear protagonist is the underdog heroine.
- Most negative events, misunderstandings, and external pressure fall on HER shoulders; the audience experiences the story primarily through her emotions and choices.
- There is at least one handsome, powerful man who is drawn to her; very often there are TWO male leads whose rivalry or tension revolves around her.
- The long-term arc is that she will eventually marry into money/power (e.g., a rich or high-status man), but do NOT resolve this too quickly—keep the romantic stakes and uncertainty alive across episodes.
- Keep the heroine active and resilient: she faces humiliation, setbacks, and schemes, but gradually gains confidence, agency, and leverage.
- Use screenplay-style scene headings like "INT. LOCATION - DAY" or "EXT. LOCATION - NIGHT".
- Mix vivid action lines and natural dialogue (CHARACTER NAME in caps, then their lines).
- Keep the episode focused — use a small number of scenes; the per-episode budget in the prompt specifies how many.
- SETTING AND VARIETY (critical): If a THIS EPISODE'S PLAN is provided in the prompt, you MUST open in the setting_focus location listed there — do not substitute a different or more familiar location. Every episode in a 60-episode series must feel like it inhabits a distinct part of the world. Do not default to the same dock, beach, or lobby opening simply because it is comfortable. The season outline pre-planned a specific setting and conflict type for each episode — treat both as hard constraints, not suggestions.
- Every episode should have a HOOK at the beginning. For early and middle episodes (when [EPISODE] is not within the last 5 of [EPISODES]), also end on a clear hook for the next episode—but keep them emotionally driven and grounded. Opening hooks should feel like a sharp emotional moment: an awkward intimacy beat, the heroine being subtly bullied or underestimated, a charged first encounter, or a small but vivid humiliation that makes us care. Closing hooks in these episodes should be light but addictive: a promise, a tease, a jealousy beat, a sudden confession or near-confession, or the hint of danger/competition around love or status.
- Avoid graphic violence, gore, or long slapstick brawls. Do NOT ramble or list random objects, professions, or technical details; stay tightly focused on the characters, their feelings, and the immediate scene.
- SPECIAL RULE FOR LATE EPISODES (when [EPISODE] is within the last 5 of [EPISODES]): progressively reduce unresolved threats and begin resolving major plot lines instead of opening new ones. Any end-of-episode hook in these late episodes should feel like the last steps toward closure (emotional decisions, consequences, or final preparations), not a brand-new danger, mystery, or villain.
- FINAL EPISODE RULE (when [EPISODE] == [EPISODES]): you MUST treat this as a true finale. Fully resolve the main external threat and the core emotional arc. End the script on safety, acceptance, or a clearly chosen future for the heroine and her relationships. Do NOT add any new threat, twist, or unseen observer in the last scene, and do NOT tease another season—no "it’s not over", "someone watches from the shadows", or similar cliffhangers.

${EPISODE_QUALITY_DIRECTIVE}

CONFLICT AND ESCALATION REQUIREMENTS:
- Every episode must move at least ONE external stake forward in a concrete way (family approval/disapproval, money or contracts, company/pack politics, social reputation/public humiliation, or a rival’s scheme).
- Do NOT repeat the same "chase → corner → forced kiss" choreography in adjacent episodes. If a recent episode already used a strong physical-ownership beat, switch to a different form of conflict (verbal confrontation, public scene, business/family move, secret revealed, heroine gaining leverage).
- Physical closeness scenes (kisses, pinning, grabs) must either be clearly interrupted or have visible consequences, OR clearly increase the heroine’s agency (she sets a boundary, wins leverage, or initiates on her own terms).

ANTI-REPETITION AND FORMAT (critical — vertical scripts are sparse):
- Dialogue must dominate: each scene should be mostly character lines, not long prose.
- Action/stage direction: maximum 1–2 sentences per block. Never write long descriptive paragraphs; break into short beats (e.g. "She turns. He steps closer.").
- No adjective stacking: do NOT chain synonyms (e.g. incredible, extraordinary, miraculous, divine, magnificent). Use one strong word, then move on. Never repeat the same type of descriptor in a row.
- No lists of similar words or emotional synonyms. If you need intensity, use a single clear word and then action or dialogue.
- Do NOT output “synonym vomit” or word-list runs (e.g. many punctuation-free single-word adjectives across many lines). If you reach that point, rewrite the beat as normal screenplay action/dialogue.
- Each beat should be action or dialogue, not a run of descriptive adjectives.
- When you invent new powerful male characters (CEOs, bosses, shadowy masterminds), vary their names; do NOT repeatedly default to "Victor", "Lance", or "Ethan" across unrelated series. Prefer fresh, distinctive names that fit the setting and avoid name recycling.
 - Do NOT use the name "Victor" for ANY character unless it is explicitly provided in the [HEROINE=...] / [MALE1=...] / [MALE2=...] tags or in the user-provided logline. If you need a new name, pick something else.
 - When you invent new powerful male characters (CEOs, bosses, shadowy masterminds), vary their names; do NOT repeatedly default to "Lance" or "Ethan" across unrelated series. Prefer fresh, distinctive names that fit the setting and avoid name recycling.

WORD SPACING (critical — invalid output if broken):
- Put a normal ASCII space between every English word. Never merge tokens (e.g. "enteringthe", "histhere's", "nearbythe", "Lucasthis", "closeragainabout" are forbidden).
- After . ! ? and before the next sentence, include a space. After , ; : before the next word if needed, include a space.
- Hyphenated compounds are fine ("self-consciously"); random merges like "herselfconsciously" are not — use two words or a correct hyphenated form.

STRUCTURED BEATS (avoid dense run-ons):
- Prefer one short action thought per line or per sentence — not a single line that chains many clauses with commas (that pattern causes missing spaces and merged words).
- After each distinct beat ("Leo hands her a glass." / "Their fingers brush.") use a newline before the next beat when the line is getting long or dense.

SCREENPLAY LINE BREAKS (mandatory — parsers and PDF layout depend on this):
- Put each scene heading (e.g. INT. ROOM - NIGHT) on its own line, followed by a blank line, then the first action or dialogue.
- Character cue: the speaking character’s name in ALL CAPS alone on one line. The next line is their spoken dialogue (or a parenthetical on its own line between name and dialogue).
- NEVER glue a character name to dialogue or to a parenthetical on the same line. Forbidden examples: LUKESorry… / LUKE(mocking)You… / COLEUrgently… — always split onto separate lines.
- After each action paragraph or each line of dialogue, use a newline before the next element. Do not run multiple speakers or multiple action beats into one paragraph without line breaks.
- Transitions (FADE OUT., CUT TO:, etc.) go on their own line with a blank line before and after when they separate major beats.

STRUCTURE (critical — avoids broken exports):
- Do NOT output lines like "EPISODE 7" or "END OF EPISODE". The pipeline already knows the episode index and adds canonical "EPISODE n" / "END EPISODE n" wrappers when saving. Start with your cold open or the first INT./EXT. scene heading.
- Format-rescue, finetuned retries, and generator fallbacks MUST follow this same rule — never add synthetic boundary lines to "fix" format; correct scene headings and cues only.
- Write exactly ONE episode per response: never stack multiple "EPISODE N" sections or sneak in the next episode’s beats after an "END OF EPISODE" marker.

Output only script text for that episode. Do NOT output JSON, arrays, or any extra commentary.`;

/**
 * Builds the system prompt for GENERATOR_MODEL by combining:
 * 1. The full EPISODE_TEXT_SYSTEM_PROMPT (all format + anti-repetition rules)
 * 2. The vdrama style guide produced by the fine-tuned model for this logline
 * 3. The genre style notes produced by the planner model for this genre
 *
 * Falls back to EPISODE_TEXT_SYSTEM_PROMPT alone if either guide is empty.
 */
function buildGeneratorSystemPrompt({ vdramaStyleGuide = "", genreStyleNotes = "" }) {
  const sections = [EPISODE_TEXT_SYSTEM_PROMPT];

  if (vdramaStyleGuide) {
    sections.push(
      "\n\n--- SERIES STYLE GUIDE (produced by vdrama specialist — follow these character voices and pacing rules for every episode) ---\n" +
      vdramaStyleGuide
    );
  }

  if (genreStyleNotes) {
    sections.push(
      "\n\n--- GENRE STYLE NOTES (produced by genre consultant — follow tone, stakes, and avoid-list for every episode) ---\n" +
      genreStyleNotes
    );
  }

  return sections.join("");
}

const EPISODE_PLAN_SYSTEM_PROMPT = `You are a TV episode planner.
Return STRICT JSON only with this exact shape:
{
  "episodeNumber": number,
  "title": string,
  "scenePlan": [
    {
      "sceneIndex": number,
      "sceneHeading": string,
      "purpose": string,
      "mustIncludeCharacters": string[],
      "beats": string[]
    }
  ],
  "closingHook": string
}

Rules:
- Scene count: for early/establishing episodes (when [EPISODE] is 1, 2, or 3) plan 3–4 scenes; otherwise plan 2–3 scenes (prefer 2–3). Vertical episodes are short — do NOT plan 5+ scenes.
- Keep each scene's "beats" tight (2–4 beats). Match the LENGTH BUDGET given in the user prompt (establishing episodes have a larger budget than regular ones).
- Keep continuity with provided context.
- Keep the same three protagonist names exactly as provided.
- No markdown, no prose outside JSON.`;

const EPISODE_RENDER_FROM_PLAN_SYSTEM_PROMPT = `You are a screenplay writer.
You will receive:
1) episode context
2) a strict scene plan JSON

Write screenplay text for ONE episode only.
Rules:
- Follow the provided scene plan in order.
- Keep scene headings, action, and dialogue clear.
- Character cues must be on their own lines in ALL CAPS.
- Hard anti-merge contract:
  - Never glue words (e.g. togetherjust, Ruicollapses, beforeturningquicklytowardsthe).
  - Never glue cue/dialogue (e.g. LUKESorry).
- Action-line constraint:
  - Maximum 16 words per action line.
  - Break dense action into multiple short lines.
- Formatting contract:
  - Add a blank line after each scene heading.
  - Add a newline between distinct action beats.
- Keep continuity with prior context.
${EPISODE_QUALITY_DIRECTIVE}
- Output script text only (no JSON, no notes).`;

function parseEpisodePlanJson(raw, episodeNumber) {
  const text = safeStr(raw).trim();
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}$/);
  const payload = jsonMatch ? jsonMatch[0] : text;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.scenePlan) || parsed.scenePlan.length < 2) return null;
    parsed.episodeNumber = Number(parsed.episodeNumber) || episodeNumber;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function generateEpisodeTextTwoPass({
  userContent,
  episodeNumber,
  totalEpisodes,
  names,
  language,
  genre,
  generatorSystemPrompt = "",
}) {
  const lenPlan = getEpisodeLengthPlan(episodeNumber, totalEpisodes);
  const planCompletion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: EPISODE_PLAN_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 1400,
    temperature: 0.35,
  });
  const planRaw = planCompletion.choices?.[0]?.message?.content;
  const plan = parseEpisodePlanJson(planRaw, episodeNumber);
  if (!plan) {
    return { ok: false, reason: "plan_parse_failed", text: "" };
  }

  const renderPrompt =
    `[LANG=${String(language || "EN").toUpperCase()}] [GENRE=${safeStr(genre) || "Romance"}] ` +
    `[EPISODES=${totalEpisodes}] [EPISODE=${episodeNumber}]\n` +
    `[HEROINE=${safeStr(names?.heroine)}] [MALE1=${safeStr(names?.coldCeo)}] [MALE2=${safeStr(
      names?.warmFriend
    )}]\n\n` +
    `CONTEXT:\n${userContent}\n\n` +
    `SCENE PLAN JSON:\n${JSON.stringify(plan, null, 2)}\n\n` +
    buildEpisodeLengthDirective(episodeNumber, totalEpisodes) +
    "\n\n" +
    buildOpeningDirective(episodeNumber, totalEpisodes);

  // Use GENERATOR_MODEL for the render pass (primary generation, not corrective).
  // Append style guides from generatorSystemPrompt if available.
  const renderSystemPrompt = generatorSystemPrompt
    ? EPISODE_RENDER_FROM_PLAN_SYSTEM_PROMPT + "\n\n" +
      generatorSystemPrompt.slice(EPISODE_TEXT_SYSTEM_PROMPT.length)
    : EPISODE_RENDER_FROM_PLAN_SYSTEM_PROMPT;

  const renderCompletion = await openai.chat.completions.create({
    model: GENERATOR_MODEL,
    messages: [
      { role: "system", content: renderSystemPrompt },
      { role: "user", content: renderPrompt },
    ],
    max_tokens: lenPlan.maxTokens,
    temperature: 0.45,
    frequency_penalty: 1.0,
    presence_penalty: 0.5,
  });
  const rendered = renderCompletion.choices?.[0]?.message?.content;
  return {
    ok: typeof rendered === "string" && rendered.trim().length > 0,
    reason: "ok",
    text: typeof rendered === "string" ? rendered.trim() : "",
    plan,
  };
}

const NAME_CONSISTENCY_VALIDATION_SYSTEM_PROMPT = `You are a script formatting auditor.

Your task: given an episode's character cue lines, check whether the main trio character names are spelled consistently with the provided canonical spellings.

Important:
- Only inspect character cue headers (ALL CAPS speaker cue lines), including optional parentheticals like "(V.O.)", "(O.S.)", "(CONT'D)", "(WEAKLY)".
- Do NOT rewrite or modify the script.
- Identify likely misspellings/variants (case differences and letter transpositions) for the main trio only.

Output STRICT JSON with this shape:
{
  "ok": boolean,
  "mismatches": [
    {
      "expectedCanonicalKey": string,
      "expectedHeader": string,
      "foundVariant": string,
      "locationHint": string
    }
  ],
  "notes": string
}`;

function formatBlueprintContext(blueprint, episodeNumber) {
  if (!blueprint || !Array.isArray(blueprint.episodes)) return "";
  const total = blueprint.episodes.length;
  const ep = Math.max(1, Math.min(episodeNumber, total));
  const lines = [];

  // ── FULL SEASON VARIETY MAP ────────────────────────────────────────────────
  // Show the planned setting + conflict type for EVERY episode so the model
  // can see the full diversity that was designed and never deviate from it.
  // Format is compact: one short line per episode (~10-15 tokens total per line).
  lines.push("FULL SEASON PLAN — setting and conflict type for every episode (MANDATORY — never substitute a different location or conflict type):");
  for (let i = 0; i < blueprint.episodes.length; i++) {
    const p = blueprint.episodes[i];
    if (!p) continue;
    const epNum = p.episode ?? i + 1;
    const setting = p.setting_focus || "—";
    const conflict = p.conflict_type || "—";
    const emotional = p.emotional_focus || "";
    const marker = epNum === ep ? " ◄ THIS EPISODE" : (epNum < ep ? " ✓ done" : "");
    lines.push(`  Ep ${epNum}: setting=${setting} | conflict=${conflict}${emotional ? ` | emotion=${emotional}` : ""}${marker}`);
  }
  lines.push("");

  // ── CHARACTER ROLE CONSTRAINTS ─────────────────────────────────────────────
  if (Array.isArray(blueprint.characters) && blueprint.characters.length) {
    lines.push("CHARACTER ROLE CONSTRAINTS (do NOT break these):");
    for (const c of blueprint.characters) {
      if (!c || typeof c.name !== "string") continue;
      const name = c.name.trim();
      if (!name) continue;
      const role = typeof c.role === "string" ? c.role : "";
      const goal = typeof c.goal === "string" ? c.goal : "";
      const traits = Array.isArray(c.traits) ? c.traits.join(", ") : "";
      const taboos = Array.isArray(c.taboos) ? c.taboos.join(", ") : "";
      const parts = [`- ${name}`];
      if (role) parts.push(`role: ${role}`);
      if (goal) parts.push(`goal: ${goal}`);
      if (traits) parts.push(`traits: ${traits}`);
      if (taboos) parts.push(`taboos: ${taboos}`);
      lines.push(parts.join(" | "));
    }
    lines.push("");
  }

  // ── PROTAGONIST STORY BIBLE (backstory engine + reveal ladder) ─────────────
  const bible = blueprint.protagonist_bible;
  if (bible && typeof bible === "object") {
    lines.push("PROTAGONIST STORY BIBLE (the heroine's emotional engine — her choices, fears, and reactions must flow from this):");
    if (bible.wound)   lines.push(`  Wound: ${bible.wound}`);
    if (bible.ghost)   lines.push(`  Ghost (what haunts her): ${bible.ghost}`);
    if (bible.secret)  lines.push(`  Secret she hides: ${bible.secret}`);
    if (bible.want)    lines.push(`  Want (external goal): ${bible.want}`);
    if (bible.need)    lines.push(`  Need (internal truth she must learn): ${bible.need}`);
    if (bible.the_lie) lines.push(`  The lie she believes (her arc is overcoming this): ${bible.the_lie}`);
    if (bible.voice)   lines.push(`  Voice / how she carries herself: ${bible.voice}`);

    const beats = Array.isArray(bible.backstory_beats) ? bible.backstory_beats : [];
    if (beats.length) {
      const dueNow = [];
      const alreadyRevealed = [];
      const upcoming = [];
      for (const b of beats) {
        if (!b || typeof b !== "object" || !b.beat) continue;
        const by = Number(b.reveal_by_episode) || 0;
        if (by === ep) dueNow.push(b.beat);
        else if (by > 0 && by < ep) alreadyRevealed.push(b.beat);
        else upcoming.push({ beat: b.beat, by });
      }
      if (dueNow.length) {
        lines.push("  ► BACKSTORY TO REVEAL THIS EPISODE (deliver through action/dialogue/subtext — never a narrated info-dump):");
        for (const b of dueNow) lines.push(`     - ${b}`);
      }
      if (alreadyRevealed.length) {
        lines.push("  Backstory already established earlier (stay consistent; do NOT re-explain it at length):");
        for (const b of alreadyRevealed) lines.push(`     - ${b}`);
      }
      if (upcoming.length) {
        lines.push("  Backstory still to come (do NOT reveal yet — you may lightly foreshadow):");
        for (const u of upcoming) lines.push(`     - (by ep ${u.by}) ${u.beat}`);
      }
    }
    lines.push("");
  }

  // ── PREVIOUS EPISODES SUMMARY (all past, not just last 8) ─────────────────
  if (ep > 1) {
    lines.push("PREVIOUS EPISODES — planned arc (already happened; continue from here):");
    for (let i = 0; i < ep - 1; i++) {
      const plan = blueprint.episodes[i];
      if (plan && (plan.title || plan.main_conflict)) {
        const epNum = plan.episode ?? i + 1;
        const title = plan.title || `Episode ${epNum}`;
        const conflict = plan.main_conflict || plan.cliffhanger || "";
        const setting = plan.setting_focus ? ` [${plan.setting_focus}]` : "";
        lines.push(`  Ep ${epNum}${setting}: ${title}. ${conflict}`);
      }
    }
    lines.push("");
  }

  // ── SHOCK LEDGER (escalations already spent — never repeat one) ────────────
  if (ep > 1) {
    const priorShocks = [];
    for (let i = 0; i < ep - 1; i++) {
      const p = blueprint.episodes[i];
      const shock = p && typeof p.shock === "string" ? p.shock.trim() : "";
      if (shock) priorShocks.push(`  Ep ${p.episode ?? i + 1}: ${shock}`);
    }
    if (priorShocks.length) {
      lines.push(
        "SHOCK LEDGER — concrete escalations already used in earlier episodes (this episode's new development must be DIFFERENT from every one of these; never reuse a beat):"
      );
      lines.push(...priorShocks);
      lines.push("");
    }
  }

  // ── CURRENT EPISODE PLAN ───────────────────────────────────────────────────
  const plan = blueprint.episodes[ep - 1];
  if (plan && typeof plan === "object") {
    lines.push("THIS EPISODE'S PLAN (follow this beat for beat — every field below is a hard constraint, not a suggestion):");
    lines.push(`  Title: ${plan.title || `Episode ${ep}`}`);
    // setting_focus and emotional_focus were missing before — now explicitly enforced
    if (plan.setting_focus) lines.push(`  Setting (REQUIRED — episode must be set here): ${plan.setting_focus}`);
    if (plan.emotional_focus) lines.push(`  Emotional focus (REQUIRED — dominant emotional tone): ${plan.emotional_focus}`);
    if (plan.heroine_state) lines.push(`  Heroine state: ${plan.heroine_state}`);
    if (plan.male1_state)   lines.push(`  Male lead 1 state: ${plan.male1_state}`);
    if (plan.male2_state)   lines.push(`  Male lead 2 state: ${plan.male2_state}`);
    if (plan.main_conflict) lines.push(`  Main conflict: ${plan.main_conflict}`);
    if (plan.hook_type)     lines.push(`  Hook type: ${plan.hook_type}`);
    if (plan.conflict_type) lines.push(`  Conflict type: ${plan.conflict_type}`);
    if (plan.key_events && plan.key_events.length)
      lines.push(`  Key events: ${plan.key_events.join("; ")}`);
    if (plan.twist_or_reveal) lines.push(`  Twist/reveal: ${plan.twist_or_reveal}`);
    if (plan.shock)
      lines.push(
        `  SHOCK (REQUIRED — the ONE concrete new development this episode must deliver; it must actually happen on screen and must not repeat any prior episode's shock): ${plan.shock}`
      );
    if (plan.cliffhanger)     lines.push(`  End on cliffhanger: ${plan.cliffhanger}`);
    if (plan.unique_scene)    lines.push(`  UNIQUE SCENE (REQUIRED — must appear, must be new, must not repeat any prior episode): ${plan.unique_scene}`);
    if (Array.isArray(plan.micro_beats) && plan.micro_beats.length === 4) {
      lines.push("  MICRO-STRUCTURE (follow this order exactly — these are the four required beats):");
      lines.push(`    1) HOOK: ${plan.micro_beats[0]}`);
      lines.push(`    2) CONFLICT: ${plan.micro_beats[1]}`);
      lines.push(`    3) MINI-TWIST: ${plan.micro_beats[2]}`);
      lines.push(`    4) CLIFFHANGER: ${plan.micro_beats[3]}`);
    }
  }

  return lines.length ? lines.join("\n") : "";
}

// How many prior episodes to include in full for continuation (token budget).
const PREVIOUS_EPISODES_IN_CONTEXT = 1;

/** Minimal user prompt for collapse rescue — avoids resending the full context that triggered the failure. */
function buildCollapseRescueUserPrompt({
  language,
  genre,
  totalEpisodes,
  episodeNumber,
  logline,
  names,
  blueprint,
}) {
  const langTag = String(language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
  const genreTag = String(genre || "Romance").trim() || "Romance";
  const total = Math.max(1, totalEpisodes || 1);
  const ep = Math.max(1, episodeNumber || 1);
  const blueprintContext = formatBlueprintContext(blueprint, ep);
  const parts = [
    `[LANG=${langTag}] [GENRE=${genreTag}] [EPISODES=${total}] [EPISODE=${ep}]`,
  ];
  if (names?.heroine && names?.coldCeo && names?.warmFriend) {
    parts.push(
      `[HEROINE=${names.heroine}] [MALE1=${names.coldCeo}] [MALE2=${names.warmFriend}]`
    );
  }
  parts.push(`[LOGLINE] ${safeStr(logline).slice(0, 500)}`);
  parts.push(
    "Write ONE complete episode of screenplay for the episode number above. Use the cast and logline only. Named characters only. Concrete action and dialogue. No abstract prose, no philosophy monologues, no vocabulary lists, no stitched-in 'bonus' sequences or multi-act sagas. Short-form vertical drama, dialogue-forward. Use standard screenplay format: scene headings (INT./EXT.), character cues in ALL CAPS, dialogue on the following line."
  );
  parts.push(buildEpisodeLengthDirective(ep, total));
  parts.push(buildOpeningDirective(ep, total));
  const rescueBackstory = buildBackstoryDirective(ep);
  if (rescueBackstory) parts.push(rescueBackstory);
  if (blueprintContext) {
    parts.push(
      `THIS EPISODE PLAN (follow beats; stay concrete):\n${blueprintContext.slice(0, 600)}`
    );
  }
  return parts.join("\n\n");
}

/**
 * Mid-batch review: after every 5 episodes, analyse the last batch and produce
 * a course-correction brief injected into the next 5 episodes' prompts.
 * Acts as the automated equivalent of a human editor reviewing and redirecting.
 */
async function runMidBatchReview({
  batchStart,
  batchEnd,
  recaps,
  genre,
  seriesNames,
  blueprint,
}) {
  const batchRecaps = recaps.filter(
    (r) => r.episode >= batchStart && r.episode <= batchEnd
  );
  if (batchRecaps.length === 0) return "";

  const recapBlock = batchRecaps
    .map(
      (r) =>
        `Episode ${r.episode}: ${safeStr(r.recap).slice(0, 300)}` +
        (r.openingFingerprint
          ? ` [opening: ${r.openingFingerprint.location || "?"} | ${r.openingFingerprint.action || "?"} | ${r.openingFingerprint.dialogue_type || "?"}]`
          : "")
    )
    .join("\n");

  const nextBatchStart = batchEnd + 1;
  const nextBatchEnd = batchEnd + 5;

  const prompt =
    `You are the script editor for a ${genre} vertical drama series.\n` +
    `The series stars: heroine=${seriesNames.heroine}, cold lead=${seriesNames.coldCeo}, warm lead=${seriesNames.warmFriend}.\n\n` +
    `EPISODES ${batchStart}–${batchEnd} JUST COMPLETED. Here are their summaries and opening structures:\n\n` +
    `${recapBlock}\n\n` +
    `Your job: produce a COURSE CORRECTION BRIEF for episodes ${nextBatchStart}–${nextBatchEnd}.\n\n` +
    `The brief must contain exactly these four sections:\n` +
    `BANNED PATTERNS: List 3–5 specific scene types, locations, or action beats that appeared in episodes ${batchStart}–${batchEnd} and must NOT be repeated in the next batch. Be specific (e.g. "carrying heroine out of a room", "training center lobby confrontation").\n` +
    `REQUIRED ADVANCES: List 2–3 specific plot threads or character dynamics that MUST move forward in the next batch — name the characters and the unresolved tension.\n` +
    `FRESH LOCATIONS: List 3 specific new locations (never used in this batch) where scenes should be set.\n` +
    `NARRATIVE STATE: One paragraph describing exactly where each of the three leads stands emotionally and physically entering episode ${nextBatchStart}.\n\n` +
    `Be concrete and specific. Do not be vague. Output only the four sections, no preamble.`;

  try {
    const resp = await openai.chat.completions.create({
      model: PLANNER_MODEL,
      max_tokens: 600,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "You are a professional script editor. Produce concise, specific editorial briefs. No filler.",
        },
        { role: "user", content: prompt },
      ],
    });
    const brief = resp.choices?.[0]?.message?.content?.trim() || "";
    return brief;
  } catch (err) {
    console.warn("Mid-batch review failed:", err?.message || err);
    return "";
  }
}

function buildEpisodePromptText({
  language,
  genre,
  totalEpisodes,
  episodeNumber,
  logline,
  names,
  genreBible,
  blueprint,
  episodeSummaries,
  recaps,
  previousEpisodeStates = [],
  previousEpisodeScripts = [],
  narrativeResetText = "",
  trimContext = ENABLE_TRIMMED_CONTEXT,
  courseCorrectionBrief = "",
}) {
  const langTag = String(language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
  const genreTag = String(genre || "Romance").trim() || "Romance";
  const total = Math.max(1, totalEpisodes || 1);
  const ep = Math.max(1, episodeNumber || 1);
  const cleanLogline = safeStr(logline).slice(0, 1500);

  const lines = [
    `[LANG=${langTag}] [GENRE=${genreTag}] [EPISODES=${total}] [EPISODE=${ep}]`,
  ];
  if (names && names.heroine && names.coldCeo && names.warmFriend) {
    lines.push(
      `[HEROINE=${names.heroine}] [MALE1=${names.coldCeo}] [MALE2=${names.warmFriend}]`
    );
    lines.push(
      `In this series, the heroine is ${names.heroine} (female underdog), ` +
        `the cold powerful male lead is ${names.coldCeo}, and the warm supportive male lead is ${names.warmFriend}. ` +
        `Use THESE exact names consistently in every episode unless the logline explicitly overrides them.`
    );
    // Phase 3: upstream prompt reinforcement — locked manifest for cue headers + prose mentions.
    lines.push("");
    lines.push("CHARACTER MANIFEST (locked canonical spellings; do NOT vary):");
    lines.push(
      `- HEROINE HEADER: ${String(names.heroine).toUpperCase()} | PROSE: ${titleCaseName(
        names.heroine
      )} | POSSESSIVE: ${String(names.heroine).toUpperCase()}'S`
    );
    lines.push(
      `- MALE1 HEADER: ${String(names.coldCeo).toUpperCase()} | PROSE: ${titleCaseName(
        names.coldCeo
      )} | POSSESSIVE: ${String(names.coldCeo).toUpperCase()}'S`
    );
    lines.push(
      `- MALE2 HEADER: ${String(names.warmFriend).toUpperCase()} | PROSE: ${titleCaseName(
        names.warmFriend
      )} | POSSESSIVE: ${String(names.warmFriend).toUpperCase()}'S`
    );
    lines.push(
      "RULE: Any ALL CAPS dialogue cue/header for these characters MUST match the HEADER spellings exactly. Any prose/action mentions MUST use the PROSE spellings exactly."
    );
    if (names.corporationName) {
      lines.push(
        `For finance/boardroom storylines use this corporation consistently: ${names.corporationName}.`
      );
    }
    // Pre-generated supporting cast pool — prevents the model defaulting to recycled names
    if (names.supportingNames) {
      const m = Array.isArray(names.supportingNames.male)   ? names.supportingNames.male.join(", ")   : "";
      const f = Array.isArray(names.supportingNames.female) ? names.supportingNames.female.join(", ") : "";
      if (m || f) {
        lines.push("");
        lines.push("SUPPORTING CHARACTER NAME POOL (use these for any new characters introduced in this episode):");
        if (m) lines.push(`  Male supporting names: ${m}`);
        if (f) lines.push(`  Female supporting names: ${f}`);
        lines.push("  Do NOT default to Victor, Ethan, Lance, or other overused names. Draw from the pool above.");
      }
    }
    if (!blueprint) {
      const fb = formatFallbackCharacterConstraints(names);
      if (fb) {
        lines.push("");
        lines.push(fb);
      }
    }
  }
  if (cleanLogline) {
    lines.push(`[LOGLINE] ${cleanLogline}`);
  }

  if (genreBible && typeof genreBible === "object") {
    const threat = safeStr(genreBible.threat);
    const stakes = safeStr(genreBible.stakes);
    const hub = safeStr(genreBible.setting_hub);
    const obstacle = safeStr(genreBible.central_obstacle);
    const rules = Array.isArray(genreBible.rules)
      ? genreBible.rules.map((r) => safeStr(r)).filter(Boolean).slice(0, 4)
      : [];
    if (threat || stakes || hub || rules.length) {
      lines.push("");
      lines.push("GENRE BIBLE (must remain true across all episodes):");
      if (hub) lines.push(`- Setting hub (do not drift): ${hub}`);
      if (obstacle) lines.push(`- Central obstacle: ${obstacle}`);
      if (threat) lines.push(`- Core threat: ${threat}`);
      if (stakes) lines.push(`- Stakes: ${stakes}`);
      if (rules.length) {
        lines.push(`- Rules: ${rules.join(" | ")}`);
      }
      lines.push(
        "- Continuity lock: do NOT replace the protagonists. Do NOT introduce a new storyline that doesn't include the heroine and BOTH male leads."
      );
      lines.push("");
    }
  }

  const blueprintContext = formatBlueprintContext(blueprint, ep);
  const seriesHistory = ep > 3 ? formatSeriesHistoryBlock(recaps, ep) : "";
  const recapContext = narrativeResetText
    ? `NARRATIVE RESET CHECKPOINT:\n${narrativeResetText}`
    : trimContext
    ? (() => {
        if (!Array.isArray(recaps) || !recaps.length) return "";
        const prev = recaps
          .filter((r) => typeof r.episode === "number" && r.episode < ep)
          .slice(ep < 20 ? -6 : ep < 40 ? -5 : -4); // expanded from -3/-2/-1
        if (!prev.length) return "";
        const maxChars = ep < 20 ? 220 : ep < 40 ? 160 : 120;
        const compact = prev.map((r) => `Ep ${r.episode}: ${safeStr(r.recap).slice(0, maxChars)}`);
        return ["COMPACT STORY STATE (recent recaps):", ...compact].join("\n");
      })()
    : formatRecapContext(recaps, ep);
  const summaryText =
    episodeSummaries && episodeSummaries instanceof Map
      ? episodeSummaries.get(ep)
      : null;
  const recentEvents = formatRecentEventConstraints(recaps, ep);
  const openingHistory = ep > 1 ? formatOpeningHistory(recaps, ep) : "";

  if (blueprintContext || seriesHistory || recapContext || summaryText || recentEvents || openingHistory) {
    lines.push("");
    if (blueprintContext) lines.push(blueprintContext);
    if (seriesHistory) {
      if (blueprintContext) lines.push("");
      lines.push(seriesHistory);
    }
    if (recapContext) {
      if (blueprintContext || seriesHistory) lines.push("");
      lines.push(recapContext);
    }
    if (recentEvents) {
      if (blueprintContext || seriesHistory || recapContext) lines.push("");
      lines.push(recentEvents);
    }
    if (openingHistory) {
      if (blueprintContext || seriesHistory || recapContext || recentEvents) lines.push("");
      lines.push(openingHistory);
    }
    if (summaryText) {
      if (blueprintContext || recapContext || recentEvents || openingHistory) lines.push("");
      lines.push("THIS EPISODE'S SUMMARY (follow this beat for beat; do not invent new major subplots):");
      lines.push(summaryText);
    }
    lines.push("");
  }

  // Continuity: inject the raw tail of the previous episode(s) so the model continues
  // from the EXACT last moment on screen — not from an abstract summary.
  // Raw tail text is the primary driver of scene variety: the model cannot reset to a
  // familiar location because it is anchored to wherever the previous episode ended.
  // Abstract state (location/ending/character_state) is kept as a supplementary note only.
  if (ep > 1 && Array.isArray(previousEpisodeScripts) && previousEpisodeScripts.length > 0) {
    const TAIL_LINES = 30;
    const toInclude = previousEpisodeScripts.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
    const label = toInclude.length === 1 ? "PREVIOUS EPISODE" : "PREVIOUS EPISODES";
    lines.push("");
    lines.push(
      `CONTINUATION REQUIREMENT (critical for this format): The audience has just paid to see what happens next. ` +
      `Below is the exact end of the ${label}. You MUST continue the story immediately from the next moment — ` +
      `same scene, same characters, same emotional beat. Do not time-skip, change location, or restart; ` +
      `pick up from the last line or action and continue.`
    );
    lines.push(
      `DO NOT restage the same key moments from the previous episode. ` +
      `If you need to reference them, compress into one short recap line, then move FORWARD with new events.`
    );
    lines.push("");
    toInclude.forEach((script, i) => {
      const which = toInclude.length === 1 ? "PREVIOUS EPISODE" : `EPISODE ${ep - toInclude.length + i}`;
      const full = safeStr(script).trim();
      const tail = full.split(/\r?\n/).slice(-TAIL_LINES).join("\n");
      lines.push(`--- END OF ${which} ---`);
      lines.push(tail);
      lines.push(`--- END OF ${which} ---`);
      lines.push("");
    });
    // Supplementary: abstract state for character continuity (not the primary continuation signal)
    if (Array.isArray(previousEpisodeStates) && previousEpisodeStates.length > 0) {
      const states = previousEpisodeStates.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
      const lastState = states[states.length - 1];
      if (lastState && (lastState.character_state || lastState.ending)) {
        lines.push("CHARACTER STATE ENTERING THIS EPISODE (supplementary — the tail text above takes priority):");
        if (lastState.character_state) lines.push(`  character_state: ${safeStr(lastState.character_state)}`);
        if (lastState.ending) lines.push(`  last_ending: ${safeStr(lastState.ending)}`);
        lines.push("");
      }
    }
    lines.push(`Write episode ${ep} now, continuing directly from the text above.`);
    lines.push("");
  } else if (ep > 1 && Array.isArray(previousEpisodeStates) && previousEpisodeStates.length > 0) {
    // Fallback: no raw scripts available, use abstract state only
    const toInclude = previousEpisodeStates.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
    lines.push("");
    lines.push(`CONTINUATION REQUIREMENT: Continue immediately from previous episode state with no timeline reset.`);
    lines.push("");
    toInclude.forEach((state, i) => {
      const which = toInclude.length === 1 ? "PREVIOUS EPISODE" : `EPISODE ${ep - toInclude.length + i}`;
      lines.push(`${which}: location=${safeStr(state.location)} | ending=${safeStr(state.ending)} | character_state=${safeStr(state.character_state)}`);
    });
    lines.push("");
  }

  if (trimContext) {
    lines.push("CONTEXT BUDGET MODE: compact continuity context is enabled.");
  }

  let phase;
  if (ep <= Math.max(3, Math.floor(total * 0.1))) {
    phase = "beginning (set-up: humiliation and underdog struggles)";
  } else if (ep <= Math.max(15, Math.floor(total * 0.5))) {
    phase = "middle (escalating love triangle, secrets, and power imbalance)";
  } else if (ep <= Math.max(25, Math.floor(total * 0.8))) {
    phase = "late middle (big reversals, heroine gains leverage, villains exposed)";
  } else {
    phase = "finale arc (resolving major conflicts, moving toward marriage/powerful ending)";
  }

  const isFinalEpisode = ep === total;
  const isLandingZone = ep >= Math.max(1, total - 4); // last 5 episodes

  // If we're in the finale arc, steer toward a genre-appropriate planned ending.
  let plannedEnding = "";
  if (phase.startsWith("finale")) {
    const endingsData = loadEndingsByGenre();
    const endingsList = Array.isArray(endingsData[genreTag]) ? endingsData[genreTag] : [];
    if (endingsList.length > 0) {
      plannedEnding = endingsList[Math.floor(Math.random() * endingsList.length)];
    }
  }

  if (plannedEnding) {
    lines.push("");
    lines.push(
      `PLANNED ENDING FOR THE SEASON (guidance): The overall story should ultimately resolve like this: ${plannedEnding}`
    );
    if (isFinalEpisode) {
      lines.push(
        `Because this is the FINAL episode, you MUST fully resolve the main conflicts and land on this kind of emotional resolution. ` +
          `Do NOT cut the story off in the middle of major consequences—after the main climax include at least one clear aftermath or epilogue beat that matches this ending tone.`
      );
    } else if (isLandingZone) {
      lines.push(
        `Because we are now in the last few episodes of the finale arc, this episode must actively steer the plot and emotions toward this resolution. ` +
          `Begin closing open threads and avoid introducing brand-new major threats; any hook at the end should feel like the last breaths before resolution, not a fresh storyline.`
      );
    } else {
      lines.push(
        `Because we are now in the finale arc, this episode should meaningfully push the story toward that resolution—even if it still ends on a hook.`
      );
    }
  }

  if (ep <= 10) {
    lines.push(
      "HOOK REQUIREMENT (early episodes): Start with a small but sharp emotional moment (awkward intimacy, subtle bullying, jealousy, or a vivid humiliation) and end with a light but addictive hook (a tease, promise, jealousy beat, or near-confession). No graphic violence, no gore, no long slapstick fights; stay close to the characters’ feelings."
    );
  }

  if (isFinalEpisode) {
    // Final episode: land the story instead of adding a new cliffhanger.
    lines.push(
      `This is episode ${ep} of ${total}, the FINAL episode of this continuous story about the same heroine and the same two male leads. ` +
        `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
        (blueprintContext
          ? `Follow the season outline and THIS EPISODE'S PLAN above. `
          : "") +
        (ep > 1 && previousEpisodeStates.length > 0
          ? `You have been given the exact previous episode text above—continue from its last line. `
          : "") +
        `Treat this as the finale and bring the main plot lines and central relationships to a clear resolution. ` +
        `If a PLANNED ENDING is given above, you MUST shape the climax and the aftermath so the emotional tone and outcome match that planned ending. ` +
        `Do NOT end on a brand-new cliffhanger; instead, after the main climax include at least one short aftermath or epilogue beat showing how the heroine and the leads live with the consequences. ` +
        `In the FINAL SCENE and FINAL PARAGRAPHS you must NOT introduce any new villains, bosses, institutions, or mysterious figures (no surprise CEOs, no new organisations, no unknown watchers); only already-known characters may appear. ` +
        `The last 3–5 paragraphs must LOWER the immediate danger level and show safety, acceptance, or a clearly chosen future for the heroine. The final line should read as a satisfying series ending, not as a question or teaser. ` +
        `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
    );
  } else {
    // Non-final episodes
    if (isLandingZone) {
      // Landing zone: start closing threads, softer hooks.
      lines.push(
        `This is episode ${ep} of ${total} of ONE continuous story about the same heroine and the same two male leads. ` +
          `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
          (blueprintContext
            ? `Follow the season outline and THIS EPISODE'S PLAN above. `
            : "") +
          (ep > 1 && previousEpisodeStates.length > 0
            ? `You have been given the exact previous episode text above—continue from its last line. `
            : "") +
          `Treat this as part of the finale arc, and begin RESOLVING major plot lines and emotional arcs rather than opening new ones. ` +
          `Do NOT introduce brand-new central villains, conspiracies, or powerful organisations in these late episodes; focus on paying off what already exists. ` +
          `Any end-of-episode hook in this landing zone should feel like the last steps toward closure (final confrontations, decisions, or consequences), not like the start of a new storyline. Each of these endings must feel more stable and closer to resolution than the previous episode. ` +
          `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
      );
    } else {
      // Regular episodes: strong hooks.
      lines.push(
        `This is episode ${ep} of ${total} of ONE continuous story about the same heroine and the same two male leads. ` +
          `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
          (blueprintContext
            ? `Follow the season outline and THIS EPISODE'S PLAN above. `
            : "") +
          (ep > 1 && previousEpisodeStates.length > 0
            ? `You have been given the exact previous episode text above—continue from its last line. `
            : "") +
          `Treat this as the ${phase}, and continue the same plot line. ` +
          `Maintain consistency with earlier implied events and keep the tone and premise aligned with the logline. ` +
          `End on a strong cliffhanger or unresolved emotional beat for the heroine. ` +
          `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
      );
    }
  }
  lines.push(
    "Output formatting: blank line after each scene heading; each character cue (ALL CAPS name) on its own line with dialogue on the following line — never output glued cues like LUKESorry or LUKE(mocking)You."
  );
  lines.push("");
  lines.push(buildOpeningDirective(ep, total));
  const epBackstory = buildBackstoryDirective(ep);
  if (epBackstory) {
    lines.push("");
    lines.push(epBackstory);
  }
  lines.push("");
  lines.push(buildEpisodeLengthDirective(ep, total));

  if (courseCorrectionBrief) {
    lines.push("");
    lines.push("EDITORIAL COURSE CORRECTION (from script editor review — treat every item below as a hard constraint for this episode):");
    lines.push(courseCorrectionBrief);
    lines.push("");
  }

  return lines.join("\n");
}

function sendStreamLine(res, obj) {
  if (!res || res.writableEnded) return;
  try {
    res.write(JSON.stringify(obj) + "\n");
  } catch (_) {}
}

/** Same pipeline as streaming /generate, but writes are discarded (background jobs). */
function createNoOpStreamResponse() {
  return {
    writableEnded: false,
    destroyed: false,
    headersSent: true,
    socket: null,
    setHeader() {},
    flushHeaders() {},
    status() {
      return this;
    },
    write(_chunk, cb) {
      if (typeof cb === "function") queueMicrotask(cb);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
}

function joinEpisodeScriptsForStorage(scripts) {
  if (!Array.isArray(scripts)) return "";
  let full = "";
  for (let i = 0; i < scripts.length; i++) {
    const ep = i + 1;
    const t = String(scripts[i] || "").trim();
    const block = /^EPISODE\s+\d+/i.test(t) ? t : `EPISODE ${ep}\n\n${t}`;
    full += (full ? "\n\n" : "") + block;
  }
  return full;
}

async function persistEpisodeProgress(persist, episodeScriptsMemo, episodeCount) {
  if (!persist?.scriptId || !persist?.userId) return;
  const full = joinEpisodeScriptsForStorage(episodeScriptsMemo);
  await updateScriptProgress(persist.scriptId, persist.userId, {
    english_text: full,
    episode_done: episodeScriptsMemo.length,
    episode_target: episodeCount,
    status: "generating",
  });
}

function buildCollapseSafeEpisodeFallbackSync({
  episodeNumber,
  totalEpisodes,
  names,
  genre,
  summary,
  plan,
}) {
  const heroine = safeStr(names?.heroine) || "THE HEROINE";
  const male1 = safeStr(names?.coldCeo) || "MALE LEAD 1";
  const male2 = safeStr(names?.warmFriend) || "MALE LEAD 2";
  const heroineUpper = heroine.toUpperCase();
  const male1Upper = male1.toUpperCase();
  const male2Upper = male2.toUpperCase();
  const isFinal = episodeNumber === totalEpisodes;

  const isWerewolf = /horror|monster|werewolf/i.test(String(genre || ""));
  const isAction = /action|crime|superhero/i.test(String(genre || ""));

  // Pull concrete details from blueprint plan if available
  const conflict = safeStr(plan?.main_conflict).trim();
  const cliffhanger = safeStr(plan?.cliffhanger).trim();
  const keyEvents = Array.isArray(plan?.key_events) ? plan.key_events.filter(Boolean) : [];

  // Pick locations appropriate to genre
  const loc1 = isWerewolf ? "INT. PACK HOUSE - DAY" : isAction ? "INT. PRECINCT - DAY" : "INT. OFFICE LOBBY - DAY";
  const loc2 = isWerewolf ? "EXT. FOREST CLEARING - NIGHT" : isAction ? "EXT. CITY STREET - NIGHT" : "INT. PRIVATE OFFICE - NIGHT";

  // Build a plausible conflict line from plan data or fallback
  const conflictLine = conflict
    ? conflict
    : `The tension between ${heroine} and ${male1} reaches a breaking point.`;

  // Build a scene-1 beat using the first key event if present
  const beat1 = keyEvents[0]
    ? `${keyEvents[0]}`
    : `${heroine} faces an unexpected confrontation she cannot ignore.`;

  // Scene 2 beat
  const beat2 = keyEvents[1]
    ? `${keyEvents[1]}`
    : `${male1} makes a decision that changes everything.`;

  // Closing line
  const closingLine = isFinal
    ? `${heroine} finally takes back control of her own story.`
    : cliffhanger
    ? cliffhanger
    : `${heroine} knows the next move will define who she really is.`;

  return [
    loc1,
    "",
    `${conflictLine}`,
    "",
    heroineUpper,
    "I'm not running from this. Not anymore.",
    "",
    male1Upper,
    "Then stand your ground. I'll be right here.",
    "",
    `${beat1}`,
    "",
    loc2,
    "",
    `${beat2}`,
    "",
    male2Upper,
    "Whatever happens next — I'm with you.",
    "",
    heroineUpper,
    "Then let's finish this.",
    "",
    `${closingLine}`,
  ].join("\n");
}

async function buildCollapseSafeEpisodeFallback(params) {
  const { episodeNumber, totalEpisodes, names, genre, summary, plan } = params;
  const heroine = safeStr(names?.heroine) || "the heroine";
  const male1   = safeStr(names?.coldCeo) || "the male lead";
  const male2   = safeStr(names?.warmFriend) || "the second lead";
  const setting  = safeStr(plan?.setting_focus) || "an interior location";
  const conflict = safeStr(plan?.main_conflict) || "a personal confrontation";
  const microBeats = Array.isArray(plan?.micro_beats) ? plan.micro_beats.filter(Boolean) : [];
  const keyEvents  = Array.isArray(plan?.key_events)  ? plan.key_events.filter(Boolean)  : [];
  const cliffhanger = safeStr(plan?.cliffhanger);
  const isFinal = episodeNumber === totalEpisodes;

  const beatLines = microBeats.length
    ? `Beats to hit:\n${microBeats.map((b) => `- ${b}`).join("\n")}`
    : keyEvents.length
    ? `Key events:\n${keyEvents.map((e) => `- ${e}`).join("\n")}`
    : "";

  const endingInstruction = isFinal
    ? "This is the series finale — resolve the main arc with emotional closure."
    : cliffhanger
    ? `End with this hook: ${cliffhanger}`
    : "End on an emotional hook that draws the viewer into the next episode.";

  const userPrompt = [
    `Write episode ${episodeNumber} of ${totalEpisodes} of a vertical drama series.`,
    `Genre: ${genre || "drama"}`,
    `Characters: ${heroine} (heroine), ${male1} (male lead 1), ${male2} (male lead 2)`,
    `Setting: ${setting}`,
    `Main conflict: ${conflict}`,
    beatLines,
    summary ? `Episode summary: ${summary}` : "",
    endingInstruction,
    "",
    "Write a SHORT but COMPLETE screenplay episode (2–3 scenes). Rules:",
    "- Use INT./EXT. scene headings (e.g. INT. LOCATION - DAY).",
    "- Character name in ALL CAPS alone on its own line, then dialogue on the next line.",
    "- Action/description: 1–2 short sentences per block.",
    "- Do NOT output episode numbers, metadata, or commentary — screenplay content only.",
    buildEpisodeLengthDirective(episodeNumber, totalEpisodes),
    buildOpeningDirective(episodeNumber, totalEpisodes),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await openai.chat.completions.create({
      model: PLANNER_MODEL,
      max_tokens: Math.min(900, PRIMARY_EPISODE_MAX_TOKENS),
      temperature: 0.72,
      messages: [
        {
          role: "system",
          content:
            "You are a vertical drama screenplay writer. Write compact, well-formatted screenplay scenes. Use proper INT./EXT. scene headings, ALL CAPS character cues on their own lines, natural dialogue, and keep action lines to 1–2 sentences. Output only screenplay content.",
        },
        { role: "user", content: userPrompt },
      ],
    });
    const generated = safeStr(resp.choices?.[0]?.message?.content).trim();
    if (generated.length > 200) return generated;
  } catch (llmErr) {
    console.error(`LLM fallback generation failed for episode ${episodeNumber}:`, llmErr?.message);
  }

  // Deterministic backstop when LLM call fails.
  return buildCollapseSafeEpisodeFallbackSync(params);
}

function targetedCollapseSpanRepair(text, names) {
  const lines = safeStr(text).split(/\r?\n/);
  if (!lines.length) return text;
  const anchors = buildNameAnchors(names);
  const repaired = [];
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.length >= 6) {
      const heroine = safeStr(names?.heroine) || "THE HEROINE";
      const male1 = safeStr(names?.coldCeo) || "MALE LEAD 1";
      const male2 = safeStr(names?.warmFriend) || "MALE LEAD 2";
      repaired.push(`${heroine.toUpperCase()}`);
      repaired.push("Stay with me. We focus on what matters right now.");
      repaired.push("");
      repaired.push(`${male1.toUpperCase()}`);
      repaired.push("We move to the next concrete step. No distractions.");
      repaired.push("");
      repaired.push(`${male2.toUpperCase()}`);
      repaired.push("I'm here. We decide together and keep moving.");
    } else {
      repaired.push(...run);
    }
    run = [];
  };

  for (const raw of lines) {
    const line = safeStr(raw);
    if (!line) {
      flushRun();
      repaired.push("");
      continue;
    }
    const isScene = /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(line);
    const isCue = /^[A-Z][A-Z0-9 '\-]{1,30}$/.test(line) && !/^(EPISODE|END EPISODE|FADE|CUT)/i.test(line);
    const hasName = anchors.some((n) =>
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line)
    );
    const words = line.split(/\s+/).filter(Boolean);
    const looksUnanchored =
      !isScene &&
      !isCue &&
      !hasName &&
      (words.length >= 10 || (lineHasCollapseLexicon(line) && words.length >= 8));
    if (looksUnanchored) {
      run.push(line);
      continue;
    }
    flushRun();
    repaired.push(line);
  }
  flushRun();
  return repaired.join("\n");
}

function targetedRepairEpisodeText(text, names) {
  const mergeRes = fixMergedWordIssuesPhase2Detailed(text, {
    characterNames: [names?.heroine, names?.coldCeo, names?.warmFriend].filter(Boolean),
    dynamicPatterns: DYNAMIC_MERGE_PATTERNS,
  });
  const collapsed = targetedCollapseSpanRepair(mergeRes.text, names);
  return {
    text: collapsed,
    spanRepairsApplied: mergeRes.logs.reduce((acc, x) => acc + (x.count || 0), 0),
    repairTypes: mergeRes.logs.filter((x) => (x.count || 0) > 0).map((x) => x.rule),
  };
}

function includesWord(haystack, word) {
  const s = safeStr(haystack);
  if (!s) return false;
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
  return re.test(s);
}

function pickReplacementNameForVictor() {
  // Keep a small curated set to avoid odd/unfitting replacements.
  const pool = ["Damien", "Tristan", "Dominic", "Sebastian", "Marcus", "Adrian", "Vincent", "Malcolm"];
  return pool[Math.floor(Math.random() * pool.length)];
}

const SCRIPT_CREDITS_REQUIRED_ERROR =
  "Purchase credits to generate a script! / 购买剧本额度后方可生成剧本！";

const CONCURRENT_GENERATIONS_CAP_ERROR = `You already have ${MAX_CONCURRENT_GENERATIONS_PER_USER} scripts generating. Wait for one to finish or check My Scripts. / 您已有 ${MAX_CONCURRENT_GENERATIONS_PER_USER} 个剧本正在生成，请等待完成或在「我的剧本」中查看。`;

async function refundOneScriptCredit(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return;
  try {
    const pool = getPool();
    await pool.query(`UPDATE users SET script_credits = script_credits + 1 WHERE id = $1`, [id]);
  } catch (e) {
    console.error("refundOneScriptCredit:", e);
  }
}

/**
 * When JWT auth is on, atomically subtract one script credit before generation starts.
 * Returns true if the response was already sent (error).
 */
async function consumeOneScriptCreditOrReject(req, res) {
  if (!isJwtAuthEnabled()) return false;
  const uid = Number(req.auth?.sub);
  if (!Number.isFinite(uid)) {
    res.status(401).json({ error: "Unauthorized" });
    return true;
  }
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE users SET script_credits = script_credits - 1
       WHERE id = $1 AND script_credits >= 1
       RETURNING script_credits`,
      [uid]
    );
    if (r.rowCount === 0) {
      const row = await getUserPlanRow(uid);
      if (!row) {
        res.status(403).json({ error: "Account not found." });
        return true;
      }
      res.status(403).json({ error: SCRIPT_CREDITS_REQUIRED_ERROR });
      return true;
    }
    return false;
  } catch (e) {
    console.error("consumeOneScriptCreditOrReject:", e);
    res.status(500).json({ error: "Could not update script credits." });
    return true;
  }
}

/** When JWT auth is on, reject if user already has max concurrent generating scripts. */
async function rejectIfConcurrentGenerationCapOrReject(req, res) {
  if (!isJwtAuthEnabled()) return false;
  const uid = Number(req.auth?.sub);
  if (!Number.isFinite(uid)) {
    res.status(401).json({ error: "Unauthorized" });
    return true;
  }
  try {
    const n = await countGeneratingScriptsForUser(uid);
    if (n >= MAX_CONCURRENT_GENERATIONS_PER_USER) {
      res.status(429).json({ error: CONCURRENT_GENERATIONS_CAP_ERROR });
      return true;
    }
  } catch (e) {
    console.error("rejectIfConcurrentGenerationCapOrReject:", e);
    res.status(500).json({ error: "Could not verify active generations." });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth (optional) - bcrypt + Postgres + JWT bearer
// Enable by setting:
// - AUTH_ENABLED=true
// - JWT_SECRET=... (required)
// - Postgres vars (DATABASE_URL or PGHOST+PGUSER+PGDATABASE(+PGPASSWORD))
// ---------------------------------------------------------------------------
app.post("/auth/register", (req, res) => registerUser(req, res));
app.post("/auth/login", (req, res) => loginUser(req, res));
app.post("/auth/confirm-email", (req, res) => verifyEmailCode(req, res));

app.get("/plan-tiers", (_req, res) => {
  res.json({ planTiers: [...PLAN_TIERS] });
});

app.get("/me", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) return res.json({ user: null });
  try {
    const uid = Number(req.auth?.sub);
    if (!Number.isFinite(uid)) return res.status(401).json({ error: "Unauthorized" });
    const row = await getUserPlanRow(uid);
    if (!row) return res.status(404).json({ error: "user not found" });
    res.json({
      user: {
        id: row.id,
        email: row.email,
        planTier: row.plan_tier,
        scriptCredits: Number(row.script_credits ?? 0),
        stripeSubscriptionId: row.stripe_subscription_id || null,
        subscriptionCancelAtPeriodEnd: !!row.subscription_cancel_at_period_end,
        subscriptionCurrentPeriodEnd: row.subscription_current_period_end
          ? new Date(row.subscription_current_period_end).toISOString()
          : null,
      },
    });
  } catch (e) {
    console.error("GET /me:", e);
    res.status(500).json({ error: e.message || "failed" });
  }
});

app.post("/vsinfinite/stripe/cancel-subscription", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "JWT auth is not enabled on this server." });
  }
  const secretKey = process.env.STRIPE_SECRET_KEY || null;
  if (!secretKey) return res.status(503).json({ error: "Stripe is not configured." });

  const uid = Number(req.auth?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "Unauthorized" });

  const row = await getUserPlanRow(uid);
  if (!row) return res.status(404).json({ error: "user not found" });

  const tier = String(row.plan_tier || "").toLowerCase();
  if (tier === "free") {
    return res.status(400).json({ error: "No paid plan to cancel." });
  }
  if (!row.stripe_subscription_id) {
    return res.status(400).json({
      error:
        "No Stripe subscription on file. Contact support if your account should have an active subscription.",
    });
  }
  if (row.subscription_cancel_at_period_end) {
    return res.status(400).json({ error: "Subscription is already set to cancel at period end." });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
  try {
    const sub = await stripe.subscriptions.update(String(row.stripe_subscription_id), {
      cancel_at_period_end: true,
    });
    const cpe = Number(sub.current_period_end);
    if (!Number.isFinite(cpe) || cpe <= 0) {
      throw new Error("Stripe subscription missing current_period_end");
    }
    const pool = getPool();
    await pool.query(
      `UPDATE users SET
         subscription_cancel_at_period_end = TRUE,
         subscription_current_period_end = to_timestamp($2::double precision)
       WHERE id = $1`,
      [uid, cpe]
    );
    return res.json({
      ok: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(cpe * 1000).toISOString(),
    });
  } catch (e) {
    console.error("[stripe] cancel-subscription:", e);
    return res.status(500).json({ error: "Failed to cancel subscription with Stripe." });
  }
});

function normalizeOpsEmail(e) {
  return String(e || "").trim().toLowerCase();
}

/** Used when OWNER_OPS_EMAIL / OWNER_OPS_EMAILS env is unset. */
const DEFAULT_OWNER_OPS_EMAILS = "sculptoid11@gmail.com,imwuqi57@gmail.com";

function parseOwnerOpsAllowlistFromEnv() {
  const raw = process.env.OWNER_OPS_EMAILS || process.env.OWNER_OPS_EMAIL || "";
  const parts = String(raw)
    .split(/[,;]+/)
    .map(normalizeOpsEmail)
    .filter(Boolean);
  if (parts.length) return new Set(parts);
  return new Set(
    String(DEFAULT_OWNER_OPS_EMAILS)
      .split(/[,;]+/)
      .map(normalizeOpsEmail)
      .filter(Boolean)
  );
}

const OWNER_OPS_ALLOWLIST = parseOwnerOpsAllowlistFromEnv();

function requireOwnerOps(req, res, next) {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "Not available" });
  }
  const tokenEmail = normalizeOpsEmail(req.auth?.email);
  if (!tokenEmail || !OWNER_OPS_ALLOWLIST.has(tokenEmail)) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

/** Owner-only: add to a user's script_credits (generation balance). */
app.post("/owner/grant-script-credits", requireAuth, requireOwnerOps, async (req, res) => {
  const targetEmail = normalizeOpsEmail(req.body?.email);
  const raw = req.body?.delta ?? req.body?.amount;
  const delta = Math.trunc(Number(raw));
  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(targetEmail)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: "delta must be a non-zero integer" });
  }
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE users SET script_credits = GREATEST(0, script_credits + $2::integer)
       WHERE lower(trim(email)) = $1
       RETURNING id, email, script_credits`,
      [targetEmail, delta]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      ok: true,
      user: {
        id: r.rows[0].id,
        email: r.rows[0].email,
        scriptCredits: Number(r.rows[0].script_credits ?? 0),
      },
    });
  } catch (e) {
    console.error("POST /owner/grant-script-credits:", e);
    res.status(500).json({ error: "Failed to update credits" });
  }
});

/** Owner-only: look up vertical_script plan (plan_tier) + credits by email. */
app.get("/owner/user-plan", requireAuth, requireOwnerOps, async (req, res) => {
  const email = normalizeOpsEmail(req.query.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: "Invalid or missing email query param" });
  }
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, email, plan_tier, script_credits,
              stripe_customer_id, stripe_subscription_id,
              subscription_cancel_at_period_end,
              subscription_current_period_end
       FROM users WHERE lower(trim(email)) = $1`,
      [email]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const row = r.rows[0];
    const cpe = row.subscription_current_period_end;
    res.json({
      ok: true,
      user: {
        id: row.id,
        email: row.email,
        planTier: row.plan_tier,
        scriptCredits: Number(row.script_credits ?? 0),
        stripeCustomerId: row.stripe_customer_id || null,
        stripeSubscriptionId: row.stripe_subscription_id || null,
        subscriptionCancelAtPeriodEnd: !!row.subscription_cancel_at_period_end,
        subscriptionCurrentPeriodEnd:
          cpe instanceof Date ? cpe.toISOString() : cpe ? new Date(cpe).toISOString() : null,
      },
    });
  } catch (e) {
    console.error("GET /owner/user-plan:", e);
    res.status(500).json({ error: "Lookup failed" });
  }
});

/** Owner-only: set `plan_tier` by email (`none` or `free` → free tier). */
app.post("/owner/set-plan-tier", requireAuth, requireOwnerOps, async (req, res) => {
  const email = normalizeOpsEmail(req.body?.email);
  let tierRaw = req.body?.planTier ?? req.body?.plan_tier ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  const t = String(tierRaw).trim().toLowerCase();
  const tier = t === "none" ? "free" : t;
  try {
    assertValidPlanTier(tier);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Invalid plan tier" });
  }
  try {
    const pool = getPool();
    const found = await pool.query(`SELECT id FROM users WHERE lower(trim(email)) = $1`, [email]);
    if (found.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const uid = found.rows[0].id;
    const updated = await setUserPlanTierByUserId(uid, tier);
    res.json({
      ok: true,
      user: { id: updated.id, email: updated.email, planTier: updated.plan_tier },
    });
  } catch (e) {
    console.error("POST /owner/set-plan-tier:", e);
    res.status(500).json({ error: "Failed to update plan tier" });
  }
});

/**
 * Ops / future Stripe webhooks: set a user's plan tier.
 * Header: X-Plan-Assign-Secret must match env PLAN_ASSIGN_SECRET (min 8 chars).
 * Body: { "planTier": "free" | "starter" | "professional" | "business" }
 */
app.put("/users/:id/plan-tier", async (req, res) => {
  const secret = process.env.PLAN_ASSIGN_SECRET;
  if (!secret || String(secret).length < 8) {
    return res.status(503).json({
      error: "Plan assignment is not configured. Set PLAN_ASSIGN_SECRET on the server.",
    });
  }
  if (String(req.headers["x-plan-assign-secret"] || "") !== secret) {
    return res.status(401).json({ error: "Invalid or missing X-Plan-Assign-Secret header" });
  }
  try {
    const tier = req.body?.planTier ?? req.body?.plan_tier;
    const updated = await setUserPlanTierByUserId(req.params.id, tier);
    res.json({
      ok: true,
      user: { id: updated.id, email: updated.email, planTier: updated.plan_tier },
    });
  } catch (e) {
    const msg = e?.message || "failed";
    const status = msg.includes("not found") ? 404 : msg.includes("Invalid plan") ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/generate", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    try {
      await runSeasonGeneration(req.body || {}, res, null);
    } catch (err) {
      console.error("/generate:", err);
      try {
        if (!res.writableEnded) {
          sendStreamLine(res, { type: "error", message: err.message || "Generation failed" });
          sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
        }
      } catch (_) {}
    } finally {
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {}
    }
    return;
  }

  const userId = Number(req.auth?.sub);
  if (!Number.isFinite(userId)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const body = req.body || {};
  const episodeCount = Math.max(1, Math.min(120, parseInt(body.episodeCount, 10) || 60));
  const genre = String(body.genre || "Romance").trim() || "Romance";
  const logline = pickRandomPresetSummary(genre);
  if (!logline) {
    return res.status(500).json({
      error: "No preset summary available for this genre.",
    });
  }
  if (await rejectIfConcurrentGenerationCapOrReject(req, res)) return;
  if (await consumeOneScriptCreditOrReject(req, res)) return;

  const title = safeStr(body.title).slice(0, 300) || "Generated Script";
  let row;
  try {
    row = await createGeneratingScript({
      userId,
      title,
      genre,
      summary: logline.slice(0, 2000),
      episodeTarget: episodeCount,
    });
  } catch (e) {
    console.error("createGeneratingScript (stream path):", e);
    await refundOneScriptCredit(userId);
    return res.status(503).json({
      error:
        "Could not save script draft. Ensure DATABASE_URL is set and Postgres is reachable.",
    });
  }

  const persist = { scriptId: row.id, userId };
  const bodyWithPreset = { ...body, logline, __serverPresetLogline: logline };

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  try {
    await runSeasonGeneration(bodyWithPreset, res, persist);
  } catch (err) {
    console.error("/generate:", err);
    try {
      if (persist?.scriptId && persist?.userId) {
        await markScriptFailed(persist.scriptId, persist.userId, String(err?.message || err));
      }
    } catch (_) {}
    try {
      if (!res.writableEnded) {
        sendStreamLine(res, { type: "error", message: err.message || "Generation failed" });
        sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
      }
    } catch (_) {}
  } finally {
    try {
      if (!res.writableEnded) res.end();
    } catch (_) {}
  }
});

app.post("/generate/background", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({
      error: "Background generation requires AUTH_ENABLED=true and JWT_SECRET on the server.",
    });
  }
  const userId = Number(req.auth?.sub);
  if (!Number.isFinite(userId)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const body = req.body || {};
  const episodeCount = Math.max(1, Math.min(120, parseInt(body.episodeCount, 10) || 60));
  const genre = String(body.genre || "Romance").trim() || "Romance";
  const logline = pickRandomPresetSummary(genre);
  if (!logline) {
    return res.status(500).json({
      error: "No preset summary available for this genre.",
    });
  }
  if (await rejectIfConcurrentGenerationCapOrReject(req, res)) return;
  if (await consumeOneScriptCreditOrReject(req, res)) return;
  const title = safeStr(body.title).slice(0, 300) || "Generated Script";
  let row;
  try {
    row = await createGeneratingScript({
      userId,
      title,
      genre,
      summary: logline.slice(0, 2000),
      episodeTarget: episodeCount,
    });
  } catch (e) {
    console.error("createGeneratingScript:", e);
    await refundOneScriptCredit(userId);
    return res.status(503).json({
      error:
        "Could not save script draft. Ensure DATABASE_URL is set and Postgres is reachable.",
    });
  }
  res.status(202).json({
    ok: true,
    scriptId: row.id,
    status: "generating",
    summary: logline,
  });
  const persist = { scriptId: row.id, userId };
  const noop = createNoOpStreamResponse();
  const bodyWithPreset = { ...body, logline, __serverPresetLogline: logline };
  setImmediate(() => {
    runSeasonGeneration(bodyWithPreset, noop, persist).catch(async (err) => {
      console.error("Background runSeasonGeneration:", err);
      try {
        await markScriptFailed(persist.scriptId, persist.userId, String(err?.message || err));
      } catch (_) {}
    });
  });
});

app.get("/scripts", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "Auth not enabled" });
  }
  const userId = Number(req.auth?.sub);
  if (!Number.isFinite(userId)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = await listScriptsForUser(userId, 50);
    return res.json({ scripts: rows });
  } catch (e) {
    console.error("listScriptsForUser:", e);
    return res.status(500).json({ error: "Failed to list scripts" });
  }
});

app.get("/scripts/:id", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "Auth not enabled" });
  }
  const userId = Number(req.auth?.sub);
  if (!Number.isFinite(userId)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const row = await getScriptForUser(req.params.id, userId);
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ script: row });
  } catch (e) {
    console.error("getScriptForUser:", e);
    return res.status(500).json({ error: "Failed to load script" });
  }
});

app.delete("/scripts/:id", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "Auth not enabled" });
  }
  const userId = Number(req.auth?.sub);
  if (!Number.isFinite(userId)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = await deleteScriptForUser(req.params.id, userId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    return res.status(204).end();
  } catch (e) {
    console.error("deleteScriptForUser:", e);
    return res.status(500).json({ error: "Failed to delete script" });
  }
});

/** Refund 1 script credit for a failed/incomplete generation (idempotent). */
app.post("/scripts/:id/refund-credit", requireAuth, async (req, res) => {
  if (!isJwtAuthEnabled()) {
    return res.status(503).json({ error: "Auth not enabled" });
  }
  const userId = Number(req.auth?.sub);
  if (!Number.isFinite(userId)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const out = await refundCreditForScriptIfEligible(req.params.id, userId);
    return res.json({ ok: true, refunded: !!out.refunded, scriptCredits: out.scriptCredits ?? null });
  } catch (e) {
    const msg = e?.message || "failed";
    const status = msg.includes("not found") ? 404 : 500;
    console.error("POST /scripts/:id/refund-credit:", e);
    return res.status(status).json({ error: msg.includes("not found") ? "Not found" : "Refund failed" });
  }
});

async function runSeasonGeneration(body, res, persist) {
  const episodeCount = Math.max(1, Math.min(120, parseInt(body.episodeCount, 10) || 60));
  const genre = String(body.genre || "Romance").trim() || "Romance";
  const presetLocked =
    persist?.scriptId && persist?.userId
      ? safeStr(body.__serverPresetLogline).slice(0, 1500)
      : "";
  let logline = presetLocked || pickRandomPresetSummary(genre);
  logline = safeStr(logline).slice(0, 1500);
  const seriesNames = getSeriesNames(genre);
  const generationLangTag = String(body.language || "EN").toUpperCase();
  const shouldRunNameValidation = generationLangTag !== "ZH";
  const tropes = body.tropes && typeof body.tropes === "object" ? body.tropes : null;
  const shouldNormalizeLogline = body.normalizeLogline !== false;
  const wordCount = logline ? logline.trim().split(/\s+/).filter(Boolean).length : 0;
  const minWords = 25;

  try {
    if (!logline || wordCount < minWords) {
      if (typeof res.status === "function") res.status(400);
      sendStreamLine(res, {
        type: "error",
        message: `Preset summary unavailable or too short for ${genre}.`,
      });
      sendStreamLine(res, { type: "done" });
      if (persist?.scriptId && persist?.userId) {
        try {
          await markScriptFailed(
            persist.scriptId,
            persist.userId,
            "Preset summary unavailable or too short"
          );
        } catch (_) {}
      }
      return;
    }

    let genreBible = null;
    if (shouldNormalizeLogline && logline) {
      try {
        genreBible = await normalizeGenreLogline({
          rawLogline: logline,
          genre,
          names: seriesNames,
        });
        if (genreBible && genreBible.logline) {
          logline = genreBible.logline;
          sendStreamLine(res, { type: "logline_normalized", ok: true });
        }
      } catch (e) {
        console.error("Logline normalization failed:", e);
        sendStreamLine(res, { type: "logline_normalized", ok: false });
      }
    }

    sendStreamLine(res, { type: "preset_summary", summary: logline });

    let blueprint = null;
    let episodeSummaries = null;
    const episodeRecaps = [];
    try {
      blueprint = await generateSeasonBlueprint({
        episodeCount,
        logline,
        genre,
        names: seriesNames,
        tropes,
      });
      sendStreamLine(res, {
        type: "blueprint",
        ok: true,
        episodes: Array.isArray(blueprint.episodes)
          ? blueprint.episodes.length
          : 0,
      });

      try {
        episodeSummaries = await generateEpisodeSummaries({
          blueprint,
          logline,
          genre,
        });
        if (episodeSummaries && episodeSummaries instanceof Map) {
          sendStreamLine(res, {
            type: "episode_summaries",
            ok: true,
            episodes: episodeSummaries.size,
          });
        }
      } catch (sumErr) {
        console.error("Episode summary generation failed:", sumErr);
        sendStreamLine(res, {
          type: "episode_summaries",
          ok: false,
          message: sumErr.message || "Failed to generate per-episode summaries",
        });
      }
    } catch (bpErr) {
      console.error("Blueprint generation failed:", bpErr);
      sendStreamLine(res, {
        type: "blueprint",
        ok: false,
        message: bpErr.message || "Failed to generate season blueprint",
      });
      // We continue without a blueprint; episodes will still be generated using only the logline.
    }

    // Generate style guides once before the episode loop.
    // Both are run in parallel to save time; failures are non-fatal.
    let vdramaStyleGuide = "";
    let genreStyleNotes = "";
    try {
      sendStreamLine(res, { type: "style_guide", status: "generating" });
      [vdramaStyleGuide, genreStyleNotes] = await Promise.all([
        generateVdramaStyleGuide({ logline, names: seriesNames, genre }),
        generateGenreStyleNotes({ logline, genre }),
      ]);
      sendStreamLine(res, {
        type: "style_guide",
        status: "complete",
        vdrama_chars: vdramaStyleGuide.length,
        genre_chars: genreStyleNotes.length,
      });
    } catch (sgErr) {
      console.warn("Style guide generation failed:", sgErr?.message || sgErr);
      sendStreamLine(res, { type: "style_guide", status: "failed" });
    }

    // Build the generator system prompt once — combines format rules + both style guides.
    const generatorSystemPrompt = buildGeneratorSystemPrompt({ vdramaStyleGuide, genreStyleNotes });

    const episodeScriptsMemo = [];
    /** @type {(number[]|null)[]} Parallel to episodeScriptsMemo when embedding gate is on. */
    const episodeEmbeddingMemo = [];
    const episodeStateMemo = [];
    const narrativeResetMemo = new Map();
    let courseCorrectionBrief = "";
    const BATCH_SIZE = 5;
    const victorAllowed =
      includesWord(logline, "Victor") ||
      includesWord(seriesNames?.heroine, "Victor") ||
      includesWord(seriesNames?.coldCeo, "Victor") ||
      includesWord(seriesNames?.warmFriend, "Victor");

    for (let ep = 1; ep <= episodeCount; ep++) {
      sendStreamLine(res, { type: "progress", episode: ep, total: episodeCount });

      // Mid-batch review: after every BATCH_SIZE episodes, pause and analyse the
      // completed batch before generating the next one. The resulting brief is
      // injected into each of the next BATCH_SIZE episode prompts as hard constraints.
      if (ep > 1 && (ep - 1) % BATCH_SIZE === 0 && episodeRecaps.length > 0) {
        const batchEnd = ep - 1;
        const batchStart = batchEnd - BATCH_SIZE + 1;
        sendStreamLine(res, { type: "batch_review", episode: ep, batch_start: batchStart, batch_end: batchEnd, status: "reviewing" });
        try {
          courseCorrectionBrief = await runMidBatchReview({
            batchStart,
            batchEnd,
            recaps: episodeRecaps,
            genre,
            seriesNames,
            blueprint,
          });
          sendStreamLine(res, { type: "batch_review", episode: ep, status: "complete", brief_length: courseCorrectionBrief.length });
        } catch (brErr) {
          console.warn(`Mid-batch review failed at ep ${ep}:`, brErr?.message || brErr);
        }
      }

      try {
        let narrativeResetText = "";
        const narrativeResetEpisodes = /superhero|sci[-.\s]?fi|science\s*fiction|fantasy|horror|monster|werewolf/i.test(
          String(genre || "")
        )
          ? [10, 25, 45]
          : [20, 40];
        if (narrativeResetEpisodes.includes(ep) && !narrativeResetMemo.has(ep)) {
          try {
            const reset = await buildFullNarrativeReset(
              episodeRecaps,
              seriesNames,
              logline,
              ep
            );
            if (reset) {
              narrativeResetMemo.set(ep, reset);
              sendStreamLine(res, { type: "narrative_reset", episode: ep, ok: true });
            }
          } catch (resetErr) {
            console.error(`Narrative reset generation failed for episode ${ep}:`, resetErr);
            sendStreamLine(res, { type: "narrative_reset", episode: ep, ok: false });
          }
        }
        if (narrativeResetMemo.has(ep)) narrativeResetText = narrativeResetMemo.get(ep) || "";

        const lenPlan = getEpisodeLengthPlan(ep, episodeCount);

        const userContent = buildEpisodePromptText({
          language: body.language || "EN",
          genre,
          totalEpisodes: episodeCount,
          episodeNumber: ep,
          logline,
          names: seriesNames,
          genreBible,
          blueprint,
          episodeSummaries,
          recaps: episodeRecaps,
          previousEpisodeStates: episodeStateMemo,
          previousEpisodeScripts: episodeScriptsMemo,
          narrativeResetText,
          trimContext: ENABLE_TRIMMED_CONTEXT,
          courseCorrectionBrief,
        });
        sendStreamLine(res, {
          type: "prompt_metrics",
          episode: ep,
          chars: userContent.length,
          approx_tokens: estimatePromptTokens(userContent),
          trim_context: ENABLE_TRIMMED_CONTEXT,
          mode: ENABLE_TWO_PASS_EPISODE ? "two_pass" : "single_pass",
          primary_episode_temperature: PRIMARY_EPISODE_TEMPERATURE,
          primary_episode_max_tokens: lenPlan.maxTokens,
          episode_target_chars: lenPlan.targetChars,
          episode_hard_max_chars: lenPlan.hardMaxChars,
          establishing_episode: lenPlan.isEstablishing,
        });

        let rawContent = "";
        if (ENABLE_TWO_PASS_EPISODE) {
          try {
            const twoPass = await generateEpisodeTextTwoPass({
              userContent,
              episodeNumber: ep,
              totalEpisodes: episodeCount,
              names: seriesNames,
              language: body.language || "EN",
              genre,
              generatorSystemPrompt,
            });
            if (twoPass.ok) {
              rawContent = twoPass.text;
              sendStreamLine(res, { type: "episode_mode", episode: ep, mode: "two_pass" });
            } else {
              sendStreamLine(res, {
                type: "episode_mode",
                episode: ep,
                mode: "single_pass_fallback",
                reason: twoPass.reason,
              });
            }
          } catch (twoPassErr) {
            console.error(`Two-pass generation failed for episode ${ep}:`, twoPassErr);
            sendStreamLine(res, {
              type: "episode_mode",
              episode: ep,
              mode: "single_pass_fallback",
              reason: "two_pass_error",
            });
          }
        }
        if (!rawContent) {
          const completion = await openai.chat.completions.create({
            model: GENERATOR_MODEL,
            messages: [
              { role: "system", content: generatorSystemPrompt },
              { role: "user", content: userContent },
            ],
            max_tokens: lenPlan.maxTokens,
            temperature: PRIMARY_EPISODE_TEMPERATURE,
            frequency_penalty: 1.0,
            presence_penalty: 0.6,
          });
          rawContent = completion.choices?.[0]?.message?.content || "";
        }

        // Phase 4a — Format gate: if GENERATOR_MODEL output lacks basic screenplay structure,
        // do one corrective reshape pass with FINETUNED_MODEL before downstream processing.
        if (rawContent && !passesBasicFormatCheck(rawContent)) {
          try {
            sendStreamLine(res, { type: "format_rescue", episode: ep, status: "start" });
            const reshapePrompt =
              `The following draft for Episode ${ep} is missing required vertical drama screenplay format ` +
              `(scene headings, ALL CAPS character cues, or is too short). ` +
              `Rewrite it in correct vertical drama format — preserve all story content and dialogue, ` +
              `but fix structure: INT./EXT. scene headings, ALL CAPS character cue lines, short action lines. ` +
              `Keep the rewrite within the vertical length budget (~${lenPlan.targetChars} characters; ${lenPlan.isEstablishing ? "3–4" : "2–3"} scenes). ` +
              `Do NOT add "EPISODE ${ep}" or "END EPISODE ${ep}" (or END OF EPISODE) — the pipeline injects those; start with cold open or first scene heading.\n\n` +
              `DRAFT TO FIX:\n\n${rawContent}`;
            const reshapeResp = await openai.chat.completions.create({
              model: FINETUNED_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: reshapePrompt },
              ],
              max_tokens: lenPlan.maxTokens,
              temperature: 0.3,
              frequency_penalty: 0.8,
              presence_penalty: 0.3,
            });
            const reshaped = reshapeResp.choices?.[0]?.message?.content || "";
            if (reshaped.trim() && passesBasicFormatCheck(reshaped)) {
              rawContent = reshaped;
              sendStreamLine(res, { type: "format_rescue", episode: ep, status: "success" });
            } else {
              sendStreamLine(res, { type: "format_rescue", episode: ep, status: "failed" });
            }
          } catch (reshapeErr) {
            console.warn(`Phase 4a format rescue failed for ep ${ep}:`, reshapeErr?.message || reshapeErr);
            sendStreamLine(res, { type: "format_rescue", episode: ep, status: "error" });
          }
        }

        let episodeText =
          typeof rawContent === "string" && rawContent.trim()
            ? rawContent.trim()
            : `[Episode ${ep} — no content]`;

        episodeText = finalizeEpisodeText(episodeText, ep, seriesNames);

        // Repetition gate — verified bounded regen (re-check after each attempt).
        if (ep > 1 && episodeScriptsMemo.length > 0) {
          const recentScripts = episodeScriptsMemo.slice(-5);
          let repMetrics = measureRepetitionAgainstRecent(episodeText, recentScripts);
          if (repMetrics.needsRetry) {
            const reason0 =
              repMetrics.verbatimMatches.length > 0
                ? "verbatim phrases detected"
                : `score ${repMetrics.maxScore.toFixed(2)} / block ${repMetrics.maxBlockDup}`;
            console.warn(`Episode ${ep} repetition (${reason0}) — regenerating (up to ${MAX_REPETITION_REGEN_ATTEMPTS} attempts).`);
            sendStreamLine(res, {
              type: "repetition_gate",
              episode: ep,
              phase: "initial",
              max_score: repMetrics.maxScore,
              block_dup: repMetrics.maxBlockDup,
              verbatim_count: repMetrics.verbatimMatches.length,
            });
            for (let attempt = 1; attempt <= MAX_REPETITION_REGEN_ATTEMPTS && repMetrics.needsRetry; attempt++) {
              const vm = repMetrics.verbatimMatches;
              let retryHint = "\n\nREWRITE REQUIREMENT: This draft repeated content from a prior episode. ";
              if (attempt > 1) {
                retryHint += `(Attempt ${attempt}/${MAX_REPETITION_REGEN_ATTEMPTS}) The last rewrite STILL matched repetition checks — change scenes and lines more aggressively.\n`;
              }
              if (vm.length > 0) {
                retryHint +=
                  "The following exact phrases from prior episodes must NOT appear in your output — rewrite every scene that contains them with entirely new dialogue, action, and beats:\n" +
                  vm.map((p, i) => `  ${i + 1}. "${p}"`).join("\n") +
                  "\n";
              }
              retryHint +=
                "Continue the timeline forward with new dialogue and action only. New scene energy, new information, new consequences.";
              const retryContent = userContent + retryHint;
              const temp = Math.max(0.35, 1.0 - (attempt - 1) * 0.28);
              try {
                const retry = await openai.chat.completions.create({
                  model: FINETUNED_MODEL,
                  messages: [
                    { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                    { role: "user", content: retryContent },
                  ],
                  max_tokens: 2048,
                  temperature: temp,
                  frequency_penalty: 1.0,
                  presence_penalty: 0.6,
                });
                const retryRaw = retry.choices?.[0]?.message?.content;
                if (typeof retryRaw === "string" && retryRaw.trim()) {
                  episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
                  if (shouldRunNameValidation) {
                    try {
                      const mismatches = detectMainTrioNameMismatches(episodeText, seriesNames);
                      if (mismatches.length > 0) {
                        episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                      }
                    } catch (nvErr) {
                      console.warn(
                        `Name validation failed on repetition retry (ep ${ep}):`,
                        nvErr?.message || nvErr
                      );
                    }
                  }
                  episodeText = normalizeEpisodeCharacterNames(
                    episodeText,
                    CHARACTER_NAME_REGISTRY_PATH
                  );
                  repMetrics = measureRepetitionAgainstRecent(episodeText, recentScripts);
                  sendStreamLine(res, {
                    type: "repetition_gate",
                    episode: ep,
                    attempt,
                    temperature: temp,
                    still_repeats: repMetrics.needsRetry,
                    max_score: repMetrics.maxScore,
                    block_dup: repMetrics.maxBlockDup,
                    verbatim_count: repMetrics.verbatimMatches.length,
                  });
                }
              } catch (repErr) {
                console.warn(`Episode ${ep} repetition regen attempt ${attempt} failed:`, repErr?.message || repErr);
                break;
              }
            }
            if (repMetrics.needsRetry) {
              console.warn(
                `Episode ${ep}: repetition still flagged after ${MAX_REPETITION_REGEN_ATTEMPTS} attempt(s) — keeping last draft.`
              );
              sendStreamLine(res, {
                type: "repetition_gate",
                episode: ep,
                phase: "exhausted",
                still_repeats: true,
              });
            }
          }
        }

        // Phase 3 validation — detect and FIX main-trio name inconsistencies before canonicalization.
        if (shouldRunNameValidation) {
          try {
            const mismatches = detectMainTrioNameMismatches(episodeText, seriesNames);
            if (mismatches.length > 0) {
              // Apply corrections immediately (was log-only before — bug fix)
              episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
              const report = await validateMainTrioNameConsistencyWithLLM({
                episodeText,
                names: seriesNames,
                episodeNumber: ep,
              });
              if (report && report.ok === false) {
                console.warn(
                  `Name consistency mismatches (episode ${ep}):`,
                  report.mismatches || mismatches
                );
              }
            }
          } catch (nvErr) {
            console.warn(`Name validation failed (episode ${ep}):`, nvErr?.message || nvErr);
          }
        }
        // Phase 2: normalize character name variants into canonical spellings.
        episodeText = normalizeEpisodeCharacterNames(
          episodeText,
          CHARACTER_NAME_REGISTRY_PATH
        );
        // Phase 4 targeted span repair (non-LLM first): repair only flagged merge/collapse spans.
        {
          const spanRepair = targetedRepairEpisodeText(episodeText, seriesNames);
          episodeText = spanRepair.text;
          sendStreamLine(res, {
            type: "span_repair",
            episode: ep,
            span_repairs_applied: spanRepair.spanRepairsApplied,
            repair_types: spanRepair.repairTypes,
            remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
          });
        }

        // Hard validation: merged words — bounded regen with verification after each attempt.
        try {
          for (let attempt = 1; attempt <= MAX_MERGED_WORD_REGEN_ATTEMPTS; attempt++) {
            const stillMerged =
              hasMergedWordIssues(episodeText) || hasSentenceLevelMerges(episodeText);
            if (!stillMerged) break;
            const spacingRetryContent =
              userContent +
              (attempt > 1
                ? `\n\n(Attempt ${attempt}/${MAX_MERGED_WORD_REGEN_ATTEMPTS}) The previous reply still contained merged/glued words.\n`
                : "") +
              "\n\nCRITICAL FORMAT VALIDATION (do not fail this):\n" +
              "- The output MUST contain NO merged/glued words.\n" +
              "- Every English word must be separated by exactly ONE space.\n" +
              "- Do NOT remove spaces after punctuation (e.g. \".Next\" is invalid; must be \". Next\").\n" +
              "- Do NOT glue a character cue to dialogue (e.g. \"LUCAS(speaking)\" or \"LUCASHello\" is invalid).\n" +
              "- Before returning, scan the output for any pattern where a word is immediately followed by another word with no space.\n";
            const temp = Math.max(0.12, 0.32 - (attempt - 1) * 0.08);
            const model = attempt >= MAX_MERGED_WORD_REGEN_ATTEMPTS ? GENERATOR_MODEL : FINETUNED_MODEL;
            const sys =
              attempt >= MAX_MERGED_WORD_REGEN_ATTEMPTS
                ? generatorSystemPrompt
                : EPISODE_TEXT_SYSTEM_PROMPT;
            const retry = await openai.chat.completions.create({
              model,
              messages: [
                { role: "system", content: sys },
                { role: "user", content: spacingRetryContent },
              ],
              max_tokens: 2048,
              temperature: temp,
              frequency_penalty: 1.0,
              presence_penalty: 0.4,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw !== "string" || !retryRaw.trim()) break;
            episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
            if (shouldRunNameValidation) {
              try {
                const mismatches = detectMainTrioNameMismatches(episodeText, seriesNames);
                if (mismatches.length > 0) {
                  episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                  const report = await validateMainTrioNameConsistencyWithLLM({
                    episodeText,
                    names: seriesNames,
                    episodeNumber: ep,
                  });
                  if (report && report.ok === false) {
                    console.warn(
                      `Name consistency mismatches (episode ${ep}):`,
                      report.mismatches || mismatches
                    );
                  }
                }
              } catch (nvErr) {
                console.warn(`Name validation failed (episode ${ep}):`, nvErr?.message || nvErr);
              }
            }
            episodeText = normalizeEpisodeCharacterNames(
              episodeText,
              CHARACTER_NAME_REGISTRY_PATH
            );
            const spanRepair = targetedRepairEpisodeText(episodeText, seriesNames);
            episodeText = spanRepair.text;
            const mergedAfter =
              hasMergedWordIssues(episodeText) || hasSentenceLevelMerges(episodeText);
            sendStreamLine(res, {
              type: "merged_word_retry",
              episode: ep,
              attempt,
              model,
              temperature: temp,
              still_merged: mergedAfter,
              span_repairs_applied: spanRepair.spanRepairsApplied,
              remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
            });
          }
          if (hasMergedWordIssues(episodeText) || hasSentenceLevelMerges(episodeText)) {
            console.warn(
              `Episode ${ep}: merged-word issues remain after ${MAX_MERGED_WORD_REGEN_ATTEMPTS} attempt(s).`
            );
            sendStreamLine(res, {
              type: "merged_word_retry",
              episode: ep,
              phase: "exhausted",
              still_merged: true,
            });
          }
        } catch (sErr) {
          console.error(`Merged-word spacing retry failed for episode ${ep}:`, sErr);
        }

        if (ENABLE_PLOT_CONTRACT_GATE) {
          try {
            const epPlan =
              blueprint && Array.isArray(blueprint.episodes)
                ? blueprint.episodes.find((e) => e && e.episode === ep) ||
                  blueprint.episodes[ep - 1] ||
                  null
                : null;
            let plotCheck = evaluatePlotContractViolations({
              episodeNumber: ep,
              episodeText,
              episodeRecaps,
              blueprintPlan: epPlan,
              seriesNames,
              registryPath: CHARACTER_NAME_REGISTRY_PATH,
            });
            for (
              let pAttempt = 1;
              pAttempt <= MAX_PLOT_CONTRACT_REGEN_ATTEMPTS && plotCheck.violations.length;
              pAttempt++
            ) {
              sendStreamLine(res, {
                type: "plot_contract",
                episode: ep,
                attempt: pAttempt,
                violations: plotCheck.violations,
              });
              const hint =
                "\n\nPLOT CONTRACT — machine checks failed; rewrite so ALL items below are satisfied:\n" +
                plotCheck.violations.map((v, i) => `${i + 1}. ${v}`).join("\n") +
                "\n\nKeep the same story intent, cast, and blueprint; only fix what the checklist flags.";
              const temp = Math.max(0.15, 0.35 - (pAttempt - 1) * 0.08);
              const model =
                pAttempt >= MAX_PLOT_CONTRACT_REGEN_ATTEMPTS ? GENERATOR_MODEL : FINETUNED_MODEL;
              const sys =
                pAttempt >= MAX_PLOT_CONTRACT_REGEN_ATTEMPTS
                  ? generatorSystemPrompt
                  : EPISODE_TEXT_SYSTEM_PROMPT;
              const retry = await openai.chat.completions.create({
                model,
                messages: [
                  { role: "system", content: sys },
                  { role: "user", content: userContent + hint },
                ],
                max_tokens: 2048,
                temperature: temp,
                frequency_penalty: 1.0,
                presence_penalty: 0.4,
              });
              const retryRaw = retry.choices?.[0]?.message?.content;
              if (typeof retryRaw !== "string" || !retryRaw.trim()) break;
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(episodeText, seriesNames);
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM({
                      episodeText,
                      names: seriesNames,
                      episodeNumber: ep,
                    });
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(`Name validation failed (episode ${ep}):`, nvErr?.message || nvErr);
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
              const spanRepairPc = targetedRepairEpisodeText(episodeText, seriesNames);
              episodeText = spanRepairPc.text;
              sendStreamLine(res, {
                type: "span_repair",
                episode: ep,
                phase: "plot_contract",
                span_repairs_applied: spanRepairPc.spanRepairsApplied,
                repair_types: spanRepairPc.repairTypes,
                remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
              });
              plotCheck = evaluatePlotContractViolations({
                episodeNumber: ep,
                episodeText,
                episodeRecaps,
                blueprintPlan: epPlan,
                seriesNames,
                registryPath: CHARACTER_NAME_REGISTRY_PATH,
              });
            }
            if (plotCheck.violations.length) {
              console.warn(
                `Episode ${ep}: plot contract still violated after ${MAX_PLOT_CONTRACT_REGEN_ATTEMPTS} attempt(s):`,
                plotCheck.violations
              );
              sendStreamLine(res, {
                type: "plot_contract",
                episode: ep,
                phase: "exhausted",
                violations: plotCheck.violations,
              });
            }
          } catch (plotErr) {
            console.error(`Plot contract gate failed (episode ${ep}):`, plotErr);
          }
        }

        const lengthBudget = measureVerticalEpisodeLengthBudget(episodeText);
        if (lengthBudget.exceeds) {
          sendStreamLine(res, {
            type: "episode_length_gate",
            episode: ep,
            lines: lengthBudget.lines,
            chars: lengthBudget.chars,
            max_lines: lengthBudget.maxLines,
            max_chars: lengthBudget.maxChars,
          });
        }

        // Quality gate: prevent "synonym vomit" / context-collapse word-list runs / runaway length.
        if (hasQualityCollapse(episodeText, seriesNames)) {
          try {
            const qualityRetryContent = buildCollapseRescueUserPrompt({
              language: body.language || "EN",
              genre,
              totalEpisodes: episodeCount,
              episodeNumber: ep,
              logline,
              names: seriesNames,
              blueprint,
            });
            const retry = await openai.chat.completions.create({
              model: PLANNER_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: qualityRetryContent },
              ],
              max_tokens: PRIMARY_EPISODE_MAX_TOKENS,
              temperature: 0.3,
              frequency_penalty: 1.0,
              presence_penalty: 0.6,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw === "string" && retryRaw.trim()) {
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
              {
                const spanRepair = targetedRepairEpisodeText(episodeText, seriesNames);
                episodeText = spanRepair.text;
                sendStreamLine(res, {
                  type: "span_repair",
                  episode: ep,
                  span_repairs_applied: spanRepair.spanRepairsApplied,
                  repair_types: spanRepair.repairTypes,
                  remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
                });
              }
            }
          } catch (qErr) {
            console.error(`Quality retry failed for episode ${ep}:`, qErr);
          }
          // Verification policy: one more targeted repair loop before second rescue.
          if (hasQualityCollapse(episodeText, seriesNames)) {
            const spanRepair2 = targetedRepairEpisodeText(episodeText, seriesNames);
            episodeText = spanRepair2.text;
            sendStreamLine(res, {
              type: "span_repair",
              episode: ep,
              span_repairs_applied: spanRepair2.spanRepairsApplied,
              repair_types: spanRepair2.repairTypes,
              remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
              pass: "verification_loop",
            });
          }
          // Last resort: deterministic fallback using blueprint plan data.
          // Better than before — uses actual episode plan details for plausible content.
          if (hasQualityCollapse(episodeText, seriesNames)) {
            const fallbackSummary =
              episodeSummaries && episodeSummaries instanceof Map
                ? episodeSummaries.get(ep)
                : "";
            const fallbackPlan =
              blueprint && Array.isArray(blueprint.episodes)
                ? blueprint.episodes.find((e) => e && e.episode === ep) || null
                : null;
            const healed = await buildCollapseSafeEpisodeFallback({
              episodeNumber: ep,
              totalEpisodes: episodeCount,
              names: seriesNames,
              genre,
              summary: fallbackSummary,
              plan: fallbackPlan,
            });
            episodeText = finalizeEpisodeText(healed, ep, seriesNames);
            sendStreamLine(res, {
              type: "quality_gate",
              episode: ep,
              status: "auto_healed",
              reason: "context_collapse_detected_after_retry",
            });
          }
        }

        // Phase 3: scene-anchor enforcement (default warn mode).
        if (ANCHOR_ENFORCEMENT_MODE !== "off") {
          let anchorReport = validateSceneAnchors(episodeText, seriesNames);
          if (!anchorReport.pass) {
            sendStreamLine(res, {
              type: "quality_gate",
              episode: ep,
              status: "anchor_warning",
              mode: ANCHOR_ENFORCEMENT_MODE,
              scene_failures: anchorReport.failureCount,
            });
          }
          if (!anchorReport.pass && ANCHOR_ENFORCEMENT_MODE === "enforce") {
            try {
              const rewritten = await rewriteEpisodeForAnchors({
                userContent,
                episodeText,
                episodeNumber: ep,
                totalEpisodes: episodeCount,
                names: seriesNames,
              });
              if (rewritten) {
                episodeText = finalizeEpisodeText(rewritten, ep, seriesNames);
                episodeText = normalizeEpisodeCharacterNames(
                  episodeText,
                  CHARACTER_NAME_REGISTRY_PATH
                );
                anchorReport = validateSceneAnchors(episodeText, seriesNames);
                sendStreamLine(res, {
                  type: "quality_gate",
                  episode: ep,
                  status: anchorReport.pass ? "anchor_auto_healed" : "anchor_enforce_partial",
                  mode: ANCHOR_ENFORCEMENT_MODE,
                  scene_failures: anchorReport.failureCount,
                });
              }
            } catch (anchorErr) {
              console.error(`Anchor rewrite failed for episode ${ep}:`, anchorErr);
            }
          }
        }

        // Phase 2c — Structural opening similarity gate.
        // Compares the new episode's opening fingerprint against ALL prior episodes.
        // Catches same-location / same-action repeats that sentence-level scoring misses
        // (e.g. "ROYAL LIBRARY | researching/reading | skeptic_dismissal" every 4 episodes).
        if (ep > 1 && episodeRecaps.length > 0) {
          const newFp = extractOpeningFingerprint(episodeText);
          const bestMatch = findMostSimilarPriorOpening(newFp, episodeRecaps);
          if (bestMatch && bestMatch.score >= STRUCTURAL_OPENING_GATE_THRESHOLD) {
            const matchedFp = bestMatch.fingerprint;
            const textBeforeStructuralGate = episodeText;
            console.warn(
              `Episode ${ep} opening structurally too close to ep ${bestMatch.episode} ` +
              `(score ${bestMatch.score.toFixed(2)} ≥ ${STRUCTURAL_OPENING_GATE_THRESHOLD}): ` +
              `${newFp.location} | ${newFp.action} | ${newFp.dialogue_type} — regenerating.`
            );
            const buildStructuralRetryUser = (fp, attemptNum) => {
              let body =
                userContent +
                `\n\nREWRITE REQUIRED — OPENING STRUCTURE REJECTED:\n` +
                `This draft opened in "${fp.location}" with a "${fp.action}" beat, ` +
                `which is structurally too close to episode ${bestMatch.episode} ` +
                `("${matchedFp.location}" | "${matchedFp.action}" | "${matchedFp.dialogue_type}").\n` +
                `You MUST rewrite the opening with:\n` +
                `  1. A DIFFERENT location — not "${fp.location}" or any location already listed in the EPISODE OPENING HISTORY above.\n` +
                `  2. A DIFFERENT first action — not "${fp.action}".\n` +
                `  3. Continue the story's plot and stakes; do not reset to an earlier scene.\n` +
                `The rest of the episode's story beats may remain the same — only the opening scene must change.`;
              if (attemptNum === 2) {
                body +=
                  `\n\nSECOND ATTEMPT (required): The first rewrite still matched prior-episode opening structure ` +
                  `(threshold ${STRUCTURAL_OPENING_GATE_THRESHOLD}). ` +
                  `Pick a radically different first scene heading and first on-screen beat — not "${fp.location}" / "${fp.action}".`;
              }
              return body;
            };

            let structuralAccepted = false;
            let lastFailedFp = newFp;
            try {
              for (let attempt = 1; attempt <= 2 && !structuralAccepted; attempt++) {
                const structuralRetry = await openai.chat.completions.create({
                  model: attempt === 1 ? FINETUNED_MODEL : GENERATOR_MODEL,
                  messages: [
                    {
                      role: "system",
                      content:
                        attempt === 1 ? EPISODE_TEXT_SYSTEM_PROMPT : generatorSystemPrompt,
                    },
                    { role: "user", content: buildStructuralRetryUser(lastFailedFp, attempt) },
                  ],
                  max_tokens: 2048,
                  temperature: attempt === 1 ? 0.55 : 0.35,
                  frequency_penalty: 1.0,
                  presence_penalty: attempt === 1 ? 0.7 : 0.65,
                });
                const structuralRetryRaw = structuralRetry.choices?.[0]?.message?.content;
                if (typeof structuralRetryRaw !== "string" || !structuralRetryRaw.trim()) continue;
                const retried = finalizeEpisodeText(structuralRetryRaw.trim(), ep, seriesNames);
                const retriedFp = extractOpeningFingerprint(retried);
                const retriedMatch = findMostSimilarPriorOpening(retriedFp, episodeRecaps);
                if (!retriedMatch || retriedMatch.score < STRUCTURAL_OPENING_GATE_THRESHOLD) {
                  episodeText = retried;
                  structuralAccepted = true;
                  sendStreamLine(res, {
                    type: "structural_retry",
                    episode: ep,
                    attempt,
                    reason: `opening too similar to ep ${bestMatch.episode}`,
                    old_location: newFp.location,
                    new_location: retriedFp.location,
                    score_before: bestMatch.score,
                    threshold: STRUCTURAL_OPENING_GATE_THRESHOLD,
                  });
                } else {
                  lastFailedFp = retriedFp;
                  console.warn(
                    `Episode ${ep} structural attempt ${attempt} still too similar ` +
                    `(score ${retriedMatch.score.toFixed(2)} vs ep ${retriedMatch.episode})`
                  );
                }
              }
            } catch (structuralRetryErr) {
              console.warn(`Episode ${ep} structural retry failed:`, structuralRetryErr?.message || structuralRetryErr);
            }

            if (!structuralAccepted) {
              episodeText = textBeforeStructuralGate;
              console.warn(
                `Episode ${ep}: both structural rewrites failed threshold ${STRUCTURAL_OPENING_GATE_THRESHOLD} — reverted to pre-gate draft.`
              );
              sendStreamLine(res, {
                type: "structural_retry",
                episode: ep,
                status: "reverted",
                reason: `both attempts still ≥ ${STRUCTURAL_OPENING_GATE_THRESHOLD} similar to a prior opening`,
                compared_to_episode: bestMatch.episode,
                score_before: bestMatch.score,
                threshold: STRUCTURAL_OPENING_GATE_THRESHOLD,
              });
            }
          }
        }

        // Phase 3b — Blueprint setting enforcement gate.
        // Only fires if the blueprint specifies a setting_focus for this episode
        // AND the generated opening doesn't land in that location.
        // Runs after Phase 2c so the latest episodeText is always checked.
        {
          const epPlan = blueprint?.episodes?.[ep - 1];
          const requiredSetting = safeStr(epPlan?.setting_focus).trim();
          if (requiredSetting) {
            let originalLocationLogged = null;
            for (let attempt = 1; attempt <= MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS; attempt++) {
              const currentFp = extractOpeningFingerprint(episodeText);
              const settingCheck = blueprintSettingMatches(currentFp, requiredSetting);
              if (settingCheck.match) {
                if (attempt > 1) {
                  sendStreamLine(res, {
                    type: "blueprint_setting_retry",
                    episode: ep,
                    phase: "cleared",
                    attempt,
                    required_setting: requiredSetting,
                    retried_location: currentFp.location,
                    confidence: settingCheck.confidence,
                  });
                }
                break;
              }
              if (originalLocationLogged === null) originalLocationLogged = currentFp.location;
              console.warn(
                `Episode ${ep} blueprint setting mismatch (attempt ${attempt}/${MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS}): ` +
                `required "${requiredSetting}" but opened in "${currentFp.location}" ` +
                `(confidence ${settingCheck.confidence.toFixed(2)}).`
              );
              const blueprintRetryContent =
                userContent +
                (attempt > 1
                  ? `\n\n(Attempt ${attempt}/${MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS}) The last rewrite still opened in "${currentFp.location}". ` +
                    `The FIRST scene heading must establish "${requiredSetting}".\n`
                  : "") +
                `\n\nREWRITE REQUIRED — WRONG OPENING LOCATION:\n` +
                `The season blueprint requires episode ${ep} to be set in: "${requiredSetting}".\n` +
                `Your draft opened in "${currentFp.location}" instead.\n` +
                `Rules for the rewrite:\n` +
                `  1. Move the opening scene to "${requiredSetting}" — this is a hard constraint from the season plan.\n` +
                `  2. Keep all story beats, plot developments, and character decisions the same.\n` +
                `  3. Do NOT time-skip or introduce new subplots — only the opening location changes.\n` +
                `  4. The rest of the episode after the opening scene may remain largely intact.`;
              try {
                const useGen = attempt >= MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS;
                const blueprintRetry = await openai.chat.completions.create({
                  model: useGen ? GENERATOR_MODEL : FINETUNED_MODEL,
                  messages: [
                    {
                      role: "system",
                      content: useGen ? generatorSystemPrompt : EPISODE_TEXT_SYSTEM_PROMPT,
                    },
                    { role: "user", content: blueprintRetryContent },
                  ],
                  max_tokens: 2048,
                  temperature: Math.max(0.22, 0.52 - (attempt - 1) * 0.12),
                  frequency_penalty: 1.0,
                  presence_penalty: 0.6,
                });
                const blueprintRetryRaw = blueprintRetry.choices?.[0]?.message?.content;
                if (typeof blueprintRetryRaw !== "string" || !blueprintRetryRaw.trim()) break;
                episodeText = finalizeEpisodeText(blueprintRetryRaw.trim(), ep, seriesNames);
                const retriedFp = extractOpeningFingerprint(episodeText);
                const retriedCheck = blueprintSettingMatches(retriedFp, requiredSetting);
                sendStreamLine(res, {
                  type: "blueprint_setting_retry",
                  episode: ep,
                  attempt,
                  required_setting: requiredSetting,
                  original_location: originalLocationLogged,
                  retried_location: retriedFp.location,
                  match_after_retry: retriedCheck.match,
                  confidence_after_retry: retriedCheck.confidence,
                });
              } catch (blueprintRetryErr) {
                console.warn(
                  `Episode ${ep} blueprint setting retry failed:`,
                  blueprintRetryErr?.message || blueprintRetryErr
                );
                break;
              }
            }
            const finalFp = extractOpeningFingerprint(episodeText);
            const finalCheck = blueprintSettingMatches(finalFp, requiredSetting);
            if (!finalCheck.match) {
              console.warn(
                `Episode ${ep}: blueprint setting still unmatched after up to ${MAX_BLUEPRINT_SETTING_REGEN_ATTEMPTS} attempt(s).`
              );
              sendStreamLine(res, {
                type: "blueprint_setting_retry",
                episode: ep,
                phase: "exhausted",
                required_setting: requiredSetting,
                last_location: finalFp.location,
                confidence: finalCheck.confidence,
              });
            }
          }
        }

        // Hard safeguard: prevent the model from inventing/using "Victor" unless explicitly provided.
        if (!victorAllowed && includesWord(episodeText, "Victor")) {
          const replacement = pickReplacementNameForVictor();
          console.warn(`Episode ${ep} used forbidden name Victor; regenerating with rename to ${replacement}.`);
          const renameRetryContent =
            userContent +
            `\n\nREWRITE REQUIREMENT (name ban): The draft used the forbidden name "Victor". ` +
            `Rewrite the episode and rename ANY character named "Victor" to "${replacement}" (and adjust dialogue/action accordingly). ` +
            `Do NOT introduce any new protagonists. Keep the heroine and the two male leads as the core cast. Do not change their names.`;
          try {
            const retry = await openai.chat.completions.create({
              model: FINETUNED_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: renameRetryContent },
              ],
              max_tokens: 2048,
              temperature: 0.5,
              frequency_penalty: 1.0,
              presence_penalty: 0.6,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw === "string" && retryRaw.trim()) {
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
            }
          } catch (e) {
            console.error(`Victor rename retry failed for episode ${ep}:`, e);
          }
          // Last resort: if still present, do a conservative replace of whole-word Victor.
          if (includesWord(episodeText, "Victor")) {
            const replacement2 = replacement || "Damien";
            episodeText = episodeText.replace(/\bVictor\b/g, replacement2);
          }
        }

        // Final-episode pass: lightly edit the ending away from cliffhangers into true resolution.
        if (ep === episodeCount && typeof episodeText === "string" && episodeText.trim()) {
          try {
            const edit = await openai.chat.completions.create({
              model: PLANNER_MODEL,
              messages: [
                { role: "system", content: ENDING_EDIT_SYSTEM_PROMPT },
                {
                  role: "user",
                  content:
                    "Here is the full script for the FINAL episode of the season. " +
                    "Lightly edit ONLY as needed so that the ending is a true resolution (no new threats, no teasers), " +
                    "and return the complete edited script:\n\n" +
                    episodeText,
                },
              ],
              max_tokens: 2048,
              temperature: 0.3,
            });
            const editedRaw = edit.choices?.[0]?.message?.content;
            if (typeof editedRaw === "string" && editedRaw.trim()) {
              episodeText = finalizeEpisodeText(editedRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
            }
          } catch (editErr) {
            console.error(`Ending edit failed for final episode ${ep}:`, editErr);
          }
        }

        // If the ending-edit step reintroduced the forbidden name, strip it (rare but possible).
        if (!victorAllowed && includesWord(episodeText, "Victor")) {
          episodeText = episodeText.replace(/\bVictor\b/g, pickReplacementNameForVictor());
        }

        // Phase 2 — Embedding similarity on early-episode chunk vs all prior episodes (semantic nearness).
        if (ENABLE_EPISODE_EMBEDDING_GATE && OPENAI_API_KEY) {
          const chunk = sliceTextForEpisodeEmbedding(episodeText, EMBEDDING_CHUNK_CHARS);
          let vec = chunk.length >= 80 ? await fetchEpisodeChunkEmbedding(chunk) : null;
          if (ep > 1 && vec && episodeEmbeddingMemo.length === episodeScriptsMemo.length) {
            const { sim, ep: nearEp } = bestPriorEmbeddingSimilarity(vec, episodeEmbeddingMemo);
            if (sim >= EMBEDDING_SIMILARITY_THRESHOLD) {
              sendStreamLine(res, {
                type: "embedding_similarity_gate",
                episode: ep,
                similar_to_episode: nearEp,
                similarity: Math.round(sim * 1000) / 1000,
                threshold: EMBEDDING_SIMILARITY_THRESHOLD,
                status: "regenerating",
              });
              const embedHint =
                `\n\nSEMANTIC OPENING REJECTION (embedding cosine ${sim.toFixed(3)} ≥ ${EMBEDDING_SIMILARITY_THRESHOLD} vs episode ${nearEp}):\n` +
                "Your early scenes read as the same situation and emotional beat as that episode, even with different wording. " +
                "Rewrite the COMPLETE episode: change setting, sensory details, conflict frame, and dialogue moves while advancing the plot and keeping the same main cast names.";
              try {
                const embResp = await openai.chat.completions.create({
                  model: GENERATOR_MODEL,
                  messages: [
                    { role: "system", content: generatorSystemPrompt },
                    { role: "user", content: userContent + embedHint },
                  ],
                  max_tokens: 2048,
                  temperature: 0.55,
                  frequency_penalty: 1.0,
                  presence_penalty: 0.6,
                });
                const embRaw = embResp.choices?.[0]?.message?.content;
                if (typeof embRaw === "string" && embRaw.trim()) {
                  episodeText = finalizeEpisodeText(embRaw.trim(), ep, seriesNames);
                  episodeText = normalizeEpisodeCharacterNames(
                    episodeText,
                    CHARACTER_NAME_REGISTRY_PATH
                  );
                  const spanEmb = targetedRepairEpisodeText(episodeText, seriesNames);
                  episodeText = spanEmb.text;
                  if (!victorAllowed && includesWord(episodeText, "Victor")) {
                    episodeText = episodeText.replace(/\bVictor\b/g, pickReplacementNameForVictor());
                  }
                  const chunk2 = sliceTextForEpisodeEmbedding(episodeText, EMBEDDING_CHUNK_CHARS);
                  const vec2 =
                    chunk2.length >= 80 ? await fetchEpisodeChunkEmbedding(chunk2) : null;
                  const check2 = bestPriorEmbeddingSimilarity(vec2, episodeEmbeddingMemo);
                  sendStreamLine(res, {
                    type: "embedding_similarity_gate",
                    episode: ep,
                    phase: "post_regen",
                    similar_to_episode: check2.ep,
                    similarity: Math.round(check2.sim * 1000) / 1000,
                    cleared: check2.sim < EMBEDDING_SIMILARITY_THRESHOLD,
                  });
                  vec = vec2;
                }
              } catch (embGateErr) {
                console.warn(
                  `Episode ${ep} embedding-gate regen failed:`,
                  embGateErr?.message || embGateErr
                );
                sendStreamLine(res, {
                  type: "embedding_similarity_gate",
                  episode: ep,
                  phase: "regen_error",
                  message: String(embGateErr?.message || embGateErr),
                });
              }
            }
          }
          episodeEmbeddingMemo.push(vec);
        }

        // Global duplicate audit (pairwise structural + text) — incremental season check each episode.
        if (ep > 1 && episodeScriptsMemo.length > 0) {
          const provisionalRecap = {
            episode: ep,
            openingFingerprint: extractOpeningFingerprint(episodeText),
            recap: "",
            tags: [],
          };
          const augmentedRecaps = [...episodeRecaps, provisionalRecap];
          const allScripts = [...episodeScriptsMemo, episodeText];
          const dupFlags = detectDuplicateEpisodes(allScripts, augmentedRecaps);
          const relevant = dupFlags.filter((f) => f.ep_a === ep || f.ep_b === ep);
          if (relevant.length) {
            sendStreamLine(res, {
              type: "duplicate_audit",
              episode: ep,
              flag_count: relevant.length,
              pairs: relevant.map((f) => ({
                ep_a: f.ep_a,
                ep_b: f.ep_b,
                severity: f.severity,
                structural_score: f.structural_score,
                text_score: f.text_score,
                reasons: f.reasons,
              })),
            });
            const healHint =
              "\n\nGLOBAL DUPLICATE AUDIT — FULL EPISODE REWRITE REQUIRED:\n" +
              "Season-level comparison flagged this episode as too similar to another (opening structure and/or full-text overlap).\n" +
              relevant
                .map(
                  (f, i) =>
                    `${i + 1}. Episodes ${f.ep_a} & ${f.ep_b} [${f.severity}] — ${f.reasons.join("; ")}`
                )
                .join("\n") +
              "\n\nRewrite the COMPLETE episode: new scenes, new dialogue, new blocking. " +
              "Keep continuity (same tagged main cast, story moves forward, no reset) but do not echo the paired episode’s shape or lines.";
            let healed = false;
            try {
              const healResp = await openai.chat.completions.create({
                model: FINETUNED_MODEL,
                messages: [
                  { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                  { role: "user", content: userContent + healHint },
                ],
                max_tokens: 2048,
                temperature: 0.45,
                frequency_penalty: 1.0,
                presence_penalty: 0.65,
              });
              const healRaw = healResp.choices?.[0]?.message?.content;
              if (typeof healRaw === "string" && healRaw.trim()) {
                episodeText = finalizeEpisodeText(healRaw.trim(), ep, seriesNames);
                episodeText = normalizeEpisodeCharacterNames(
                  episodeText,
                  CHARACTER_NAME_REGISTRY_PATH
                );
                const spanHeal = targetedRepairEpisodeText(episodeText, seriesNames);
                episodeText = spanHeal.text;
                const prov2 = {
                  episode: ep,
                  openingFingerprint: extractOpeningFingerprint(episodeText),
                  recap: "",
                  tags: [],
                };
                const rec2 = [...episodeRecaps, prov2];
                const scripts2 = [...episodeScriptsMemo, episodeText];
                const dupAfter = detectDuplicateEpisodes(scripts2, rec2).filter(
                  (f) => f.ep_a === ep || f.ep_b === ep
                );
                healed = dupAfter.length === 0;
                sendStreamLine(res, {
                  type: "duplicate_audit",
                  episode: ep,
                  phase: "post_heal",
                  flag_count: dupAfter.length,
                  cleared: healed,
                  pairs: dupAfter.map((f) => ({
                    ep_a: f.ep_a,
                    ep_b: f.ep_b,
                    severity: f.severity,
                    structural_score: f.structural_score,
                    text_score: f.text_score,
                  })),
                });
                if (!healed) {
                  console.warn(
                    `Episode ${ep}: duplicate audit still flags ${dupAfter.length} pair(s) after heal — keeping healed draft.`
                  );
                }
              }
            } catch (dupHealErr) {
              console.warn(`Episode ${ep} duplicate heal failed:`, dupHealErr?.message || dupHealErr);
              sendStreamLine(res, {
                type: "duplicate_audit",
                episode: ep,
                phase: "heal_error",
                message: String(dupHealErr?.message || dupHealErr),
              });
            }
          }
        }

        // Phase D — Script Doctor: score the clean draft against a craft rubric and, if weak,
        // do ONE bounded punch-up that improves only the flagged areas. Runs after all
        // structural/quality/repetition gates and before the Phase 2 length trim (so any added
        // text is then condensed back to budget).
        if (ENABLE_SCRIPT_DOCTOR) {
          try {
            const doctorPlan = blueprint?.episodes?.[ep - 1] || null;
            const doctorBible = blueprint?.protagonist_bible || null;
            const review = await scoreEpisodeWithDoctor({
              episodeText,
              episodeNumber: ep,
              totalEpisodes: episodeCount,
              plan: doctorPlan,
              bible: doctorBible,
            });
            if (review && review.scores) {
              sendStreamLine(res, {
                type: "script_doctor",
                episode: ep,
                phase: "scored",
                scores: review.scores,
                min_dimension: review.minDim,
                threshold: SCRIPT_DOCTOR_MIN_SCORE,
              });
              const needsWork =
                (review.minDim != null && review.minDim < SCRIPT_DOCTOR_MIN_SCORE) ||
                (review.scores.overall != null &&
                  review.scores.overall < SCRIPT_DOCTOR_MIN_SCORE);
              if (needsWork) {
                for (let dAttempt = 1; dAttempt <= MAX_SCRIPT_DOCTOR_REWRITES; dAttempt++) {
                  const improvedRaw = await punchUpEpisode({
                    episodeText,
                    episodeNumber: ep,
                    totalEpisodes: episodeCount,
                    weaknesses: review.weaknesses,
                    plan: doctorPlan,
                    bible: doctorBible,
                    lenPlan,
                    generatorSystemPrompt,
                  });
                  if (!improvedRaw) break;
                  let candidate = finalizeEpisodeText(improvedRaw, ep, seriesNames);
                  candidate = normalizeEpisodeCharacterNames(
                    candidate,
                    CHARACTER_NAME_REGISTRY_PATH
                  );
                  const spanRepair = targetedRepairEpisodeText(candidate, seriesNames);
                  candidate = spanRepair.text;
                  if (!victorAllowed && includesWord(candidate, "Victor")) {
                    candidate = candidate.replace(/\bVictor\b/g, pickReplacementNameForVictor());
                  }
                  // Accept only a well-formed, non-collapsed rewrite that did not blow the budget.
                  const candidateChars = episodeBodyCharCount(candidate);
                  const accept =
                    passesBasicFormatCheck(candidate) &&
                    !hasQualityCollapse(candidate, seriesNames) &&
                    candidateChars <= Math.round(lenPlan.hardMaxChars * 1.35);
                  if (accept) {
                    episodeText = candidate;
                    sendStreamLine(res, {
                      type: "script_doctor",
                      episode: ep,
                      phase: "punched_up",
                      attempt: dAttempt,
                      weaknesses: review.weaknesses,
                    });
                    break;
                  } else {
                    sendStreamLine(res, {
                      type: "script_doctor",
                      episode: ep,
                      phase: "rewrite_rejected",
                      attempt: dAttempt,
                      candidate_chars: candidateChars,
                    });
                  }
                }
              }
            }
          } catch (doctorErr) {
            console.warn(`Episode ${ep} script doctor failed:`, doctorErr?.message || doctorErr);
            sendStreamLine(res, {
              type: "script_doctor",
              episode: ep,
              phase: "error",
              message: String(doctorErr?.message || doctorErr),
            });
          }
        }

        // Phase 2 — soft length gate: condense episodes that overshoot the vertical budget.
        // Runs after all anti-repetition/quality regen so nothing downstream re-expands the text,
        // and before recap/state/persist so those reflect the trimmed episode.
        if (ENABLE_EPISODE_LENGTH_TRIM) {
          try {
            let bodyChars = episodeBodyCharCount(episodeText);
            if (bodyChars > lenPlan.hardMaxChars) {
              sendStreamLine(res, {
                type: "length_trim",
                episode: ep,
                phase: "start",
                chars: bodyChars,
                target_chars: lenPlan.targetChars,
                hard_max_chars: lenPlan.hardMaxChars,
                establishing_episode: lenPlan.isEstablishing,
              });
              for (let attempt = 1; attempt <= MAX_LENGTH_TRIM_ATTEMPTS; attempt++) {
                if (bodyChars <= lenPlan.hardMaxChars) break;
                const condensed = await condenseEpisodeToBudget({
                  episodeText,
                  episodeNumber: ep,
                  totalEpisodes: episodeCount,
                  attempt,
                  lenPlan,
                });
                if (!condensed) break;
                let candidate = finalizeEpisodeText(condensed, ep, seriesNames);
                const candidateChars = episodeBodyCharCount(candidate);
                // Only accept a shorter draft that is still well-formed and not a quality collapse.
                const validForm =
                  passesBasicFormatCheck(candidate) &&
                  !hasQualityCollapse(candidate, seriesNames);
                if (validForm && candidateChars < bodyChars) {
                  candidate = normalizeEpisodeCharacterNames(
                    candidate,
                    CHARACTER_NAME_REGISTRY_PATH
                  );
                  const spanRepair = targetedRepairEpisodeText(candidate, seriesNames);
                  episodeText = spanRepair.text;
                  bodyChars = episodeBodyCharCount(episodeText);
                  sendStreamLine(res, {
                    type: "length_trim",
                    episode: ep,
                    phase: "applied",
                    attempt,
                    chars: bodyChars,
                  });
                } else {
                  sendStreamLine(res, {
                    type: "length_trim",
                    episode: ep,
                    phase: "rejected",
                    attempt,
                    candidate_chars: candidateChars,
                    valid_form: validForm,
                  });
                  break;
                }
              }
              if (bodyChars > lenPlan.hardMaxChars) {
                sendStreamLine(res, {
                  type: "length_trim",
                  episode: ep,
                  phase: "exhausted",
                  chars: bodyChars,
                });
              }
            }
          } catch (trimErr) {
            console.error(`Length trim failed for episode ${ep}:`, trimErr);
          }
        }

        // Tag big events in this episode for future anti-repetition guidance (after all text edits).
        const eventTags = tagEpisodeEvents(episodeText);

        // Phase 1: audit character cue name variants and keep a registry on disk.
        try {
          await updateCharacterNameRegistryFromEpisode({
            episodeText,
            registryPath: CHARACTER_NAME_REGISTRY_PATH,
            seedCanonicalHeaderNames: [
              seriesNames?.heroine,
              seriesNames?.coldCeo,
              seriesNames?.warmFriend,
            ].filter(Boolean),
          });
        } catch (regErr) {
          console.warn("Name registry update failed:", regErr?.message || regErr);
        }

        // Summarize this episode for future context (best-effort).
        try {
          const recap = await summarizeEpisode({
            episodeNumber: ep,
            text: episodeText,
          });
          if (recap) {
            episodeRecaps.push({
              episode: ep,
              recap,
              tags: eventTags,
              openingBeat: extractOpeningBeat(episodeText),
              openingFingerprint: extractOpeningFingerprint(episodeText),
            });
            sendStreamLine(res, {
              type: "recap",
              episode: ep,
              recap,
            });
          }
        } catch (recErr) {
          console.error(`Recap generation failed for episode ${ep}:`, recErr);
        }

        // Structured state summary for context-windowed chaining.
        try {
          const state = await summarizeEpisodeState({
            episodeNumber: ep,
            text: episodeText,
          });
          if (state) {
            episodeStateMemo.push(state);
            sendStreamLine(res, { type: "episode_state", episode: ep, ok: true });
          } else {
            sendStreamLine(res, { type: "episode_state", episode: ep, ok: false });
          }
        } catch (stateErr) {
          console.error(`Episode state summary failed for episode ${ep}:`, stateErr);
          sendStreamLine(res, { type: "episode_state", episode: ep, ok: false });
        }

        episodeScriptsMemo.push(episodeText);
        sendStreamLine(res, { type: "episode", episode: ep, text: episodeText });
        if (persist) {
          try {
            await persistEpisodeProgress(persist, episodeScriptsMemo, episodeCount);
          } catch (pe) {
            console.warn(`persist episode ${ep}:`, pe?.message || pe);
          }
        }
      } catch (epErr) {
        console.error(`Episode ${ep} error:`, epErr);
        const fallback = `[Episode ${ep} failed to generate.]`;
        episodeScriptsMemo.push(fallback);
        if (ENABLE_EPISODE_EMBEDDING_GATE && OPENAI_API_KEY) {
          episodeEmbeddingMemo.push(null);
        }
        sendStreamLine(res, { type: "episode", episode: ep, text: fallback });
        if (persist) {
          try {
            await persistEpisodeProgress(persist, episodeScriptsMemo, episodeCount);
          } catch (pe) {
            console.warn(`persist episode ${ep} (fallback):`, pe?.message || pe);
          }
        }
      }
    }

    const lang = String(body.language || "EN").toUpperCase();
    const wantZh =
      body.translateToChinese !== false &&
      lang !== "ZH" &&
      episodeScriptsMemo.length > 0;
    const episodeZhMemo = [];
    if (wantZh) {
      const total = episodeScriptsMemo.length;
      let hardStop = false;
      for (let i = 0; i < total; i++) {
        if (hardStop) break;
        const epNum = i + 1;
        try {
          // sendStreamLine is inside the try so a connection drop is caught here
          // instead of escaping to the outer catch and killing remaining episodes.
          sendStreamLine(res, { type: "translation_progress", episode: epNum, total });
          const zh = await translateEpisodeScriptToChinese(epNum, total, episodeScriptsMemo[i]);
          const text = zh || `[Episode ${epNum} — translation produced no text; see English PDF.]`;
          episodeZhMemo.push(text);
          sendStreamLine(res, { type: "episode_zh", episode: epNum, text });
        } catch (trErr) {
          console.error(`Chinese translation failed for episode ${epNum}:`, trErr);
          const msg = safeStr(trErr?.message) || "translation failed";
          const status = trErr?.status;
          // Hard quota (account out of credits) — no point continuing
          const isHardQuota = /insufficient_quota/i.test(msg) || (status === 429 && /quota/i.test(msg));
          const placeholder = `[Episode ${epNum} — translation failed: ${msg}]`;
          try {
            sendStreamLine(res, { type: "translation_error", episode: epNum, message: msg });
            sendStreamLine(res, {
              type: "episode_zh",
              episode: epNum,
              text: placeholder,
            });
          } catch (_writeErr) {
            // Client disconnected — nothing we can do, stop cleanly
            hardStop = true;
          }
          // Must push one slot per English episode so joinEpisodeScriptsForStorage indices match
          // episode numbers (fixes partial Chinese when a mid-season translation errors).
          episodeZhMemo.push(placeholder);
          if (isHardQuota) hardStop = true;
        }
      }
      const missing = total - episodeZhMemo.length;
      if (missing > 0) {
        for (let k = 0; k < missing; k++) {
          const epNum = episodeZhMemo.length + 1;
          const placeholder = `[Episode ${epNum} — translation not run (generation stopped early). See English episode.]`;
          episodeZhMemo.push(placeholder);
          try {
            sendStreamLine(res, { type: "episode_zh", episode: epNum, text: placeholder });
          } catch (_) {
            /* ignore */
          }
        }
      }
    }

    if (persist?.scriptId && persist?.userId) {
      try {
        const fullEn = joinEpisodeScriptsForStorage(episodeScriptsMemo);
        const fullZh = wantZh && episodeZhMemo.length ? joinEpisodeScriptsForStorage(episodeZhMemo) : "";
        const doneActual = episodeScriptsMemo.length;
        await markScriptComplete(persist.scriptId, persist.userId, {
          english_text: fullEn,
          chinese_text: fullZh,
          episode_done: doneActual,
        });
      } catch (ce) {
        console.warn("markScriptComplete:", ce?.message || ce);
      }
    }

    sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
  } catch (err) {
    console.error(err);
    sendStreamLine(res, { type: "error", message: err.message || "Generation failed" });
    sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
    if (persist?.scriptId && persist?.userId) {
      try {
        await markScriptFailed(persist.scriptId, persist.userId, err.message || "Generation failed");
      } catch (_) {}
    }
  }
}

function parseEpisodesFromEnglishScript(scriptText) {
  const raw = safeStr(scriptText);
  if (!raw) return null;
  const re = /^EPISODE\s+(\d+)\s*$/gm;
  const matches = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const ep = parseInt(m[1], 10);
    if (!Number.isFinite(ep)) continue;
    matches.push({ episode: ep, index: m.index });
  }
  if (!matches.length) return null;

  const totalEpisodes = Math.max(...matches.map((x) => x.episode));
  const episodes = matches
    .map((match, i) => {
      const start = match.index;
      const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
      const chunk = raw.slice(start, end).trimEnd();
      const lines = chunk.split(/\r?\n/);
      const body = lines.slice(1).join("\n").trim();
      return { episode: match.episode, englishText: body };
    })
    .sort((a, b) => a.episode - b.episode);

  return { totalEpisodes, episodes };
}

app.post("/translate-to-chinese", requireAuth, async (req, res) => {
  const body = req.body || {};
  const englishText = safeStr(body.text || body.script);
  const parsed = parseEpisodesFromEnglishScript(englishText);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  if (!parsed) {
    sendStreamLine(res, {
      type: "translation_error",
      message: "Could not parse episodes. Make sure the English script includes 'EPISODE N' headings.",
    });
    sendStreamLine(res, { type: "done" });
    return res.end();
  }

  const { totalEpisodes, episodes } = parsed;
  try {
    for (const ep of episodes) {
      sendStreamLine(res, {
        type: "translation_progress",
        episode: ep.episode,
        total: totalEpisodes,
      });
      try {
        const zh = await translateEpisodeScriptToChinese(
          ep.episode,
          totalEpisodes,
          ep.englishText
        );
        sendStreamLine(res, {
          type: "episode_zh",
          episode: ep.episode,
          text: zh || `[Episode ${ep.episode} — translation produced no text.]`,
        });
      } catch (trErr) {
        const msg = safeStr(trErr?.message) || "translation failed";
        const status = trErr?.status;
        const isQuota = status === 429 || /429|quota/i.test(msg);
        sendStreamLine(res, {
          type: "translation_error",
          episode: ep.episode,
          message: msg,
        });
        if (isQuota) break;
      }
    }
  } catch (outerErr) {
    console.error("Translation endpoint failed:", outerErr);
    sendStreamLine(res, {
      type: "translation_error",
      message: safeStr(outerErr?.message) || "Translation failed",
    });
  }

  sendStreamLine(res, { type: "done", model: TRANSLATION_MODEL });
  res.end();
});

app.get("/health", (_, res) => {
  res.json({ ok: true, model: FINETUNED_MODEL });
});

// ---------------------------------------------------------------------------
// Genre-based summary and ending suggestions
// ---------------------------------------------------------------------------
const SUMMARIES_PATH = join(__dirname, "data", "summaries_by_genre.json");
const ENDINGS_PATH = join(__dirname, "data", "endings_by_genre.json");

function loadSummariesByGenre() {
  try {
    const raw = fs.readFileSync(SUMMARIES_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

/** Random preset for genre: JSON list if present, else procedural generateLogline. */
function pickRandomPresetSummary(genre) {
  const g = String(genre || "").trim() || "Romance";
  const data = loadSummariesByGenre();
  const list = Array.isArray(data[g]) ? data[g] : [];
  let summary = list.length > 0 ? list[Math.floor(Math.random() * list.length)] : "";
  summary = safeStr(summary).trim();
  if (!summary) {
    try {
      summary = generateLogline(g);
    } catch (_) {
      summary = "";
    }
  }
  return safeStr(summary).trim().slice(0, 1500);
}

function loadEndingsByGenre() {
  try {
    const raw = fs.readFileSync(ENDINGS_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

/** GET /summaries?genre=Romance — list all summaries for that genre */
app.get("/summaries", (req, res) => {
  const genre = String(req.query.genre || "").trim() || "Romance";
  const data = loadSummariesByGenre();
  const summaries = Array.isArray(data[genre]) ? data[genre] : [];
  res.json({ genre, summaries });
});

/** GET /logline/random?genre=Romance — procedurally generated logline (never repeats) */
app.get("/logline/random", (req, res) => {
  const genre = String(req.query.genre || "").trim() || "Romance";
  try {
    const logline = generateLogline(genre);
    res.json({ genre, logline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /logline/genres — list supported genres for procedural generation */
app.get("/logline/genres", (_req, res) => {
  res.json({ genres: SUPPORTED_GENRES });
});

/** GET /summaries/random?genre=Romance — one random preset summary for that genre */
app.get("/summaries/random", (req, res) => {
  const genre = String(req.query.genre || "").trim() || "Romance";
  const summary = pickRandomPresetSummary(genre);
  res.json({ genre, summary });
});

const PORT = process.env.PORT || 3001;
const start = async () => {
  try {
    await initDb();
    console.log("Postgres DB initialized.");
    if (process.env.SKIP_STUCK_GENERATION_RESET !== "true") {
      try {
        const cleared = await markInterruptedGeneratingScripts();
        if (cleared > 0) {
          console.warn(
            `[startup] Cleared ${cleared} orphaned "generating" script(s) (no worker after previous deploy/crash).`
          );
        }
      } catch (resetErr) {
        console.warn("[startup] Stuck-generation reset failed:", resetErr?.message || resetErr);
      }
    }
  } catch (e) {
    console.warn("Postgres init skipped/failed:", e?.message || e);
  }
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Using model: ${FINETUNED_MODEL}`);
    console.log("Blueprint: chunked planner v2 (8 eps/chunk) + single-shot fallback; log tag [blueprint]");
  });
};
start();
