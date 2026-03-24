import fs from "fs";
import path from "path";

function safeStr(v) {
  return typeof v === "string" ? v : "";
}

function detectEpisodeNumber(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = safeStr(lines[i]).match(/^\s*EPISODE\s+(\d+)\s*$/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function classifyMerge(line) {
  const t = safeStr(line);
  if (/[a-z][A-Z]{3,}\b/.test(t)) return "action_to_character_name";
  if (/(?:END\s+EPISODE|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b/i.test(t) && /[a-zA-Z].*(?:END\s+EPISODE|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b/i.test(t)) return "structural_swallowing";
  if (/[a-z][A-Z]/.test(t)) return "clause_boundary";
  return null;
}

export function buildMergeCorpusFromFiles(inputPaths = []) {
  const scripts = [];
  for (const p of inputPaths) {
    const abs = path.resolve(p);
    const raw = fs.readFileSync(abs, "utf-8");
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const instances = [];
    for (let i = 0; i < lines.length; i++) {
      const type = classifyMerge(lines[i]);
      if (!type) continue;
      instances.push({
        script: path.basename(abs),
        type,
        episode: detectEpisodeNumber(lines, i),
        line: i + 1,
        merge: lines[i].trim().slice(0, 240),
        context: {
          before: safeStr(lines[i - 1] || ""),
          current: safeStr(lines[i] || ""),
          after: safeStr(lines[i + 1] || ""),
        },
      });
    }
    scripts.push({
      script: path.basename(abs),
      total: instances.length,
      byType: {
        clause_boundary: instances.filter((x) => x.type === "clause_boundary").length,
        action_to_character_name: instances.filter((x) => x.type === "action_to_character_name").length,
        structural_swallowing: instances.filter((x) => x.type === "structural_swallowing").length,
      },
      instances,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    scripts,
    totals: {
      all: scripts.reduce((a, s) => a + s.total, 0),
      clause_boundary: scripts.reduce((a, s) => a + s.byType.clause_boundary, 0),
      action_to_character_name: scripts.reduce((a, s) => a + s.byType.action_to_character_name, 0),
      structural_swallowing: scripts.reduce((a, s) => a + s.byType.structural_swallowing, 0),
    },
  };
}

if (process.argv.length > 2) {
  const args = process.argv.slice(2);
  const inputsIdx = args.indexOf("--inputs");
  const outIdx = args.indexOf("--out");
  const inputs = inputsIdx >= 0 ? String(args[inputsIdx + 1] || "").split(",").map((x) => x.trim()).filter(Boolean) : [];
  const out = outIdx >= 0 ? String(args[outIdx + 1] || "merge-corpus.json") : "merge-corpus.json";
  if (!inputs.length) {
    console.error("Missing --inputs");
    process.exit(2);
  }
  const payload = buildMergeCorpusFromFiles(inputs);
  fs.writeFileSync(path.resolve(out), JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Merge corpus written: ${path.resolve(out)} (instances: ${payload.totals.all})`);
}

