import { useState } from "react";
import { buildScreenplayPdfBytes } from "./screenplayPdf.js";
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
  const [progress, setProgress] = useState({
    episode: 0,
    total: 0,
    phase: "generating",
  });
  const [script, setScript] = useState("");
  const [scriptZh, setScriptZh] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(null);
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
    setScriptZh("");
    setProgress({ episode: 0, total: 60, phase: "generating" });
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
          translateToChinese: true,
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
      let fullScriptZh = "";
      const applyNdjsonLine = (trimmed) => {
        if (!trimmed) return;
        const data = JSON.parse(trimmed);
        if (data.type === "progress") {
          setProgress({
            episode: data.episode || 0,
            total: data.total || 60,
            phase: "generating",
          });
        } else if (data.type === "translation_progress") {
          setProgress({
            episode: data.episode || 0,
            total: data.total || 60,
            phase: "translating",
          });
        } else if (data.type === "episode") {
          const block =
            data.episode != null && data.text != null
              ? `EPISODE ${data.episode}\n\n${data.text}`
              : "";
          if (block) fullScript += (fullScript ? "\n\n" : "") + block;
          setScript(fullScript);
        } else if (data.type === "episode_zh") {
          const block =
            data.episode != null && data.text != null
              ? `EPISODE ${data.episode}\n\n${data.text}`
              : "";
          if (block) fullScriptZh += (fullScriptZh ? "\n\n" : "") + block;
          setScriptZh(fullScriptZh);
        } else if (data.type === "error") {
          setError(data.message || "Generation error");
        } else if (data.type === "done") {
          setModalOpen(false);
        }
      };
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
            applyNdjsonLine(trimmed);
          } catch (_) {}
        }
      }
      if (buffer.trim()) {
        try {
          applyNdjsonLine(buffer.trim());
        } catch (_) {}
      }
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
      setProgress({ episode: 0, total: 0, phase: "generating" });
    }
  };

  const triggerPdfDownload = (bytes, filename) => {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadPdfEn = async () => {
    if (!script) return;
    setError("");
    setDownloading("en");
    try {
      const pdfBytes = await buildScreenplayPdfBytes(script, "en");
      triggerPdfDownload(pdfBytes, "vertical_script_en.pdf");
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Failed to generate English PDF"
      );
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadPdfZh = async () => {
    if (!scriptZh) return;
    setError("");
    setDownloading("zh");
    try {
      const pdfBytes = await buildScreenplayPdfBytes(scriptZh, "zh");
      triggerPdfDownload(pdfBytes, "vertical_script_zh.pdf");
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Failed to generate Chinese PDF"
      );
    } finally {
      setDownloading(null);
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
          <p className="script-output-hint">
            English is written by the story model; Simplified Chinese is a separate translation pass (same API key, not the fine-tuned writer).
            英文由剧本模型生成；简体中文为后续翻译（同一 API，非微调写作模型）。
          </p>
          <div className="script-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownloadPdfEn}
              disabled={downloading !== null}
            >
              {downloading === "en"
                ? "Preparing English PDF…"
                : "Download English PDF / 下载英文 PDF"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDownloadPdfZh}
              disabled={!scriptZh || downloading !== null}
            >
              {downloading === "zh"
                ? "Preparing Chinese PDF (font may download once)…"
                : "Download Chinese PDF / 下载中文 PDF"}
            </button>
          </div>
          <pre className="script-text">{script}</pre>
          {scriptZh ? (
            <>
              <h3 className="script-zh-title">Simplified Chinese / 简体中文</h3>
              <pre className="script-text script-text-zh">{scriptZh}</pre>
            </>
          ) : null}
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
                        style={{
                          width: `${(progress.episode / progress.total) * 100}%`,
                        }}
                      />
                    </div>
                    <p className="progress-text">
                      {progress.phase === "translating"
                        ? `Translating episode ${progress.episode} of ${progress.total} / 翻译第 ${progress.episode} 集`
                        : progress.episode > 0
                          ? `Generating episode ${progress.episode} of ${progress.total} / 生成第 ${progress.episode} 集`
                          : "Starting… / 启动中…"}
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
