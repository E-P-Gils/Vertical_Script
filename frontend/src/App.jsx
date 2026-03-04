import { useState } from "react";
import { PDFDocument, StandardFonts } from "pdf-lib";
import "./App.css";

const API_BASE = "https://vertical-script.onrender.com";

function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [genre, setGenre] = useState("NON_WEREWOLF");
  const [logline, setLogline] = useState("");
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
          episodeCount: 3,
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

      const wrapLine = (text, maxChars = 100) => {
        const result = [];
        let remaining = text;
        while (remaining.length > maxChars) {
          result.push(remaining.slice(0, maxChars));
          remaining = remaining.slice(maxChars);
        }
        if (remaining.length) result.push(remaining);
        return result;
      };

      const lines = script.split(/\r?\n/);
      for (const rawLine of lines) {
        const segments = rawLine === "" ? [""] : wrapLine(rawLine);
        for (const line of segments) {
          if (y < pageMargin) {
            page = pdfDoc.addPage();
            ({ width, height } = page.getSize());
            y = height - pageMargin;
          }
          page.drawText(line, {
            x: pageMargin,
            y,
            size: fontSize,
            font: courier,
          });
          y -= lineHeight;
        }
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
