import { useState } from "react";
import { PDFDocument, StandardFonts } from "pdf-lib";
import "./App.css";

const API_BASE = "https://vertical-script.onrender.com";

function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const GENRES = [
    "Romance",
    "Drama",
    "Action",
    "Adventure",
    "Crime",
    "Horror",
    "Fantasy",
    "Monster",
    "Science Fiction",
    "Superhero",
    "Werewolf",
  ];
  const [genre, setGenre] = useState("");
  const [logline, setLogline] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ episode: 0, total: 0 });
  const [script, setScript] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const wordCount = logline.trim() ? logline.trim().split(/\s+/).length : 0;
  const MIN_WORDS = 25;
  const loglineUnderMin = wordCount > 0 && wordCount < MIN_WORDS;
  const loglineOverLimit = wordCount > 250;

  const handleSuggestRandomSummary = async () => {
    setLoadingSuggestions(true);
    try {
      const r = await fetch(`${API_BASE}/summaries/random?genre=${encodeURIComponent(genre)}`);
      if (r.ok) {
        const data = await r.json();
        if (data.summary) setLogline(data.summary);
      }
    } catch (_) {}
    finally {
      setLoadingSuggestions(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!genre || loglineOverLimit || loglineUnderMin) return;
    if (!logline.trim()) return;
    setError("");
    setScript("");
    setProgress({ episode: 0, total: 60 });
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Generation failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullScript = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.type === "progress") {
              setProgress({ episode: data.episode || 0, total: data.total || 60 });
            } else if (data.type === "episode") {
              const block = (data.episode != null && data.text != null)
                ? `EPISODE ${data.episode}\n\n${data.text}`
                : "";
              if (block) fullScript += (fullScript ? "\n\n" : "") + block;
              setScript(fullScript);
            } else if (data.type === "error") {
              setError(data.message || "Generation error");
            } else if (data.type === "done") {
              setModalOpen(false);
            }
          } catch (_) {}
        }
      }
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer.trim());
          if (data.type === "progress") setProgress({ episode: data.episode || 0, total: data.total || 60 });
          else if (data.type === "episode") {
            const block = (data.episode != null && data.text != null)
              ? `EPISODE ${data.episode}\n\n${data.text}`
              : "";
            if (block) fullScript += (fullScript ? "\n\n" : "") + block;
            setScript(fullScript);
          } else if (data.type === "done") setModalOpen(false);
        } catch (_) {}
      }
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
      setProgress({ episode: 0, total: 0 });
    }
  };

  const handleDownloadPdf = async () => {
    if (!script) return;
    setError("");
    setDownloading(true);
    const yieldToMain = () => new Promise((r) => setTimeout(r, 0));
    try {
      // pdf-lib's standard Courier (WinAnsi) cannot encode some full-width CJK punctuation.
      // First normalize common full-width punctuation, then strip any remaining non-WinAnsi chars.
      let sanitizedScript = script
        .replace(/\u3002/g, ".") // full-width period 。 -> .
        .replace(/\uFF0C/g, ",") // full-width comma ， -> ,
        .replace(/\uFF1A/g, ":") // full-width colon ： -> :
        .replace(/\uFF1B/g, ";") // full-width semicolon ； -> ;
        .replace(/\uFF01/g, "!") // full-width exclamation ！ -> !
        .replace(/\uFF1F/g, "?") // full-width question mark ？ -> ?
        .replace(/\u2018|\u2019|\uFF07/g, "'") // various single quotes -> '
        .replace(/\u201C|\u201D|\uFF02/g, '"'); // various double quotes -> "

      // Strip any remaining non-WinAnsi characters (e.g. CJK ideographs) to avoid encoding errors.
      sanitizedScript = sanitizedScript.replace(/[^\x00-\xFF]/g, "");

      const pdfDoc = await PDFDocument.create();
      const fontSize = 12;
      const lineHeight = 14;
      const courier = await pdfDoc.embedFont(StandardFonts.Courier);

      // Centered screenplay column: ~60–65% of page width, equal side margins.
      const PAGE_WIDTH = 612;
      const PAGE_HEIGHT = 792;
      const CONTENT_WIDTH = 324; // ~4.5"
      const CONTENT_LEFT = (PAGE_WIDTH - CONTENT_WIDTH) / 2; // centered
      const TOP_BOTTOM_MARGIN = 72;
      const DIALOGUE_INDENT = 36; // dialogue starts 0.5" right of content
      const DIALOGUE_WIDTH = CONTENT_WIDTH - DIALOGUE_INDENT; // dialogue column narrower
      const ACTION_INDENT = 18;

      const wrapToWidth = (font, text, size, maxWidth) => {
        const lines = [];
        const words = text.split(/\s+/);
        let line = "";
        for (const w of words) {
          const candidate = line ? line + " " + w : w;
          const ww = font.widthOfTextAtSize(candidate, size);
          if (ww <= maxWidth) {
            line = candidate;
          } else {
            if (line) lines.push(line);
            line = w;
          }
        }
        if (line) lines.push(line);
        return lines;
      };

      const isSceneHeading = (t) =>
        /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(t.trim()) ||
        /^EPISODE\s+\d+/i.test(t.trim());

      const isCharacterLine = (t) => {
        const s = t.trim();
        if (!s || s.length > 35) return false;
        if (/[.!?]/.test(s) && !/^[A-Z\s\-']+[.!?]?$/.test(s)) return false;
        const letters = s.replace(/[^A-Za-z]/g, "");
        return letters.length >= 2 && (s === s.toUpperCase() || letters.length >= Math.floor(s.length * 0.5));
      };

      const isParenthetical = (t) => /^\(.+\)$/.test(t.trim());

      let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      let y = PAGE_HEIGHT - TOP_BOTTOM_MARGIN;
      let pageNum = 1;

      const drawPageNumber = (p) => {
        const num = String(pageNum);
        const w = courier.widthOfTextAtSize(num, 10);
        p.drawText(num, { x: 36, y: PAGE_HEIGHT - 36, size: 10, font: courier });
        p.drawText(num, { x: PAGE_WIDTH - 36 - w, y: PAGE_HEIGHT - 36, size: 10, font: courier });
      };

      const ensureSpace = (neededLines) => {
        if (y - neededLines * lineHeight < TOP_BOTTOM_MARGIN) {
          drawPageNumber(page);
          page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
          pageNum += 1;
          y = PAGE_HEIGHT - TOP_BOTTOM_MARGIN;
        }
      };

      const lines = sanitizedScript.split(/\r?\n/);
      let prevType = "blank";
      let lineIndex = 0;

      for (const raw of lines) {
        lineIndex += 1;
        if (lineIndex % 150 === 0) await yieldToMain(); // avoid freezing on 60-episode scripts
        const text = raw.replace(/\s+$/g, "");
        const trimmed = text.trim();

        if (!trimmed) {
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

        const sceneLine = trimmed.toUpperCase();
        const displayText = lineType === "scene" ? sceneLine : trimmed;

        if (lineType === "scene" && prevType !== "blank") y -= lineHeight;
        if (lineType === "character" && prevType !== "blank" && prevType !== "scene") y -= lineHeight * 0.5;

        if (lineType === "scene") {
          const segs = wrapToWidth(courier, displayText, fontSize, CONTENT_WIDTH);
          ensureSpace(segs.length);
          for (const seg of segs) {
            page.drawText(seg, { x: CONTENT_LEFT, y, size: fontSize, font: courier });
            y -= lineHeight;
          }
        } else if (lineType === "character") {
          ensureSpace(1);
          const w = courier.widthOfTextAtSize(displayText.toUpperCase(), fontSize);
          const x = CONTENT_LEFT + (CONTENT_WIDTH - w) / 2;
          page.drawText(displayText.toUpperCase(), { x, y, size: fontSize, font: courier });
          y -= lineHeight;
        } else if (lineType === "parenthetical") {
          const segs = wrapToWidth(courier, displayText, fontSize - 1, CONTENT_WIDTH - 80);
          ensureSpace(segs.length);
          const parenX = CONTENT_LEFT + 60;
          for (const seg of segs) {
            page.drawText(seg, { x: parenX, y, size: fontSize - 1, font: courier });
            y -= lineHeight;
          }
        } else if (lineType === "dialogue") {
          const segs = wrapToWidth(courier, displayText, fontSize, DIALOGUE_WIDTH);
          ensureSpace(segs.length);
          for (const seg of segs) {
            page.drawText(seg, { x: CONTENT_LEFT + DIALOGUE_INDENT, y, size: fontSize, font: courier });
            y -= lineHeight;
          }
        } else {
          // Action: wrap to content width; split long blocks into 2–3 paragraphs
          const actionLines = wrapToWidth(
            courier,
            displayText,
            fontSize,
            CONTENT_WIDTH - ACTION_INDENT
          );
          const maxParagraphLines = 3;
          const paragraphs = [];
          for (let i = 0; i < actionLines.length; i += maxParagraphLines) {
            paragraphs.push(actionLines.slice(i, i + maxParagraphLines));
          }
          for (let p = 0; p < paragraphs.length; p++) {
            const para = paragraphs[p];
            ensureSpace(para.length + 1);
            for (const seg of para) {
              page.drawText(seg, {
                x: CONTENT_LEFT + ACTION_INDENT,
                y,
                size: fontSize,
                font: courier,
              });
              y -= lineHeight;
            }
            if (p < paragraphs.length - 1) y -= lineHeight * 0.5; // gap between paragraphs
          }
        }

        prevType = lineType;
      }

      drawPageNumber(page);

      let pdfBytes;
      try {
        pdfBytes = await pdfDoc.save();
      } catch (saveErr) {
        console.error(saveErr);
        throw new Error(
          "PDF too large or out of memory. Try a shorter script or fewer episodes."
        );
      }
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
        <h1 className="title">VERTICAL INFINITE · 垂直剧本工厂</h1>
      </header>

      <button
        type="button"
        className="btn-open"
        onClick={() => setModalOpen(true)}
      >
        Generate script / 生成剧本
      </button>

      {script && (
        <section className="script-output">
          <h2>Generated script / 已生成剧本</h2>
          <div className="script-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownloadPdf}
              disabled={downloading}
            >
              {downloading ? "Preparing PDF… / 正在生成 PDF…" : "Download PDF / 下载 PDF"}
            </button>
          </div>
          <pre className="script-text">{script}</pre>
        </section>
      )}

      <footer className="footer">
        <div className="ip-note">
          <p className="ip-note-en">
            Per our founding document, we will never claim ownership of the IP in scripts
            generated using this software. After generation, each script belongs to you, the user.
          </p>
          <p className="ip-note-zh">
            本平台创始文档明确：Vertical Infinite 不会主张对通过本软件生成之剧本内容的知识产权。每一份生成后的剧本均归生成该剧本的用户所有。
          </p>
        </div>
      </footer>

      {modalOpen && (
        <div className="modal-backdrop" onClick={() => !loading && setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">New script / 新剧本</h2>
            {loading && (
              <>
                {progress.total > 0 && (
                  <div className="episode-progress">
                    <div className="episode-progress-bar">
                      <div
                        className="episode-progress-fill"
                        style={{ width: `${(progress.episode / progress.total) * 100}%` }}
                      />
                    </div>
                    <p className="progress-text">
                      Generating episode {progress.episode} of {progress.total}
                    </p>
                  </div>
                )}
              </>
            )}
            <form onSubmit={handleSubmit}>
              <label className="field">
                <span>Genre / 类型</span>
                <select
                  value={genre}
                  onChange={(e) => {
                    setGenre(e.target.value);
                    setLogline("");
                  }}
                >
                  <option value="">— Select a genre / 请选择类型 —</option>
                  {GENRES.map((g) => {
                    const labelMap = {
                      Romance: "Romance / 浪漫爱情",
                      Drama: "Drama / 剧情情感",
                      Action: "Action / 动作悬疑",
                      Adventure: "Adventure / 冒险",
                      Crime: "Crime / 犯罪",
                      Horror: "Horror / 恐怖惊悚",
                      Fantasy: "Fantasy / 奇幻玄幻",
                      Monster: "Monster / 怪物灾难",
                      "Science Fiction": "Science Fiction / 科幻",
                      Superhero: "Superhero / 超级英雄",
                      Werewolf: "Werewolf / 狼人",
                    };
                    const label = labelMap[g] || g;
                    return (
                      <option key={g} value={g}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </label>
              {genre && (
                <label className="field summary-field">
                  <span>Summary / 摘要</span>
                  <p className="summary-hint">
                    Write a short premise or generate one for this genre. /
                    为本类型写一个简短故事梗概，或自动生成一个。
                  </p>
                  <textarea
                    value={logline}
                    onChange={(e) => setLogline(e.target.value)}
                    placeholder="A short premise or summary for your vertical (English only)… / 在此输入故事梗概（仅限英文）"
                    rows={4}
                    className={loglineOverLimit || loglineUnderMin ? "invalid" : ""}
                  />
                  <small className="word-count">
                    {wordCount} words (min {MIN_WORDS}, max 250) / 单词（至少 {MIN_WORDS}，最多 250）
                    {loglineOverLimit && " — over limit / 超出上限"}
                    {loglineUnderMin && " — too short / 太短"}
                  </small>
                  <div className="summary-suggestions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={handleSuggestRandomSummary}
                      disabled={loadingSuggestions}
                    >
                      {loadingSuggestions ? "…" : "Generate one / 随机生成一条"}
                    </button>
                  </div>
                </label>
              )}
              {error && <p className="error">Error / 错误: {error}</p>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => !loading && setModalOpen(false)}
                  disabled={loading}
                >
                  Cancel / 取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    loading ||
                    !genre ||
                    !logline.trim() ||
                    loglineUnderMin ||
                    loglineOverLimit
                  }
                >
                  {loading
                    ? progress.total > 0
                      ? `Episode ${progress.episode}/${progress.total} / 生成中`
                      : "Generating… / 正在生成…"
                    : "Generate / 生成"}
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
