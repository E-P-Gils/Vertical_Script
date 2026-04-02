import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildScreenplayPdfBytes,
  prepareChineseScriptLikePdfInput,
  prepareEnglishScriptLikePdfInput,
} from "./screenplayPdf.js";
import "./App.css";

// If you run the backend locally, keep VITE_API_BASE unset and calls go to Vite's `/api` proxy.
// If you want the hosted Render backend, set VITE_API_BASE to `https://vertical-script.onrender.com`.
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

/** List label: "{genre} Script generated on {date}" (genre omitted if empty). */
function formatMyScriptListTitle(genreName, createdAtIso) {
  const d = new Date(createdAtIso);
  const dateStr = Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const g = String(genreName || "").trim();
  const prefix = g ? `${g} ` : "";
  return `${prefix}Script generated on ${dateStr || "unknown date"}`;
}

function isServerBackedScriptId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));
}

function mapServerListRowToItem(row, prevItem) {
  const created =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at || prevItem?.createdAt || new Date().toISOString());
  return {
    id: row.id,
    createdAt: created,
    title: formatMyScriptListTitle(row.genre, created),
    genre: String(row.genre || prevItem?.genre || "").trim(),
    summary: String(row.summary || prevItem?.summary || "").trim(),
    englishText: prevItem?.englishText || "",
    chineseText: prevItem?.chineseText || "",
    generating: row.status === "generating",
    status: row.status || prevItem?.status,
    episodeDone: row.episode_done ?? prevItem?.episodeDone ?? 0,
    episodeTarget: row.episode_target ?? prevItem?.episodeTarget ?? 60,
    errorMessage: row.error_message ? String(row.error_message) : prevItem?.errorMessage || "",
  };
}

function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [translating, setTranslating] = useState(false);
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
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({
    episode: 0,
    total: 0,
    phase: "generating",
  });
  const [episodeCountRequested, setEpisodeCountRequested] = useState(60);
  const [script, setScript] = useState("");
  const [scriptZh, setScriptZh] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(null);

  // Auth (optional; backend enables it via AUTH_ENABLED=true)
  const [authToken, setAuthToken] = useState(() => {
    try {
      return localStorage.getItem("authToken");
    } catch {
      return null;
    }
  });
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authMode, setAuthMode] = useState("register"); // register | login

  const [page, setPage] = useState("home"); // home | generate | pricing | login | scripts
  const [myScripts, setMyScripts] = useState(() => {
    try {
      const raw = localStorage.getItem("myScripts");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.map((it, idx) => ({
            id: it?.id || `legacy_${idx}_${Date.now()}`,
            createdAt: it?.createdAt || new Date().toISOString(),
            title: formatMyScriptListTitle(it?.genre, it?.createdAt || new Date().toISOString()),
            genre: String(it?.genre || "").trim(),
            summary: String(it?.summary || "").trim(),
            englishText: String(it?.englishText || "").trim(),
            chineseText: String(it?.chineseText || "").trim(),
          }))
        : [];
    } catch {
      return [];
    }
  });
  const [activeScriptId, setActiveScriptId] = useState(null);
  const [deletePromptItem, setDeletePromptItem] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const pollIntervalRef = useRef(null);
  const activeScriptIdRef = useRef(activeScriptId);

  const clearBackgroundPoll = useCallback(() => {
    if (pollIntervalRef.current != null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const scheduleProgressPoll = useCallback(
    (scriptId) => {
      if (!authToken || !scriptId) return;
      clearBackgroundPoll();
      pollIntervalRef.current = -1;

      const applyPolledScript = (row) => {
        const id = row.id;
        const target = row.episode_target || 60;
        setMyScripts((prev) =>
          prev.map((it) =>
            it.id === id
              ? {
                  ...it,
                  title: formatMyScriptListTitle(row.genre || it.genre, row.created_at || it.createdAt),
                  genre: String(row.genre || it.genre || "").trim(),
                  summary: row.summary != null ? String(row.summary) : it.summary,
                  createdAt:
                    row.created_at != null
                      ? row.created_at instanceof Date
                        ? row.created_at.toISOString()
                        : String(row.created_at)
                      : it.createdAt,
                  englishText: row.english_text || "",
                  chineseText: row.chinese_text || "",
                  generating: row.status === "generating",
                  status: row.status,
                  episodeDone: row.episode_done ?? 0,
                  episodeTarget: row.episode_target ?? it.episodeTarget ?? target,
                  errorMessage: row.error_message ? String(row.error_message) : "",
                }
              : it
          )
        );
        if (activeScriptIdRef.current === id) {
          setScript(row.english_text || "");
          setScriptZh(row.chinese_text || "");
          if (row.status === "generating") {
            setProgress({
              episode: row.episode_done || 0,
              total: row.episode_target || target,
              phase: "generating",
            });
          }
        }
        return row.status;
      };

      const pollOnce = async () => {
        try {
          const pr = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (!pr.ok) return;
          const pd = await pr.json();
          const row = pd.script;
          if (!row) return;
          const st = applyPolledScript(row);
          const targetEp = row.episode_target || 60;
          const doneEp = row.episode_done ?? 0;
          if (st === "failed") {
            clearBackgroundPoll();
            setProgress({ episode: 0, total: 0, phase: "generating" });
            setError(row.error_message || "Generation failed");
          } else if (st === "complete" && doneEp >= targetEp) {
            clearBackgroundPoll();
            setProgress({ episode: 0, total: 0, phase: "generating" });
            setModalOpen(false);
          } else if (st === "complete" && doneEp < targetEp) {
            clearBackgroundPoll();
            setProgress({ episode: 0, total: 0, phase: "generating" });
            setError(
              `Generation finished on the server with only ${doneEp} of ${targetEp} episodes saved. Open My Scripts to inspect, or delete and start again. / 服务器仅保存了 ${doneEp}/${targetEp} 集。请在「我的剧本」中查看或删除后重试。`
            );
          }
        } catch {
          /* ignore */
        }
      };

      void (async () => {
        await pollOnce();
        if (pollIntervalRef.current === -1) {
          pollIntervalRef.current = setInterval(pollOnce, 4000);
        }
      })();
    },
    [authToken, clearBackgroundPoll]
  );

  useEffect(() => {
    activeScriptIdRef.current = activeScriptId;
  }, [activeScriptId]);

  useEffect(() => {
    try {
      localStorage.setItem("myScripts", JSON.stringify(myScripts));
    } catch {}
  }, [myScripts]);

  useEffect(() => {
    if (authToken) setError("");
  }, [authToken]);

  useEffect(() => {
    return () => clearBackgroundPoll();
  }, []);

  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/scripts`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!r.ok || cancelled) return;
        const data = await r.json();
        const rows = Array.isArray(data.scripts) ? data.scripts : [];
        setMyScripts((prev) => {
          const prevById = new Map(prev.map((x) => [x.id, x]));
          const serverIds = new Set(rows.map((row) => row.id));
          const fromServer = rows.map((row) => mapServerListRowToItem(row, prevById.get(row.id)));
          const localOnly = prev.filter((p) => !serverIds.has(p.id));
          return [...fromServer, ...localOnly].slice(0, 50);
        });
        const topGen = rows.find((r) => r.status === "generating");
        if (topGen && !cancelled) scheduleProgressPoll(topGen.id);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken, scheduleProgressPoll]);

  const authHeaders = authToken
    ? {
        Authorization: `Bearer ${authToken}`,
      }
    : {};

  const persistGeneratedScript = (englishText, genreName, summaryText) => {
    const t = String(englishText || "").trim();
    if (!t) return;
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const summary = String(summaryText || "").trim();
    const createdAt = new Date().toISOString();
    const item = {
      id,
      createdAt,
      title: formatMyScriptListTitle(genreName || genre || "", createdAt),
      genre: genreName || genre || "",
      summary,
      englishText: t,
      chineseText: "",
    };
    setMyScripts((prev) => [item, ...prev].slice(0, 30));
    setActiveScriptId(id);
  };

  const updateActiveScriptChinese = (chText) => {
    if (!activeScriptId) return;
    const t = String(chText || "").trim();
    if (!t) return;
    setMyScripts((prev) =>
      prev.map((it) => (it.id === activeScriptId ? { ...it, chineseText: t } : it))
    );
  };

  const loadScriptItem = (item) => {
    if (!item) return;
    setScript(item.englishText || "");
    setScriptZh(item.chineseText || "");
    setGenre(item.genre || "");
    setActiveScriptId(item.id);
    setPage("generate");
    setModalOpen(false);
  };

  const confirmDeleteScript = async () => {
    const it = deletePromptItem;
    if (!it) return;
    setDeletingId(it.id);
    setError("");
    try {
      if (authToken && isServerBackedScriptId(it.id)) {
        const r = await fetch(`${API_BASE}/scripts/${encodeURIComponent(it.id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || "Delete failed");
        }
      }
      setMyScripts((prev) => prev.filter((x) => x.id !== it.id));
      if (it.status === "generating" || it.generating) clearBackgroundPoll();
      if (activeScriptId === it.id) {
        setActiveScriptId(null);
        setScript("");
        setScriptZh("");
      }
      setDeletePromptItem(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const emailOk = (() => {
        const v = String(authEmail || "").trim();
        // Require a "real-looking" domain: user@domain.tld
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
      })();
      if (!emailOk) {
        throw new Error("Please enter a valid email address with a real domain. / 请输入有效的邮箱地址（需包含域名）。");
      }

      const password = String(authPassword || "");
      const confirm = String(authConfirmPassword || "");
      if (password !== confirm) {
        throw new Error("Passwords do not match. / 两次密码不一致。");
      }

      const passwordOk = password.length >= 8 &&
        /[A-Za-z]/.test(password) &&
        /[0-9]/.test(password) &&
        /[^A-Za-z0-9]/.test(password);
      if (!passwordOk) {
        throw new Error(
          "Password must be at least 8 characters and include letters, numbers, and a special character. / 密码至少8位，并包含字母、数字和特殊字符。"
        );
      }

      if (!password) {
        throw new Error("Password is required. / 请输入密码。");
      }

      const r = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Registration failed");
      // Auto-login after successful registration.
      const loginR = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const loginData = await loginR.json().catch(() => ({}));
      if (!loginR.ok) throw new Error(loginData.error || "Login failed");
      if (!loginData?.token) throw new Error("Login failed: missing token");

      setAuthToken(loginData.token);
      try {
        localStorage.setItem("authToken", loginData.token);
      } catch {}

      setAuthConfirmPassword("");
      setError("");
      setPage("generate");
      setAuthMode("login");
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.includes("password must be at least 8 characters")) {
        setError("Password must be at least 8 characters. / 密码至少8位。");
      } else if (msg.includes("email and password are required")) {
        setError("Email and password are required. / 需要邮箱与密码。");
      } else if (msg.includes("auth is not enabled")) {
        setError("Registration is not enabled on this server. / 此服务器尚未启用注册。");
      } else if (msg.includes("user already exists")) {
        setError("This account already exists. Please use the login flow. / 该账号已存在，请走登录流程。");
      } else if (msg) {
        setError(msg);
      } else {
        setError("Registration failed. / 注册失败。");
      }
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const email = String(authEmail || "").trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
      if (!emailOk) {
        throw new Error("Please enter a valid email address with a real domain. / 请输入有效的邮箱地址（需包含域名）。");
      }

      const r = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Login failed");
      if (!data?.token) throw new Error("Login failed: missing token");
      setAuthToken(data.token);
      try {
        localStorage.setItem("authToken", data.token);
      } catch {}
      setAuthMode("login");
      setError("");
      setPage("generate");
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.includes("invalid credentials")) {
        setError("No registered account found (or wrong password). Please register. / 未注册账号或密码错误，请先注册。");
      } else {
        setError(err?.message || "Login failed");
      }
    }
  };

  const handleLogout = () => {
    clearBackgroundPoll();
    setAuthToken(null);
    try {
      localStorage.removeItem("authToken");
    } catch {}
    setPage("home");
    setModalOpen(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!genre) return;
    setError("");
    setScript("");
    setScriptZh("");
    const episodeCount = 60;
    setEpisodeCountRequested(episodeCount);
    setProgress({ episode: 0, total: episodeCount, phase: "generating" });
    setLoading(true);
    clearBackgroundPoll();

    const bodyPayload = {
      genre,
      language: "EN",
      episodeCount,
      title: "Generated Script",
      translateToChinese: false,
    };

    if (authToken) {
      let bgRes;
      let bgData = {};
      try {
        bgRes = await fetch(`${API_BASE}/generate/background`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(bodyPayload),
        });
        bgData = await bgRes.json().catch(() => ({}));
      } catch {
        bgRes = { ok: false, status: 0 };
      }

      if (bgRes.ok && bgRes.status === 202 && bgData.scriptId) {
        const scriptId = bgData.scriptId;
        const summary = String(bgData.summary || "").trim();
        const createdAt = new Date().toISOString();
        const newItem = {
          id: scriptId,
          createdAt,
          title: formatMyScriptListTitle(genre, createdAt),
          genre,
          summary,
          englishText: "",
          chineseText: "",
          generating: true,
          status: "generating",
          episodeDone: 0,
          episodeTarget: episodeCount,
          errorMessage: "",
        };
        setMyScripts((prev) => {
          const rest = prev.filter((x) => x.id !== scriptId);
          return [newItem, ...rest].slice(0, 50);
        });
        setActiveScriptId(scriptId);
        setLoading(false);
        scheduleProgressPoll(scriptId);
        setModalOpen(false);
        return;
      }

      const errMsg = String(bgData.error || "");
      const tryStreamFallback =
        bgRes.status === 503 && /Background generation requires/i.test(errMsg);
      if (!tryStreamFallback) {
        setLoading(false);
        setProgress({ episode: 0, total: 0, phase: "generating" });
        if (bgRes.status === 401 || bgRes.status === 403) {
          setError("Please register and verify your email, then log in again.");
        } else {
          setError(errMsg || "Generation failed");
        }
        return;
      }
    }

    let streamSummaryForPersist = "";
    try {
      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(bodyPayload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          throw new Error("Please register and verify your email, then log in again.");
        }
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
        } else if (data.type === "preset_summary" && data.summary) {
          streamSummaryForPersist = String(data.summary).trim();
        } else if (data.type === "translation_progress") {
          setProgress({
            episode: data.episode || 0,
            total: data.total || 60,
            phase: "translating",
          });
        } else if (data.type === "episode") {
          const block = data.episode != null && data.text != null
            ? (() => {
                const t = String(data.text || "").trim();
                return /^EPISODE\s+\d+/i.test(t) ? t : `EPISODE ${data.episode}\n\n${t}`;
              })()
            : "";
          if (block) fullScript += (fullScript ? "\n\n" : "") + block;
          setScript(fullScript);
        } else if (data.type === "episode_zh") {
          const block = data.episode != null && data.text != null
            ? (() => {
                const t = String(data.text || "").trim();
                return /^EPISODE\s+\d+/i.test(t) ? t : `EPISODE ${data.episode}\n\n${t}`;
              })()
            : "";
          if (block) fullScriptZh += (fullScriptZh ? "\n\n" : "") + block;
          setScriptZh(fullScriptZh);
        } else if (data.type === "error") {
          setError(data.message || "Generation error");
        } else if (data.type === "done") {
          persistGeneratedScript(fullScript, genre, streamSummaryForPersist);
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

  const handleTranslateToChinese = async () => {
    if (!script) return false;
    if (!authToken) {
      setError("Please log in or register first to translate and download Chinese PDF.");
      setPage("login");
      return false;
    }
    setError("");
    setScriptZh("");
    setProgress({ episode: 0, total: 0, phase: "translating" });
    setTranslating(true);

    try {
      let fullScriptZhLocal = "";

      const lines = script.split(/\r?\n/);
      const starts = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trim().match(/^EPISODE\s+(\d+)\s*$/i);
        if (m) starts.push({ episode: parseInt(m[1], 10), idx: i });
      }

      if (!starts.length) {
        setError("Could not parse EPISODE headings from English script.");
        return false;
      }

      // Some drafts sometimes include stray "EPISODE 61+" headings.
      // We only translate up to what the user requested.
      const filtered = starts
        .filter((s) => s.episode <= episodeCountRequested)
        .sort((a, b) => a.idx - b.idx);
      const seen = new Set();
      const unique = [];
      for (const s of filtered) {
        if (seen.has(s.episode)) continue;
        seen.add(s.episode);
        unique.push(s);
      }

      const totalEpisodes = unique.length;
      setProgress({ episode: 0, total: totalEpisodes, phase: "translating" });

      for (let si = 0; si < unique.length; si++) {
        const cur = unique[si];
        const next =
          si + 1 < unique.length ? unique[si + 1].idx : lines.length;
        const chunkText = lines.slice(cur.idx, next).join("\n");

        // Update progress as soon as we start this episode.
        setProgress({
          episode: si + 1,
          total: totalEpisodes,
          phase: "translating",
        });

        const res = await fetch(`${API_BASE}/translate-to-chinese`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({ text: chunkText }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 401 || res.status === 403) {
            throw new Error("Please log in again (email must be verified).");
          }
          throw new Error(data.error || `Translation failed (HTTP ${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let episodeZh = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const ndjsonLines = buffer.split("\n");
          buffer = ndjsonLines.pop() || "";

          for (const line of ndjsonLines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const data = JSON.parse(trimmed);
              if (data.type === "episode_zh" && data.episode === cur.episode) {
                episodeZh = data.text || "";
              } else if (data.type === "translation_error") {
                throw new Error(data.message || "Chinese translation failed");
              }
            } catch (_) {}
          }
        }

        if (!episodeZh.trim()) {
          throw new Error(`Episode ${cur.episode} translation produced no text.`);
        }

        const block = /^EPISODE\s+\d+/i.test(String(episodeZh || "").trim())
          ? String(episodeZh || "").trim()
          : `EPISODE ${cur.episode}\n\n${episodeZh}`;
        fullScriptZhLocal += (fullScriptZhLocal ? "\n\n" : "") + block;
        setScriptZh(fullScriptZhLocal);
      }

      updateActiveScriptChinese(fullScriptZhLocal);
      return !!fullScriptZhLocal.trim();
    } catch (err) {
      console.error(err);
      setError(err.message || "Something went wrong during translation");
      return false;
    } finally {
      setTranslating(false);
      setProgress({ episode: 0, total: 0, phase: "generating" });
    }
  };

  const handleDownloadPdfZh = async () => {
    if (!authToken) {
      setError("Please log in or register first to download Chinese PDF.");
      setPage("login");
      return;
    }
    setError("");
    try {
      if (!scriptZh) {
        const ok = await handleTranslateToChinese();
        if (!ok) return;
      }

      const hasHan = /[\u3400-\u9FFF]/.test(scriptZh || "");
      if (!hasHan) {
        throw new Error(
          "Chinese PDF not generated: translation output appears empty or missing Chinese characters."
        );
      }

      setDownloading("zh");
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
        <p className="title-sub">Script Generator · 剧本生成器</p>
      </header>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <button
          type="button"
          className={page === "home" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("home")}
          style={{ borderRadius: 6 }}
        >
          Home / 首页
        </button>
        <button
          type="button"
          className={page === "generate" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("generate")}
          style={{ borderRadius: 6 }}
        >
          Generate / 生成
        </button>
        <button
          type="button"
          className={page === "pricing" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("pricing")}
          style={{ borderRadius: 6 }}
        >
          Pricing / 定价
        </button>
        <button
          type="button"
          className={page === "login" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("login")}
          style={{ borderRadius: 6 }}
        >
          Login / 登录
        </button>
        <button
          type="button"
          className={page === "scripts" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => {
            if (!authToken) {
              setError("Please log in or register first.");
              setPage("login");
              return;
            }
            setPage("scripts");
          }}
          style={{ borderRadius: 6 }}
        >
          My Scripts / 我的剧本
        </button>
      </div>

      {page === "home" && (
        <section className="script-output page-panel page-panel-home" style={{ maxWidth: 720 }}>
          <div
            style={{
              textAlign: "center",
              padding: "0.75rem 0",
              fontWeight: 800,
              fontSize: "1.6rem",
              lineHeight: 1.25,
            }}
          >
            <div style={{ color: "var(--blood-pale)" }}>
              GENERATE A FULL PRODUCTION-READY 60 EPISODE VERTICAL SCRIPT IN UNDER 10 MINUTES
            </div>
            <div style={{ marginTop: "0.5rem", opacity: 0.95 }}>
              在不到 10 分钟内生成完整、可投入制作的 60 集垂直剧本
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPage("generate")}
            >
              Get Started / 开始
            </button>
          </div>
        </section>
      )}

      {page === "pricing" && (
        <section className="script-output pricing-panel" style={{ maxWidth: 980 }}>
          <h2 className="pricing-title">PRICING / 定价</h2>
          <p
            className="script-output-hint pricing-hint"
            style={{ marginTop: "-0.25rem" }}
          >
            Choose a plan. All plans include full 60-episode vertical script generation. / 选择一个方案。所有方案均包含完整60集垂直剧本生成。
          </p>
          <div className="pricing-grid">
            <article className="pricing-card">
              <h3 className="pricing-name">Free / 免费</h3>
              <p className="pricing-rate">
                $30 <span>per script generation (pay as you go) / 每次剧本生成（按需付费）</span>
              </p>
              <ul className="pricing-features">
                <li>1 free generation / 1次免费生成</li>
                <li>30 dollars per script generation / 每次剧本生成 30 美元</li>
                <li>Includes full 60-episode vertical script generation / 包含完整60集垂直剧本生成</li>
              </ul>
            </article>

            <article className="pricing-card">
              <h3 className="pricing-name">Starter / 入门</h3>
              <p className="pricing-rate">
                $99/mo <span>or $1,000/year / 或 $1,000/年</span>
              </p>
              <ul className="pricing-features">
                <li>$20 per script generation / 每次剧本生成 $20</li>
                <li>3 free monthly generations / 每月3次免费生成</li>
                <li>Includes full 60-episode vertical script generation / 包含完整60集垂直剧本生成</li>
              </ul>
            </article>

            <article className="pricing-card">
              <h3 className="pricing-name">Professional / 专业</h3>
              <p className="pricing-rate">
                $499/mo <span>or $5,000/year / 或 $5,000/年</span>
              </p>
              <ul className="pricing-features">
                <li>$12 per script generation / 每次剧本生成 $12</li>
                <li>6 free monthly generations / 每月6次免费生成</li>
                <li>
                  Access to high-performing “Science Fiction” and “Fantasy” genres / 可使用高表现的“科幻”和“奇幻”题材
                </li>
                <li>English and Chinese script support / 支持英文与简体中文剧本</li>
                <li>Includes full 60-episode vertical script generation / 包含完整60集垂直剧本生成</li>
              </ul>
            </article>

            <article className="pricing-card">
              <h3 className="pricing-name">Business / 商务</h3>
              <p className="pricing-rate">
                $999/mo <span>or $10,000/year / 或 $10,000/年</span>
              </p>
              <ul className="pricing-features">
                <li>$5 per script generation / 每次剧本生成 $5</li>
                <li>12 free monthly generations / 每月12次免费生成</li>
                <li>Priority support / 优先支持</li>
                <li>
                  Access to high-performing “Science Fiction”, “Fantasy”, “Superhero”, and “Horror” genres / 可使用高表现的“科幻”、“奇幻”、“超级英雄”和“恐怖”题材
                </li>
                <li>English and Chinese script support / 支持英文与简体中文剧本</li>
                <li>Includes full 60-episode vertical script generation / 包含完整60集垂直剧本生成</li>
              </ul>
            </article>
          </div>
        </section>
      )}

      {page === "scripts" && (
        <section className="script-output" style={{ maxWidth: 720 }}>
          <h2 style={{ marginTop: 0 }}>My Scripts / 我的剧本</h2>
          {!authToken ? (
            <p style={{ opacity: 0.9 }}>
              Please log in to access your saved scripts.
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: "0.75rem" }}
                onClick={() => setPage("login")}
              >
                Go to Login
              </button>
            </p>
          ) : myScripts.length === 0 ? (
            <p style={{ opacity: 0.9 }}>
              No scripts saved yet. Generate your first one. / 暂无已保存剧本。先生成你的第一份剧本吧。
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {myScripts.map((it) => {
                const created = new Date(it.createdAt);
                const isActive = it.id === activeScriptId;
                const listTitle = formatMyScriptListTitle(it.genre, it.createdAt);
                return (
                  <div key={it.id} style={{ border: "1px solid var(--steel-light)", borderRadius: 8, padding: "0.75rem", background: "rgba(26,26,29,0.35)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                        <div className="script-card-head">
                          <div style={{ fontWeight: 700 }}>{listTitle}</div>
                          <button
                            type="button"
                            className="btn-script-delete"
                            aria-label="Delete script"
                            disabled={deletingId != null}
                            onClick={() => setDeletePromptItem(it)}
                          >
                            ×
                          </button>
                        </div>
                        <div style={{ opacity: 0.95, fontSize: "0.9rem", marginTop: "0.1rem" }}>
                          Genre / 类型: {it.genre || "N/A"}
                        </div>
                        <div style={{ opacity: 0.85, fontSize: "0.85rem", marginTop: "0.1rem" }}>
                          Date / 生成时间: {created.toLocaleString()}
                        </div>
                        {it.summary ? (
                          <div style={{ opacity: 0.88, fontSize: "0.85rem", marginTop: "0.35rem", maxWidth: 560 }}>
                            Summary / 摘要: {it.summary}
                          </div>
                        ) : null}
                        {it.status === "generating" || it.generating ? (
                          <div style={{ opacity: 0.9, fontSize: "0.85rem", marginTop: "0.35rem" }}>
                            Generating in background / 后台生成中… {it.episodeDone ?? 0}/{it.episodeTarget ?? 60}
                          </div>
                        ) : null}
                        {it.status === "failed" && it.errorMessage ? (
                          <div className="error" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
                            {it.errorMessage}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ opacity: isActive ? 1 : 0.75 }}>
                        {it.status === "generating" || it.generating
                          ? "…"
                          : it.chineseText
                            ? "EN + ZH"
                            : "EN only"}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                      <button type="button" className="btn btn-secondary" onClick={() => loadScriptItem(it)}>
                        Load
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={async () => {
                          try {
                            setError("");
                            setDownloading("en");
                            const pdfBytes = await buildScreenplayPdfBytes(it.englishText, "en");
                            triggerPdfDownload(pdfBytes, "vertical_script_en.pdf");
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Download failed");
                          } finally {
                            setDownloading(null);
                          }
                        }}
                        disabled={downloading !== null || !it.englishText?.trim()}
                      >
                        Download EN PDF
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!it.chineseText || downloading !== null}
                        onClick={async () => {
                          try {
                            setError("");
                            setDownloading("zh");
                            const pdfBytes = await buildScreenplayPdfBytes(it.chineseText, "zh");
                            triggerPdfDownload(pdfBytes, "vertical_script_zh.pdf");
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Download failed");
                          } finally {
                            setDownloading(null);
                          }
                        }}
                      >
                        Download ZH PDF
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {page === "login" && (
        <section className="script-output page-panel page-panel-login" style={{ maxWidth: 600, marginTop: 0 }}>
          <div className="auth-card-inner">
            {!authToken && (
              <p className="auth-need-login">
                You need to login/register to start generating scripts. / 为开始生成剧本，你需要先登录/注册。
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <h2 style={{ marginTop: 0 }}>Account / 账号</h2>

            {authToken ? (
              <div>
                <p style={{ marginTop: 0, marginBottom: "0.75rem", opacity: 0.9 }}>
                  Logged in. You can generate scripts. / 已登录。你可以开始生成剧本。
                </p>
                <button type="button" className="btn btn-secondary" onClick={handleLogout}>
                  Log out / 退出
                </button>
              </div>
            ) : (
              <div>
            {authMode === "register" && (
              <>
              <form onSubmit={handleRegister} className="auth-form">
                <label className="field">
                  <span>Email / 邮箱</span>
                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    type="email"
                    required
                  />
                </label>
                <label className="field">
                  <span>Password / 密码</span>
                  <input
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    type="text"
                    required
                    minLength={8}
                  />
                </label>
                <label className="field">
                  <span>Confirm Password / 确认密码</span>
                  <input
                    value={authConfirmPassword}
                    onChange={(e) => setAuthConfirmPassword(e.target.value)}
                    type="text"
                    required
                    minLength={8}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!authEmail || !authPassword || !authConfirmPassword}
                >
                  Register / 注册
                </button>
              </form>
              <div className="auth-toggle">
                <span className="auth-toggle-text">Already have an account? Log in / 已有账号？登录</span>
                <button
                  type="button"
                  className="btn btn-secondary auth-toggle-btn"
                  onClick={() => {
                    setAuthMode("login");
                    setAuthCode("");
                    setAuthConfirmPassword("");
                  }}
                >
                  Log in / 登录
                </button>
              </div>
              </>
            )}

            {/* Confirmation code is handled in a modal. */}

            {authMode === "login" && (
              <form onSubmit={handleLogin} className="auth-form">
                <label className="field">
                  <span>Email / 邮箱</span>
                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    type="email"
                    required
                  />
                </label>
                <label className="field">
                  <span>Password / 密码</span>
                  <input
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    type="password"
                    required
                    minLength={8}
                  />
                </label>
                <button type="submit" className="btn btn-primary" disabled={!authEmail || !authPassword}>
                  Log in / 登录
                </button>
                <div className="auth-toggle">
                  <span className="auth-toggle-text">New here? Register / 新用户？注册</span>
                  <button
                    type="button"
                    className="btn btn-secondary auth-toggle-btn"
                    onClick={() => {
                      setAuthMode("register");
                      setAuthCode("");
                      setAuthConfirmPassword("");
                    }}
                  >
                    Register / 注册
                  </button>
                </div>
              </form>
            )}
          </div>
            )}
          </div>
        </section>
      )}

      {page === "generate" && (
        <div
          style={{
            width: "100%",
            maxWidth: 720,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <div className="generate-page-hint">
            <p className="generate-page-hint-en">
              Once your generation begins it will proceed on the backend. Please keep the browser tab open. If
              you accidentally close the tab you can reopen the page and resume generating by visiting{" "}
              <strong>My Scripts</strong> and reloading the page. Keep the browser tab open while translating the
              script to Chinese. It takes around 50 minutes to generate a script, and 10 minutes to translate it.
              You can generate multiple scripts at a time.
            </p>
            <p className="generate-page-hint-zh">
              生成开始后会由服务器在后台继续执行。请尽量保持浏览器标签页打开。若不慎关闭标签页，可重新打开页面，进入
              <strong>我的剧本</strong>
              并刷新页面以继续查看生成进度。将剧本翻译为简体中文时，也请保持标签页打开。完整生成一部剧本大约需要 50
              分钟，翻译约需 10 分钟。您可以同时生成多部剧本。
            </p>
          </div>
          <button
            type="button"
            className="btn-open"
            onClick={() => {
              if (!authToken) {
                setError("Please log in or register to generate a script.");
                setPage("login");
                return;
              }
              setModalOpen(true);
            }}
          >
            Generate script / 生成剧本
          </button>
        </div>
      )}

      {page === "generate" && script && (
        <section className="script-output">
          <h2>Generated script / 已生成剧本</h2>
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
              disabled={!script || translating || downloading !== null}
            >
              {downloading === "zh"
                ? "Preparing Chinese PDF…"
                : "Download Chinese PDF / 下载中文 PDF"}
            </button>
          </div>

          {translating && progress.total > 0 && (
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
                Translating episode {progress.episode} of {progress.total} / 翻译第 {progress.episode} 集
              </p>
            </div>
          )}
          <pre className="script-text">
            {prepareEnglishScriptLikePdfInput(script)}
          </pre>
          {scriptZh ? (
            <>
              <h3 className="script-zh-title">Simplified Chinese / 简体中文</h3>
              <pre className="script-text script-text-zh">
                {prepareChineseScriptLikePdfInput(scriptZh)}
              </pre>
            </>
          ) : null}
        </section>
      )}

      <footer className="footer">
        <div className="vpn-notice">
          <p className="vpn-notice-en">A VPN is required to access this service in China.</p>
          <p className="vpn-notice-zh">在中国境内访问本服务需要使用 VPN。</p>
        </div>
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

      {deletePromptItem && (
        <div
          className="modal-backdrop"
          onClick={() => deletingId == null && setDeletePromptItem(null)}
        >
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Delete script / 删除剧本</h2>
            <p style={{ marginTop: 0, lineHeight: 1.5 }}>
              Are you sure you want to delete this script?
            </p>
            <p style={{ marginTop: "0.5rem", lineHeight: 1.5, opacity: 0.95 }}>
              您确定要删除此剧本吗？
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deletingId != null}
                onClick={() => setDeletePromptItem(null)}
              >
                Cancel / 取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deletingId != null}
                onClick={() => void confirmDeleteScript()}
              >
                Delete / 删除
              </button>
            </div>
          </div>
        </div>
      )}

      {page === "generate" && modalOpen && (
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
                <p className="summary-hint" style={{ marginTop: "0.5rem" }}>
                  A full 60-episode vertical script will be generated in your chosen genre. /
                  将根据您所选类型生成完整的 60 集垂直剧本。
                </p>
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
                  disabled={loading || !genre}
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
