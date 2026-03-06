import { useState } from "react";
import { PDFDocument, StandardFonts } from "pdf-lib";
import "./App.css";

const API_BASE = "https://vertical-script.onrender.com";

function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [genre, setGenre] = useState("NON_WEREWOLF");
    const PRESET_SUMMARY =
    "Poor, underestimated heroine, all bad luck lands on her, two handsome rich men competing for her, she's forced to grow, and will eventually marry into money/power.";
  const [logline, setLogline] = useState(PRESET_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  const wordCount = logline.trim() ? logline.trim().split(/\s+/).length : 0;
  const loglineOverLimit = wordCount > 250;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loglineOverLimit) return;
    setError("");
    setScript("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          genre,
          language: "EN",
          episodeCount: 60,
          title: "Generated Script",
          logline: logline.trim().slice(0, 1500),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setScript(data.script || "");
      setModalOpen(false);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!script) return;
    try {
      setDownloading(true);
      const pdfDoc = await PDFDocument.create();
      const pageMargin = 40;
      const fontSize = 10;
      const lineHeight = 12;
      const courier = await pdfDoc.embedFont(StandardFonts.Courier);

      let page = pdfDoc.addPage();
      let { width, height } = page.getSize();
      let y = height - pageMargin;

      // Very simple screenplay-aware layout.
      const wrapLine = (text, maxChars) => {
        const result = [];
        let remaining = text;
        const limit = maxChars || 90;
        while (remaining.length > limit) {
          result.push(remaining.slice(0, limit));
          remaining = remaining.slice(limit);
        }
        if (remaining.length) result.push(remaining);
        return result;
      };

      const isSceneHeading = (t) =>
        /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(t.trim());

      const isCharacterLine = (t) => {
        const s = t.trim();
        if (!s) return false;
        if (s.length < 2 || s.length > 40) return false;
        if (/[.!?]/.test(s)) return false;
        // Allow spaces and parentheses, but mostly caps.
        const letters = s.replace(/[^A-Z]/g, "");
        return letters.length >= Math.max(3, Math.floor(s.replace(/\s+/g, "").length * 0.6));
      };

      const isParenthetical = (t) =>
        /^\(.+\)$/.test(t.trim());

      const lines = script.split(/\r?\n/);
      let prevType = "blank";

      for (const raw of lines) {
        const text = raw.replace(/\s+$/g, "");
        const trimmed = text.trim();

        if (!trimmed) {
          // Blank line = vertical gap.
          y -= lineHeight;
          prevType = "blank";
          continue;
        }

        let lineType;
        if (isSceneHeading(trimmed)) {
          lineType = "scene";
        } else if (isCharacterLine(trimmed)) {
          lineType = "character";
        } else if (isParenthetical(trimmed)) {
          lineType = "parenthetical";
        } else if (
          prevType === "character" ||
          prevType === "parenthetical" ||
          prevType === "dialogue"
        ) {
          lineType = "dialogue";
        } else {
          lineType = "action";
        }

        // Choose indent and wrap width by type.
        let x;
        let maxChars;
        switch (lineType) {
          case "scene":
            x = pageMargin;
            maxChars = 80;
            // Extra space before a new scene heading.
            if (prevType !== "blank") y -= lineHeight;
            break;
          case "character":
            x = pageMargin + 170;
            maxChars = 40;
            if (prevType !== "blank" && prevType !== "scene") y -= lineHeight / 2;
            break;
          case "parenthetical":
            x = pageMargin + 150;
            maxChars = 45;
            break;
          case "dialogue":
            x = pageMargin + 130;
            maxChars = 55;
            break;
          case "action":
          default:
            x = pageMargin;
            maxChars = 90;
            break;
        }

        const segments = wrapLine(trimmed, maxChars);
        for (const seg of segments) {
          if (y < pageMargin) {
            page = pdfDoc.addPage();
            ({ width, height } = page.getSize());
            y = height - pageMargin;
          }
          page.drawText(seg, {
            x,
            y,
            size: fontSize,
            font: courier,
          });
          y -= lineHeight;
        }

        prevType = lineType;
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "vertical_script.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Failed to generate PDF download"
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="page">
      <header className="header">
        <h1 className="title">VERTICAL INFINITE.</h1>
      </header>

      <button
        type="button"
        className="btn-open"
        onClick={() => setModalOpen(true)}
      >
        Generate script
      </button>

      {script && (
        <section className="script-output">
          <h2>Generated script</h2>
          <div className="script-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownloadPdf}
              disabled={downloading}
            >
              {downloading ? "Preparing PDF…" : "Download PDF"}
            </button>
          </div>
          <pre className="script-text">{script}</pre>
        </section>
      )}

      {modalOpen && (
        <div className="modal-backdrop" onClick={() => !loading && setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">New script / 新剧本</h2>
            {loading && (
              <div className="loading-bar-wrap">
                <div className="loading-bar" />
              </div>
            )}
            <form onSubmit={handleSubmit}>
              <label className="field">
                <span>Genre (Normal / Werewolf) / 类型（普通 / 狼人）</span>
                <select
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                >
                  <option value="NON_WEREWOLF">Normal / 普通</option>
                  <option value="WEREWOLF">Werewolf / 狼人</option>
                </select>
              </label>
              <label className="field">
                <span>Summary / 摘要</span>
                <textarea
                  value={logline}
                  onChange={(e) => setLogline(e.target.value)}
                  placeholder="A short premise or summary for your vertical..."
                  rows={4}
                  className={loglineOverLimit ? "invalid" : ""}
                />
                <small className="word-count">
                  {wordCount} / 250 words
                  {loglineOverLimit && " — over limit"}
                </small>
              </label>
              {error && <p className="error">{error}</p>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => !loading && setModalOpen(false)}
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={loading || loglineOverLimit}
                >
                  {loading ? "Generating…" : "Generate"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
