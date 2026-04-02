/**
 * Golden-style regression tests: fixed inputs → expected gate decisions.
 * Run: npm test  (from backend/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  passesBasicFormatCheck,
  tagEpisodeEvents,
  hasQualityCollapse,
  measureVerticalEpisodeLengthBudget,
  detectDuplicateEpisodes,
  measureRepetitionAgainstRecent,
  extractOpeningFingerprint,
  scoreOpeningSimilarity,
  repetitionScore,
} from "../episodeGatesCore.js";
import { auditMergedWords } from "../mergedWordsAudit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sampleScript(extraActionLines = 24) {
  const parts = ["INT. TEST ROOM - DAY", ""];
  for (let i = 0; i < extraActionLines; i++) {
    parts.push(`She pauses at the window. Small beat ${i}.`);
  }
  parts.push("HEROINE", "I need answers.", "LUKE", "Then ask.");
  return parts.join("\n");
}

test("passesBasicFormatCheck: representative valid screenplay passes", () => {
  assert.equal(passesBasicFormatCheck(sampleScript(24)), true);
});

test("measureVerticalEpisodeLengthBudget: normal episode under cap", () => {
  const m = measureVerticalEpisodeLengthBudget(sampleScript(120));
  assert.equal(m.exceeds, false);
});

test("hasQualityCollapse: runaway length triggers length gate", () => {
  assert.equal(hasQualityCollapse(sampleScript(280), null), true);
});

test("measureRepetitionAgainstRecent: shared long sentence triggers retry", () => {
  const sentence =
    "this is a deliberately long repeated sentence for overlap testing purposes here today";
  const a = `INT. A - DAY\n\nX\n${sentence}.`;
  const b = `INT. B - DAY\n\nY\n${sentence}.`;
  const m = measureRepetitionAgainstRecent(b, [a]);
  assert.equal(m.needsRetry, true);
});

test("detectDuplicateEpisodes: identical scripts flag text overlap", () => {
  const body = sampleScript(26);
  const flags = detectDuplicateEpisodes([body, body], []);
  assert.ok(flags.length >= 1);
  assert.ok(flags.some((f) => f.text_score >= 0.35));
});

test("extractOpeningFingerprint: stable keys on minimal script", () => {
  const text = `INT. LIBRARY - DAY

Shelves line the walls.

ELARA
Still chasing shadows?`;

  const fp = extractOpeningFingerprint(text);
  assert.equal(fp.location.includes("LIBRARY"), true);
  assert.equal(typeof fp.action, "string");
  assert.equal(typeof fp.dialogue_type, "string");
});

test("golden-gates.json fixtures", () => {
  const raw = readFileSync(join(__dirname, "golden-gates.json"), "utf8");
  const { cases } = JSON.parse(raw);
  assert.ok(Array.isArray(cases) && cases.length > 0);

  for (const c of cases) {
    if (c.gate === "passesBasicFormatCheck") {
      assert.equal(passesBasicFormatCheck(c.input), c.expect, c.id);
    } else if (c.gate === "tagEpisodeEvents_sorted") {
      const got = [...tagEpisodeEvents(c.input)].sort().join(",");
      assert.equal(got, c.expect, c.id);
    } else if (c.gate === "hasQualityCollapse") {
      assert.equal(hasQualityCollapse(c.input, c.names ?? null), c.expect, c.id);
    } else if (c.gate === "scoreOpeningSimilarity_rounded") {
      const v = scoreOpeningSimilarity(c.fp1, c.fp2);
      assert.equal(Math.round(v * 1000) / 1000, c.expect, c.id);
    } else if (c.gate === "repetitionScore_rounded") {
      const v = repetitionScore(c.a, c.b);
      assert.equal(Math.round(v * 1000) / 1000, c.expect, c.id);
    } else if (c.gate === "auditMergedWords_mergedTotal_atLeast") {
      const r = auditMergedWords(c.input);
      assert.ok(
        r.totals.mergedTotal >= c.expect,
        `${c.id}: mergedTotal ${r.totals.mergedTotal} < ${c.expect}`
      );
    } else {
      assert.fail(`Unknown gate "${c.gate}" in case ${c.id}`);
    }
  }
});
