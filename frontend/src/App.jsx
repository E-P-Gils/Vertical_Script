import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildScreenplayPdfBytes,
  prepareChineseScriptLikePdfInput,
  prepareEnglishScriptForDisplay,
  prepareEnglishScriptLikePdfInput,
} from "./screenplayPdf.js";
import SecretOwnerTools from "./SecretOwnerTools.jsx";
import "./App.css";

// If you run the backend locally, keep VITE_API_BASE unset and calls go to Vite's `/api` proxy.
// If you want the hosted Render backend, set VITE_API_BASE to `https://vertical-script.onrender.com`.
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const SCRIPT_CREDITS_REQUIRED_MSG =
  "Purchase credits to generate a script! / 购买剧本额度后方可生成剧本！";

/** Shown only in nav for this account; must match server OWNER_OPS_EMAIL. */
const OWNER_OPS_TAB_EMAIL = (
  import.meta.env.VITE_OWNER_OPS_EMAIL || "sculptoid11@gmail.com"
)
  .trim()
  .toLowerCase();

/** Must match backend `scriptsStore.js` MAX_CONCURRENT_GENERATIONS_PER_USER. */
const MAX_CONCURRENT_GENERATIONS = 5;

const CONCURRENT_GENERATIONS_CAP_MSG = `You already have ${MAX_CONCURRENT_GENERATIONS} scripts generating. Wait for one to finish or check My Scripts. / 您已有 ${MAX_CONCURRENT_GENERATIONS} 个剧本正在生成，请等待完成或在「我的剧本」中查看。`;

/**
 * List route omits english_text/chinese_text. Without this, only the actively polled script
 * gets bodies merged — concurrent background jobs stay empty or stuck on stale partial text.
 */
async function attachFullTextToCompleteRows(rows, fetchDetail, maxScripts = 10) {
  if (!Array.isArray(rows) || typeof fetchDetail !== "function") return rows;
  const complete = rows.filter((r) => r && r.status === "complete").slice(0, maxScripts);
  if (!complete.length) return rows;
  const results = await Promise.all(complete.map((r) => fetchDetail(r.id)));
  const byId = new Map();
  complete.forEach((r, i) => {
    const d = results[i];
    if (d) byId.set(r.id, d);
  });
  if (!byId.size) return rows;
  return rows.map((r) => {
    const d = byId.get(r.id);
    if (!d) return r;
    return {
      ...r,
      english_text: d.english_text,
      chinese_text: d.chinese_text,
      status: d.status ?? r.status,
      episode_done: d.episode_done ?? r.episode_done,
      episode_target: d.episode_target ?? r.episode_target,
      error_message: d.error_message ?? r.error_message,
      genre: d.genre ?? r.genre,
      summary: d.summary ?? r.summary,
    };
  });
}

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
    // Always prefer server-backed text when present; fall back only if row fields are empty.
    englishText: row.english_text != null && row.english_text !== "" ? String(row.english_text) : prevItem?.englishText || "",
    chineseText: row.chinese_text != null && row.chinese_text !== "" ? String(row.chinese_text) : prevItem?.chineseText || "",
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

  /** From GET /me — prepaid / grant script generations (not decremented by this app yet). */
  const [scriptCredits, setScriptCredits] = useState(null);

  /** From GET /me — used to show owner-only nav (must match server allowlist). */
  const [meEmail, setMeEmail] = useState("");

  const [page, setPage] = useState("home"); // home | generate | pricing | login | scripts | owner
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

  /** Full script text lives on GET /scripts/:id — list route omits english_text/chinese_text. */
  const fetchScriptDetail = useCallback(async (scriptId) => {
    if (!authToken || !scriptId) return null;
    try {
      const r = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d.script || null;
    } catch {
      return null;
    }
  }, [authToken]);

  const scheduleProgressPoll = useCallback(
    (scriptId) => {
      if (!authToken || !scriptId) return;
      clearBackgroundPoll();
      pollIntervalRef.current = -1;

      const applyPolledRows = (rows) => {
        const rowById = new Map(rows.map((r) => [r.id, r]));
        const activeId = activeScriptIdRef.current;

        // Update the editor + progress for the currently loaded script.
        if (activeId && rowById.has(activeId)) {
          const row = rowById.get(activeId);
          const target = row.episode_target || 60;
          const doneEp = row.episode_done ?? 0;
          if (Object.prototype.hasOwnProperty.call(row, "english_text")) {
            setScript(String(row.english_text ?? ""));
          }
          if (Object.prototype.hasOwnProperty.call(row, "chinese_text")) {
            setScriptZh(String(row.chinese_text ?? ""));
          }
          if (row.status === "generating") {
            setProgress({
              episode: doneEp || 0,
              total: target,
              phase: "generating",
            });
          } else if (row.status === "failed") {
            setError(row.error_message || "Generation failed");
          } else if (row.status === "complete") {
            if (doneEp < target) {
              setError(
                `Generation finished on the server with only ${doneEp} of ${target} episodes saved. Open My Scripts to inspect, or delete and start again. / 服务器仅保存了 ${doneEp}/${target} 集。请在「我的剧本」中查看或删除后重试。`
              );
            } else {
              setModalOpen(false);
            }
          }
        }

        setMyScripts((prev) => {
          const prevById = new Map(prev.map((x) => [x.id, x]));
          const fromServerMissing = rows
            .filter((row) => !prevById.has(row.id))
            .map((row) => mapServerListRowToItem(row, undefined));

          const updated = prev.map((it) => {
            const row = rowById.get(it.id);
            if (!row) return it;
            const target = row.episode_target || 60;
            return {
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
              englishText: Object.prototype.hasOwnProperty.call(row, "english_text")
                ? String(row.english_text ?? "")
                : it.englishText,
              chineseText: Object.prototype.hasOwnProperty.call(row, "chinese_text")
                ? String(row.chinese_text ?? "")
                : it.chineseText,
              generating: row.status === "generating",
              status: row.status,
              episodeDone: row.episode_done ?? 0,
              episodeTarget: row.episode_target ?? it.episodeTarget ?? target,
              errorMessage: row.error_message ? String(row.error_message) : "",
            };
          });

          // Keep server-updated + any newly discovered server scripts, but cap the UI list.
          return [...fromServerMissing, ...updated].slice(0, 50);
        });
      };

      const pollOnce = async () => {
        try {
          const pr = await fetch(`${API_BASE}/scripts`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (!pr.ok) return;
          const pd = await pr.json();
          let rows = Array.isArray(pd.scripts) ? pd.scripts : [];
          if (!rows.length) return;

          const aid = activeScriptIdRef.current;
          if (aid && rows.some((r) => r.id === aid)) {
            const detail = await fetchScriptDetail(aid);
            if (detail) {
              rows = rows.map((r) =>
                r.id === aid
                  ? {
                      ...r,
                      english_text: detail.english_text,
                      chinese_text: detail.chinese_text,
                      status: detail.status ?? r.status,
                      episode_done: detail.episode_done ?? r.episode_done,
                      episode_target: detail.episode_target ?? r.episode_target,
                      error_message: detail.error_message ?? r.error_message,
                      genre: detail.genre ?? r.genre,
                      summary: detail.summary ?? r.summary,
                    }
                  : r
              );
            }
          }

          const anyGenerating = rows.some((r) => r.status === "generating");
          rows = await attachFullTextToCompleteRows(
            rows,
            fetchScriptDetail,
            anyGenerating ? 6 : 10
          );

          applyPolledRows(rows);

          if (!anyGenerating) {
            clearBackgroundPoll();
            setProgress({ episode: 0, total: 0, phase: "generating" });
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
    [authToken, clearBackgroundPoll, fetchScriptDetail]
  );

  const refetchMyScriptsFromServer = useCallback(async () => {
    if (!authToken) return;
    try {
      const r = await fetch(`${API_BASE}/scripts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) return;
      const data = await r.json();
      let rows = Array.isArray(data.scripts) ? data.scripts : [];
      if (rows.length) {
        rows = await attachFullTextToCompleteRows(rows, fetchScriptDetail, 10);
      }
      setMyScripts((prev) => {
        const prevById = new Map(prev.map((x) => [x.id, x]));
        const serverIds = new Set(rows.map((row) => row.id));
        const fromServer = rows.map((row) => mapServerListRowToItem(row, prevById.get(row.id)));
        const localOnly = prev.filter((p) => !serverIds.has(p.id));
        return [...fromServer, ...localOnly].slice(0, 50);
      });
      const topGen = rows.find((row) => row.status === "generating");
      if (topGen) scheduleProgressPoll(topGen.id);
    } catch {
      /* ignore */
    }
  }, [authToken, fetchScriptDetail, scheduleProgressPoll]);

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
    if (!authToken) {
      setScriptCredits(null);
      setMeEmail("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!r.ok || cancelled) return;
        const d = await r.json().catch(() => ({}));
        if (cancelled || !d.user) return;
        setMeEmail(String(d.user.email || "").trim());
        const n = d.user.scriptCredits;
        setScriptCredits(typeof n === "number" && Number.isFinite(n) ? n : 0);
      } catch {
        if (!cancelled) setScriptCredits(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  const refreshMe = useCallback(async () => {
    if (!authToken) return;
    try {
      const r = await fetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      if (!d.user) return;
      setMeEmail(String(d.user.email || "").trim());
      const n = d.user.scriptCredits;
      setScriptCredits(typeof n === "number" && Number.isFinite(n) ? n : 0);
    } catch {
      /* ignore */
    }
  }, [authToken]);

  const showOwnerTab =
    Boolean(authToken) &&
    meEmail.trim().toLowerCase() === OWNER_OPS_TAB_EMAIL;

  useEffect(() => {
    if (page !== "owner") return;
    if (!authToken) {
      setPage("home");
      return;
    }
    if (meEmail && meEmail.trim().toLowerCase() !== OWNER_OPS_TAB_EMAIL) {
      setPage("home");
    }
  }, [page, authToken, meEmail]);

  useEffect(() => {
    return () => clearBackgroundPoll();
  }, []);

  useEffect(() => {
    if (!authToken) return;
    void refetchMyScriptsFromServer();
  }, [authToken, refetchMyScriptsFromServer]);

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

  const loadScriptItem = async (item) => {
    if (!item) return;
    setError("");
    if (authToken && isServerBackedScriptId(item.id)) {
      const row = await fetchScriptDetail(item.id);
      if (row) {
        setScript(row.english_text || "");
        setScriptZh(row.chinese_text || "");
        setGenre(String(row.genre || item.genre || "").trim());
        setActiveScriptId(item.id);
        setPage("generate");
        setModalOpen(false);
        setMyScripts((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  englishText: row.english_text || "",
                  chineseText: row.chinese_text || "",
                  status: row.status,
                  generating: row.status === "generating",
                  episodeDone: row.episode_done ?? it.episodeDone,
                  episodeTarget: row.episode_target ?? it.episodeTarget,
                  errorMessage: row.error_message ? String(row.error_message) : "",
                }
              : it
          )
        );
        return;
      }
      setError("Could not load script from server. / 无法从服务器加载剧本。");
    }
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
      if (typeof loginData.scriptCredits === "number" && Number.isFinite(loginData.scriptCredits)) {
        setScriptCredits(loginData.scriptCredits);
      }

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
      if (typeof data.scriptCredits === "number" && Number.isFinite(data.scriptCredits)) {
        setScriptCredits(data.scriptCredits);
      }
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
    setMeEmail("");
    try {
      localStorage.removeItem("authToken");
    } catch {}
    setPage("home");
    setModalOpen(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!genre) return;
    if (authToken) {
      if (scriptCredits === null) {
        setError(
          "Loading your account… Please wait and try again. / 正在加载账户信息，请稍后再试。"
        );
        return;
      }
      if (scriptCredits < 1) {
        setError(SCRIPT_CREDITS_REQUIRED_MSG);
        return;
      }
      const activeGenerationCount = myScripts.filter(
        (s) => s.status === "generating" || s.generating
      ).length;
      if (activeGenerationCount >= MAX_CONCURRENT_GENERATIONS) {
        setError(CONCURRENT_GENERATIONS_CAP_MSG);
        return;
      }
    }
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
        void refreshMe();
        return;
      }

      const errMsg = String(bgData.error || "");
      const tryStreamFallback =
        bgRes.status === 503 && /Background generation requires/i.test(errMsg);
      if (!tryStreamFallback) {
        setLoading(false);
        setProgress({ episode: 0, total: 0, phase: "generating" });
        if (bgRes.status === 401 || bgRes.status === 403) {
          setError(
            errMsg ||
              "Please register and verify your email, then log in again."
          );
        } else if (bgRes.status === 429) {
          setError(errMsg || CONCURRENT_GENERATIONS_CAP_MSG);
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
        if (res.status === 429) {
          throw new Error(data.error || CONCURRENT_GENERATIONS_CAP_MSG);
        }
        throw new Error(data.error || "Generation failed");
      }
      void refreshMe();
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
          if (authToken) {
            void refetchMyScriptsFromServer();
          } else {
            persistGeneratedScript(fullScript, genre, streamSummaryForPersist);
          }
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
        {showOwnerTab ? (
          <button
            type="button"
            className={page === "owner" ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => setPage("owner")}
            style={{ borderRadius: 6 }}
          >
            Owner / 站长
          </button>
        ) : null}
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
              GENERATE MULTIPLE PRODUCTION-READY 60-EPISODE VERTICAL SCRIPTS AT THE SAME TIME!
            </div>
            <div style={{ marginTop: "0.5rem", opacity: 0.95 }}>
              同时生成多部 60 集可投入制作的垂直剧本！
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

      {page === "owner" && showOwnerTab ? (
        <SecretOwnerTools
          API_BASE={API_BASE}
          authToken={authToken}
          onAfterGrant={refreshMe}
        />
      ) : null}

      {page === "pricing" && (
        <section className="script-output pricing-panel" style={{ maxWidth: 1100 }}>
          <h2 className="pricing-title">PRICING / 定价</h2>
          <p
            className="script-output-hint pricing-hint"
            style={{ marginTop: "-0.25rem" }}
          >
            Full 60-episode vertical scripts · RMB pricing · Batch bundles + monthly tiers / 完整 60 集垂直剧本 · 人民币计费 ·
            批量包 + 月付档位
          </p>

          <div className="pricing-batch-section">
            <h3 className="pricing-subtitle">Batch value pricing / 批量梯度价</h3>
            <p className="pricing-batch-lead">
              Instead of one flat per-script price, bundles are priced for value—the <strong>5-script pack</strong> is a
              product, not just a discount. / 不单次一口价，而用梯度打包体现价值——
              <strong>5 本剧本包</strong>是独立产品，而不是“随便减点价”。
            </p>
            <div className="pricing-bundle-grid">
              {[
                { n: 1, total: 100, each: 100 },
                { n: 5, total: 400, each: 80 },
                { n: 20, total: 1200, each: 60 },
                { n: 100, total: 4000, each: 40 },
              ].map((b) => (
                <div key={b.n} className="pricing-bundle-card">
                  <div className="pricing-bundle-count">
                    {b.n} script{b.n > 1 ? "s" : ""} / {b.n} 本
                  </div>
                  <div className="pricing-bundle-total">¥{b.total}</div>
                  <div className="pricing-bundle-each">
                    ¥{b.each} <span>each / 每本</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary pricing-bundle-cta"
                    onClick={() => {
                      /* Stripe / checkout — coming soon */
                    }}
                  >
                    Purchase / 购买
                  </button>
                </div>
              ))}
            </div>
          </div>

          <h3 className="pricing-subtitle" style={{ marginTop: "1.75rem" }}>
            Monthly tiers / 月付档位
          </h3>
          <p className="script-output-hint pricing-hint" style={{ marginBottom: "0.9rem" }}>
            Aggressive included scripts + low overage rates. / 包含剧本数更激进，超出后单价更低。
          </p>

          <div className="pricing-grid">
            <article className="pricing-card">
              <h3 className="pricing-name">Pay-as-you-go / 按需付费</h3>
              <p className="pricing-rate">
                ¥120 <span>per script / 每本剧本</span>
              </p>
              <ul className="pricing-features">
                <li>No monthly commitment — buy scripts as you need / 无月费，按本购买</li>
                <li>Combine with batch bundles above for lower per-script cost / 可叠加上方批量包，单本更省</li>
                <li>Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本</li>
              </ul>
              <div className="pricing-card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                  onClick={() => {
                    /* Stripe — single script PAYG — coming soon */
                  }}
                >
                  Purchase / 购买
                </button>
              </div>
            </article>

            <article className="pricing-card">
              <h3 className="pricing-name">Starter / 入门</h3>
              <p className="pricing-rate">
                ¥599<span className="pricing-rate-unit">/month · 月</span>
              </p>
              <ul className="pricing-features">
                <li>
                  <strong>5 free scripts / month</strong> included / 每月含 <strong>5 本免费</strong> 剧本额度
                </li>
                <li>
                  <strong>¥80</strong> per script after quota / 超额后每本 <strong>¥80</strong>
                </li>
                <li>Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本</li>
              </ul>
              <div className="pricing-card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                  onClick={() => {
                    /* Stripe — Subscribe Starter — coming soon */
                  }}
                >
                  Subscribe / 订阅
                </button>
              </div>
            </article>

            <article className="pricing-card">
              <h3 className="pricing-name">Professional / 专业</h3>
              <p className="pricing-rate">
                ¥2,999<span className="pricing-rate-unit">/month · 月</span>
              </p>
              <ul className="pricing-features">
                <li>
                  <strong>20 free scripts / month</strong> included / 每月含 <strong>20 本免费</strong> 剧本额度
                </li>
                <li>
                  <strong>¥50</strong> per script after quota / 超额后每本 <strong>¥50</strong>
                </li>
                <li>Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本</li>
              </ul>
              <div className="pricing-card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                  onClick={() => {
                    /* Stripe — Subscribe Professional — coming soon */
                  }}
                >
                  Subscribe / 订阅
                </button>
              </div>
            </article>

            <article className="pricing-card">
              <h3 className="pricing-name">Business / 商务</h3>
              <p className="pricing-rate">
                ¥9,999<span className="pricing-rate-unit">/month · 月</span>
              </p>
              <ul className="pricing-features">
                <li>
                  <strong>100 free scripts / month</strong> included / 每月含 <strong>100 本免费</strong> 剧本额度
                </li>
                <li>
                  <strong>¥30</strong> per script after quota / 超额后每本 <strong>¥30</strong>
                </li>
                <li>Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本</li>
              </ul>
              <div className="pricing-card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                  onClick={() => {
                    /* Stripe — Subscribe Business — coming soon */
                  }}
                >
                  Subscribe / 订阅
                </button>
              </div>
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
                            let en = it.englishText;
                            if (
                              !String(en || "").trim() &&
                              authToken &&
                              isServerBackedScriptId(it.id)
                            ) {
                              const row = await fetchScriptDetail(it.id);
                              en = row?.english_text || "";
                            }
                            const pdfBytes = await buildScreenplayPdfBytes(en, "en");
                            triggerPdfDownload(pdfBytes, "vertical_script_en.pdf");
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Download failed");
                          } finally {
                            setDownloading(null);
                          }
                        }}
                        disabled={
                          downloading !== null ||
                          (!it.englishText?.trim() &&
                            !(authToken && isServerBackedScriptId(it.id)))
                        }
                      >
                        Download EN PDF
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={
                          (!it.chineseText?.trim() &&
                            !(authToken && isServerBackedScriptId(it.id))) ||
                          downloading !== null
                        }
                        onClick={async () => {
                          try {
                            setError("");
                            setDownloading("zh");
                            let zh = it.chineseText;
                            if (
                              !String(zh || "").trim() &&
                              authToken &&
                              isServerBackedScriptId(it.id)
                            ) {
                              const row = await fetchScriptDetail(it.id);
                              zh = row?.chinese_text || "";
                            }
                            const pdfBytes = await buildScreenplayPdfBytes(zh, "zh");
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
          {authToken ? (
            <div className="script-credits-strip" aria-live="polite">
              <span className="script-credits-label">
                Script credits / 剧本额度
              </span>
              <span className="script-credits-value">
                {scriptCredits !== null ? scriptCredits : "—"}
              </span>
            </div>
          ) : null}
          {authToken && scriptCredits !== null && scriptCredits < 1 ? (
            <p className="script-credits-required-callout" role="alert">
              <span className="script-credits-required-en">
                Purchase credits to generate a script!
              </span>
              <span className="script-credits-required-zh">
                购买剧本额度后方可生成剧本！
              </span>
            </p>
          ) : null}
          <div className="generate-page-hint">
            <p className="generate-page-hint-en">
              Once your generation begins it will proceed on the backend—you do not need to keep the browser tab
              open while it runs. If you close the tab, you can reopen the page later and check progress under{" "}
              <strong>My Scripts</strong>
              (refresh if needed). Keep the tab open{" "}
              <strong>only while translating the script to Chinese</strong>. It takes around 50 minutes to generate a
              script and about 10 minutes to translate it. You can have up to{" "}
              <strong>5 scripts</strong> generating at the same time.
            </p>
            <p className="generate-page-hint-zh">
              生成开始后会由服务器在后台继续执行，
              <strong>生成过程中不必</strong>
              一直开着浏览器标签页。若已关闭标签页，可稍后重新打开页面，在
              <strong>我的剧本</strong>
              中查看进度（必要时刷新）。<strong>仅在将剧本翻译为简体中文时</strong>
              需要保持标签页打开。完整生成一部剧本大约需要 50 分钟，翻译约需 10 分钟。最多可同时有{" "}
              <strong>5 部剧本</strong>在生成中。
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
              if (scriptCredits === null) {
                setError(
                  "Loading your account… Please wait and try again. / 正在加载账户信息，请稍后再试。"
                );
                return;
              }
              if (scriptCredits < 1) {
                setError(SCRIPT_CREDITS_REQUIRED_MSG);
                return;
              }
              const genCount = myScripts.filter(
                (s) => s.status === "generating" || s.generating
              ).length;
              if (genCount >= MAX_CONCURRENT_GENERATIONS) {
                setError(CONCURRENT_GENERATIONS_CAP_MSG);
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
            {prepareEnglishScriptForDisplay(script)}
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
                  disabled={
                    loading ||
                    !genre ||
                    (Boolean(authToken) &&
                      (scriptCredits === null ||
                        scriptCredits < 1 ||
                        myScripts.filter(
                          (s) => s.status === "generating" || s.generating
                        ).length >= MAX_CONCURRENT_GENERATIONS))
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
