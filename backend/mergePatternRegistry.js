import fs from "fs";

export function loadDynamicMergePatterns(jsonPath) {
  try {
    if (!jsonPath || !fs.existsSync(jsonPath)) return [];
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const out = [];
    for (const c of candidates) {
      const src = typeof c?.regex === "string" ? c.regex.trim() : "";
      if (!src) continue;
      try {
        out.push(new RegExp(src, "gi"));
      } catch {
        // skip invalid regex
      }
    }
    return out;
  } catch (err) {
    console.warn("Failed to load dynamic merge patterns:", err?.message || err);
    return [];
  }
}

