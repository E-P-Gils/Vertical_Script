import { randomUUID } from "crypto";
import { getPool } from "./db.js";

export async function createGeneratingScript({ userId, title, genre, summary, episodeTarget }) {
  const pool = getPool();
  const id = randomUUID();
  const r = await pool.query(
    `INSERT INTO saved_scripts (
       id, user_id, title, genre, summary, episode_target, episode_done, status, english_text, chinese_text
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, 0, 'generating', '', '')
     RETURNING id, created_at`,
    [
      id,
      userId,
      String(title || "Generated Script").slice(0, 400),
      String(genre || "").slice(0, 120),
      String(summary || "").slice(0, 2000),
      episodeTarget,
    ]
  );
  return r.rows[0];
}

export async function updateScriptProgress(scriptId, userId, patch) {
  const pool = getPool();
  const { english_text, episode_done, episode_target, status } = patch;
  await pool.query(
    `UPDATE saved_scripts SET
       english_text = $3,
       episode_done = $4,
       episode_target = $5,
       status = $6,
       updated_at = NOW()
     WHERE id = $1::uuid AND user_id = $2`,
    [scriptId, userId, english_text, episode_done, episode_target, status]
  );
}

export async function markScriptFailed(scriptId, userId, errorMessage) {
  const pool = getPool();
  await pool.query(
    `UPDATE saved_scripts SET
       status = 'failed',
       error_message = $3,
       updated_at = NOW()
     WHERE id = $1::uuid AND user_id = $2`,
    [scriptId, userId, String(errorMessage || "").slice(0, 2000)]
  );
}

export async function markScriptComplete(scriptId, userId, { english_text, chinese_text, episode_done }) {
  const pool = getPool();
  await pool.query(
    `UPDATE saved_scripts SET
       english_text = $3,
       chinese_text = $4,
       episode_done = $5,
       status = 'complete',
       error_message = NULL,
       updated_at = NOW()
     WHERE id = $1::uuid AND user_id = $2`,
    [scriptId, userId, english_text || "", chinese_text || "", episode_done || 0]
  );
}

export async function getScriptForUser(scriptId, userId) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, title, genre, summary, english_text, chinese_text, status, episode_target, episode_done,
            error_message, created_at, updated_at
     FROM saved_scripts WHERE id = $1::uuid AND user_id = $2`,
    [scriptId, userId]
  );
  return r.rows[0] || null;
}

export async function listScriptsForUser(userId, limit = 50) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, title, genre, summary, status, episode_target, episode_done, error_message, created_at, updated_at
     FROM saved_scripts WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

export async function deleteScriptForUser(scriptId, userId) {
  const pool = getPool();
  const r = await pool.query(
    `DELETE FROM saved_scripts WHERE id = $1::uuid AND user_id = $2 RETURNING id`,
    [scriptId, userId]
  );
  return r.rowCount > 0;
}
