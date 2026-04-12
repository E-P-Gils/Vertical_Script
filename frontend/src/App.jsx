import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

const UI_LANG_STORAGE_KEY = "vertical_script_ui_lang";

const UiLangContext = createContext({
  uiLang: "en",
  setUiLang: () => {},
});

function useUiLang() {
  return useContext(UiLangContext);
}

function pickLang(lang, en, zh) {
  return lang === "zh" ? zh : en;
}

/** One line from `English / 中文` using the last ` / ` as delimiter. */
function biText(lang, text) {
  const s = String(text ?? "");
  const sep = " / ";
  const i = s.lastIndexOf(sep);
  if (i < 0) return s;
  return pickLang(lang, s.slice(0, i).trim(), s.slice(i + sep.length).trim());
}

function Bi({ text }) {
  const { uiLang } = useUiLang();
  return biText(uiLang, text);
}

function scriptCreditsRequiredMsg(lang) {
  return pickLang(
    lang,
    "Purchase credits to generate a script!",
    "购买剧本额度后方可生成剧本！"
  );
}

function concurrentGenerationsCapMsg(lang) {
  return pickLang(
    lang,
    `You already have ${MAX_CONCURRENT_GENERATIONS} scripts generating. Wait for one to finish or check My Scripts.`,
    `您已有 ${MAX_CONCURRENT_GENERATIONS} 个剧本正在生成，请等待完成或在「我的剧本」中查看。`
  );
}

function UiLangSwitch() {
  const { uiLang, setUiLang } = useUiLang();
  const isZh = uiLang === "zh";
  return (
    <div className="ui-lang-node">
      <div className="ui-lang-node-caption" aria-hidden>
        <span className="ui-lang-caption-line">Language</span>
        <span className="ui-lang-caption-line">语言</span>
      </div>
      <button
        type="button"
        className={`ui-lang-segmented${isZh ? " is-zh" : " is-en"}`}
        role="switch"
        aria-checked={isZh}
        aria-label={isZh ? "Interface language: Chinese. Switch to English." : "界面语言：英文。切换至中文。"}
        onClick={() => setUiLang(isZh ? "en" : "zh")}
      >
        <span className="ui-lang-knob" aria-hidden />
        <span className="ui-lang-seg">English</span>
        <span className="ui-lang-seg">中文</span>
      </button>
    </div>
  );
}

const DEFAULT_OWNER_OPS_TAB_EMAILS = "sculptoid11@gmail.com,imwuqi57@gmail.com";

function parseOwnerOpsTabEmails(raw) {
  return String(raw || "")
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Shown only in nav for these accounts; must match server owner allowlist. */
const OWNER_OPS_TAB_EMAILS = (() => {
  const fromEnv =
    import.meta.env.VITE_OWNER_OPS_EMAILS || import.meta.env.VITE_OWNER_OPS_EMAIL;
  const parsed = parseOwnerOpsTabEmails(fromEnv);
  if (parsed.length) return new Set(parsed);
  return new Set(parseOwnerOpsTabEmails(DEFAULT_OWNER_OPS_TAB_EMAILS));
})();

/** Must match backend `scriptsStore.js` MAX_CONCURRENT_GENERATIONS_PER_USER. */
const MAX_CONCURRENT_GENERATIONS = 5;

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
    creditRefunded: row.credit_refunded != null ? !!row.credit_refunded : !!prevItem?.creditRefunded,
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
  // Some auth UI flows reference this; keep defined to avoid runtime errors.
  const [authCode, setAuthCode] = useState("");
  const [authMode, setAuthMode] = useState("register"); // register | login

  const [uiLang, setUiLang] = useState(() => {
    try {
      return localStorage.getItem(UI_LANG_STORAGE_KEY) === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  });
  const uiLangRef = useRef(uiLang);
  uiLangRef.current = uiLang;

  useEffect(() => {
    try {
      localStorage.setItem(UI_LANG_STORAGE_KEY, uiLang);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = uiLang === "zh" ? "zh-Hans" : "en";
  }, [uiLang]);

  /** From GET /me — prepaid / grant script generations (not decremented by this app yet). */
  const [scriptCredits, setScriptCredits] = useState(null);

  /** From GET /me — used to show owner-only nav (must match server allowlist). */
  const [meEmail, setMeEmail] = useState("");

  /** From GET /me — subscription + pricing UI. */
  const [mePlanTier, setMePlanTier] = useState("free");
  const [meStripeSubscriptionId, setMeStripeSubscriptionId] = useState(null);
  const [meSubscriptionCancelAtPeriodEnd, setMeSubscriptionCancelAtPeriodEnd] = useState(false);
  const [meSubscriptionPeriodEnd, setMeSubscriptionPeriodEnd] = useState(null);

  /** null | "confirm" | "done" — cancel subscription modal on pricing. */
  const [cancelSubModal, setCancelSubModal] = useState(null);
  const [cancelSubLoading, setCancelSubLoading] = useState(false);
  const [cancelDonePeriodEnd, setCancelDonePeriodEnd] = useState(null);

  const [page, setPage] = useState("home"); // home | generate | pricing | login | scripts | owner
  const [myScripts, setMyScripts] = useState([]);
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
                pickLang(
                  uiLangRef.current,
                  `Generation finished on the server with only ${doneEp} of ${target} episodes saved. Open My Scripts to inspect, or delete and start again.`,
                  `服务器仅保存了 ${doneEp}/${target} 集。请在「我的剧本」中查看或删除后重试。`
                )
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

  const scriptsCacheKey = useMemo(() => {
    const e = String(meEmail || "").trim().toLowerCase();
    return e ? `myScripts:${e}` : "";
  }, [meEmail]);

  // Load per-user cached scripts when we know the account email.
  useEffect(() => {
    if (!authToken) return;
    if (!scriptsCacheKey) return;
    try {
      const raw = localStorage.getItem(scriptsCacheKey);
      const parsed = raw ? JSON.parse(raw) : [];
      const items = Array.isArray(parsed)
        ? parsed.map((it, idx) => ({
            id: it?.id || `legacy_${idx}_${Date.now()}`,
            createdAt: it?.createdAt || new Date().toISOString(),
            title: formatMyScriptListTitle(it?.genre, it?.createdAt || new Date().toISOString()),
            genre: String(it?.genre || "").trim(),
            summary: String(it?.summary || "").trim(),
            englishText: String(it?.englishText || "").trim(),
            chineseText: String(it?.chineseText || "").trim(),
            generating: !!it?.generating,
            status: it?.status || "",
            episodeDone: it?.episodeDone ?? 0,
            episodeTarget: it?.episodeTarget ?? 60,
            errorMessage: String(it?.errorMessage || ""),
          }))
        : [];
      // Only set local cache if we don't already have server-backed rows.
      setMyScripts((prev) => (prev && prev.length ? prev : items.slice(0, 50)));
    } catch {
      /* ignore */
    }
  }, [authToken, scriptsCacheKey]);

  // Persist cache per-user only (never global), and only when logged in.
  useEffect(() => {
    if (!authToken) return;
    if (!scriptsCacheKey) return;
    try {
      localStorage.setItem(scriptsCacheKey, JSON.stringify(myScripts));
    } catch {}
  }, [authToken, myScripts, scriptsCacheKey]);

  // On logout/account switch, clear UI state and remove legacy global cache key.
  useEffect(() => {
    if (authToken) return;
    setMyScripts([]);
    setActiveScriptId(null);
    try {
      localStorage.removeItem("myScripts");
    } catch {}
  }, [authToken]);

  useEffect(() => {
    if (authToken) setError("");
  }, [authToken]);

  // Switching accounts on the same device should never show the previous user's cached scripts.
  useEffect(() => {
    setMyScripts([]);
    setActiveScriptId(null);
  }, [authToken]);

  useEffect(() => {
    if (!authToken) {
      setScriptCredits(null);
      setMeEmail("");
      setMePlanTier("free");
      setMeStripeSubscriptionId(null);
      setMeSubscriptionCancelAtPeriodEnd(false);
      setMeSubscriptionPeriodEnd(null);
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
        setMePlanTier(String(d.user.planTier || "free").toLowerCase());
        setMeStripeSubscriptionId(d.user.stripeSubscriptionId || null);
        setMeSubscriptionCancelAtPeriodEnd(!!d.user.subscriptionCancelAtPeriodEnd);
        setMeSubscriptionPeriodEnd(
          d.user.subscriptionCurrentPeriodEnd != null
            ? String(d.user.subscriptionCurrentPeriodEnd)
            : null
        );
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
      setMePlanTier(String(d.user.planTier || "free").toLowerCase());
      setMeStripeSubscriptionId(d.user.stripeSubscriptionId || null);
      setMeSubscriptionCancelAtPeriodEnd(!!d.user.subscriptionCancelAtPeriodEnd);
      setMeSubscriptionPeriodEnd(
        d.user.subscriptionCurrentPeriodEnd != null
          ? String(d.user.subscriptionCurrentPeriodEnd)
          : null
      );
    } catch {
      /* ignore */
    }
  }, [authToken]);

  const refundCreditForScript = useCallback(
    async (scriptId) => {
      if (!authToken || !scriptId) return;
      try {
        const r = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}/refund-credit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return;
        if (d.refunded) {
          setMyScripts((prev) =>
            prev.map((it) => (it.id === scriptId ? { ...it, creditRefunded: true } : it))
          );
          // Update the credits strip if visible.
          void refreshMe();
        }
      } catch {
        /* ignore */
      }
    },
    [API_BASE, authToken, refreshMe]
  );

  // When a script fails or completes short, auto-refund one credit (idempotent).
  useEffect(() => {
    if (!authToken) return;
    (myScripts || []).forEach((it) => {
      if (!it || !isServerBackedScriptId(it.id)) return;
      if (it.creditRefunded) return;
      const status = String(it.status || "");
      const target = Number(it.episodeTarget ?? 60);
      const done = Number(it.episodeDone ?? 0);
      const eligible = status === "failed" || (status === "complete" && done < target);
      if (eligible) void refundCreditForScript(it.id);
    });
  }, [authToken, myScripts, refundCreditForScript]);

  const showOwnerTab =
    Boolean(authToken) && OWNER_OPS_TAB_EMAILS.has(meEmail.trim().toLowerCase());

  useEffect(() => {
    if (page !== "owner") return;
    if (!authToken) {
      setPage("home");
      return;
    }
    if (meEmail && !OWNER_OPS_TAB_EMAILS.has(meEmail.trim().toLowerCase())) {
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
      setError(
        pickLang(uiLang, "Could not load script from server.", "无法从服务器加载剧本。")
      );
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
        throw new Error(
          pickLang(
            uiLang,
            "Please enter a valid email address with a real domain.",
            "请输入有效的邮箱地址（需包含域名）。"
          )
        );
      }

      const password = String(authPassword || "");
      const confirm = String(authConfirmPassword || "");
      if (password !== confirm) {
        throw new Error(pickLang(uiLang, "Passwords do not match.", "两次密码不一致。"));
      }

      const passwordOk = password.length >= 8 &&
        /[A-Za-z]/.test(password) &&
        /[0-9]/.test(password) &&
        /[^A-Za-z0-9]/.test(password);
      if (!passwordOk) {
        throw new Error(
          pickLang(
            uiLang,
            "Password must be at least 8 characters and include letters, numbers, and a special character.",
            "密码至少8位，并包含字母、数字和特殊字符。"
          )
        );
      }

      if (!password) {
        throw new Error(pickLang(uiLang, "Password is required.", "请输入密码。"));
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
        setError(pickLang(uiLang, "Password must be at least 8 characters.", "密码至少8位。"));
      } else if (msg.includes("email and password are required")) {
        setError(pickLang(uiLang, "Email and password are required.", "需要邮箱与密码。"));
      } else if (msg.includes("auth is not enabled")) {
        setError(pickLang(uiLang, "Registration is not enabled on this server.", "此服务器尚未启用注册。"));
      } else if (msg.includes("user already exists")) {
        setError(
          pickLang(
            uiLang,
            "This account already exists. Please use the login flow.",
            "该账号已存在，请走登录流程。"
          )
        );
      } else if (msg) {
        setError(msg);
      } else {
        setError(pickLang(uiLang, "Registration failed.", "注册失败。"));
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
        throw new Error(
          pickLang(
            uiLang,
            "Please enter a valid email address with a real domain.",
            "请输入有效的邮箱地址（需包含域名）。"
          )
        );
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
        setError(
          pickLang(
            uiLang,
            "No registered account found (or wrong password). Please register.",
            "未注册账号或密码错误，请先注册。"
          )
        );
      } else {
        setError(err?.message || "Login failed");
      }
    }
  };

  const handleLogout = () => {
    clearBackgroundPoll();
    setAuthToken(null);
    setMeEmail("");
    setMePlanTier("free");
    setMeStripeSubscriptionId(null);
    setMeSubscriptionCancelAtPeriodEnd(false);
    setMeSubscriptionPeriodEnd(null);
    setCancelSubModal(null);
    try {
      localStorage.removeItem("authToken");
    } catch {}
    setPage("home");
    setModalOpen(false);
  };

  const confirmCancelSubscription = useCallback(async () => {
    if (!authToken) return;
    setCancelSubLoading(true);
    setError("");
    try {
      const r = await fetch(`${API_BASE}/vsinfinite/stripe/cancel-subscription`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Cancel failed");
      setCancelDonePeriodEnd(d.currentPeriodEnd ? String(d.currentPeriodEnd) : null);
      setCancelSubModal("done");
      void refreshMe();
    } catch (e) {
      setError(String(e?.message || e || "Cancel failed"));
    } finally {
      setCancelSubLoading(false);
    }
  }, [authToken, refreshMe]);

  const startStripeCheckout = useCallback(
    async ({ pack, kind }) => {
      if (!authToken) {
        setError(pickLang(uiLang, "Please log in or register first.", "请先登录或注册。"));
        setPage("login");
        return;
      }
      setError("");
      try {
        const r = await fetch(`${API_BASE}/vsinfinite/stripe/create-checkout-session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ pack, kind }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Checkout failed");
        if (!d.url) throw new Error("Checkout failed: missing URL");
        window.location.href = d.url;
      } catch (e) {
        setError(String(e?.message || e || "Checkout failed"));
      }
    },
    [authToken, uiLang]
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!genre) return;
    if (authToken) {
      if (scriptCredits === null) {
        setError(
          pickLang(
            uiLang,
            "Loading your account… Please wait and try again.",
            "正在加载账户信息，请稍后再试。"
          )
        );
        return;
      }
      if (scriptCredits < 1) {
        setError(scriptCreditsRequiredMsg(uiLang));
        return;
      }
      const activeGenerationCount = myScripts.filter(
        (s) => s.status === "generating" || s.generating
      ).length;
      if (activeGenerationCount >= MAX_CONCURRENT_GENERATIONS) {
        setError(concurrentGenerationsCapMsg(uiLang));
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
          setError(errMsg || concurrentGenerationsCapMsg(uiLang));
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
          throw new Error(data.error || concurrentGenerationsCapMsg(uiLang));
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
    <UiLangContext.Provider value={{ uiLang, setUiLang }}>
      <div className="page" data-ui-lang={uiLang}>
        <UiLangSwitch />
        <header className="header">
          <h1 className="title">
            <span className="bilingual-en">VERTICAL INFINITE</span>
            <span className="bilingual-zh">垂直剧本工厂</span>
          </h1>
          <p className="title-sub">
            <span className="bilingual-en">Script Generator</span>
            <span className="bilingual-zh">剧本生成器</span>
          </p>
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
          <Bi text="Home / 首页" />
        </button>
        <button
          type="button"
          className={page === "generate" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("generate")}
          style={{ borderRadius: 6 }}
        >
          <Bi text="Generate / 生成" />
        </button>
        <button
          type="button"
          className={page === "pricing" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("pricing")}
          style={{ borderRadius: 6 }}
        >
          <Bi text="Pricing / 定价" />
        </button>
        <button
          type="button"
          className={page === "login" ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => setPage("login")}
          style={{ borderRadius: 6 }}
        >
          <Bi text="Login / 登录" />
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
          <Bi text="My Scripts / 我的剧本" />
        </button>
        {showOwnerTab ? (
          <button
            type="button"
            className={page === "owner" ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => setPage("owner")}
            style={{ borderRadius: 6 }}
          >
            <Bi text="Owner / 站长" />
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
            <div className="bilingual-en" style={{ color: "var(--blood-pale)" }}>
              GENERATE MULTIPLE PRODUCTION-READY 60-EPISODE VERTICAL SCRIPTS AT THE SAME TIME!
            </div>
            <div className="bilingual-zh" style={{ marginTop: "0.5rem", opacity: 0.95 }}>
              同时生成多部 60 集可投入制作的垂直剧本！
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPage("generate")}
            >
              <Bi text="Get Started / 开始" />
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
          <h2 className="pricing-title">
            <Bi text="PRICING / 定价" />
          </h2>
          <p
            className="script-output-hint pricing-hint"
            style={{ marginTop: "-0.25rem" }}
          >
            <Bi text="Full 60-episode vertical scripts · RMB pricing · Monthly plans, pay-as-you-go, then batch bundles / 完整 60 集垂直剧本 · 人民币计费 · 月付档位、按需付费与批量梯度包" />
          </p>

          {(() => {
            const paidTier =
              authToken && ["starter", "professional", "business"].includes(String(mePlanTier || "").toLowerCase());
            const tier = String(mePlanTier || "").toLowerCase();
            const overage = tier === "starter" ? 80 : tier === "professional" ? 50 : tier === "business" ? 30 : 120;
            const payPack =
              tier === "starter"
                ? "payg_starter"
                : tier === "professional"
                ? "payg_professional"
                : tier === "business"
                ? "payg_business"
                : "payg_1";

            return (
              <>
                <h3 className="pricing-subtitle">
                  {paidTier ? (
                    <Bi text="Your plan & add-ons / 当前套餐与加购" />
                  ) : (
                    <Bi text="Subscriptions & pay-as-you-go / 订阅与按需付费" />
                  )}
                </h3>
                <p className="script-output-hint pricing-hint" style={{ marginBottom: "0.9rem" }}>
                  {paidTier ? (
                    <Bi text="Buy extra script credits at your plan’s per-script rate, or save more with bundles. / 按当前档位超额单价购买剧本额度，也可用下方批量包进一步节省。" />
                  ) : (
                    <Bi text="Monthly tiers include a script quota with lower overage rates; pay-as-you-go is ¥120 per script with no commitment. / 月付档位含额度与更低超额价；按需付费按本 ¥120，无月费约束。" />
                  )}
                </p>

                {paidTier ? (
                  <>
                    <div className="pricing-payg-batch-row">
                      <div className="pricing-payg-col">
                        <article className="pricing-card">
                          <h3 className="pricing-name">
                            <Bi text="Buy Script Credit / 购买剧本额度" />
                          </h3>
                          <p className="pricing-rate">
                            ¥{overage}{" "}
                            <span>
                              <Bi text="per script / 每本剧本" />
                            </span>
                          </p>
                          <ul className="pricing-features">
                            <li>
                              <Bi text="Extra script credits billed per script at your tier rate / 按当前档位单本价格加购" />
                            </li>
                            <li>
                              <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                            </li>
                          </ul>
                          <div className="pricing-card-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{ width: "100%" }}
                              onClick={() => {
                                void startStripeCheckout({ pack: payPack, kind: "payment" });
                              }}
                            >
                              <Bi text="Buy Script Credit / 购买额度" />
                            </button>
                          </div>
                        </article>
                      </div>

                      <div className="pricing-batch-col">
                        <div className="pricing-batch-section" style={{ marginTop: 0 }}>
                          <h3 className="pricing-subtitle">
                            <Bi text="Batch value pricing / 批量梯度价" />
                          </h3>
                          <p className="pricing-batch-lead">
                            <span className="bilingual-en">
                              Bundles are priced for value—the <strong>5-script pack</strong> is a product, not just a
                              discount.
                            </span>
                            <span className="bilingual-zh">
                              梯度打包体现价值——<strong>5 本剧本包</strong>是独立产品，而不是“随便减点价”。
                            </span>
                          </p>
                          <div className="pricing-bundle-grid">
                            {[
                              { n: 5, total: 400, each: 80 },
                              { n: 20, total: 1200, each: 60 },
                              { n: 100, total: 4000, each: 40 },
                            ].map((b) => (
                              <div key={b.n} className="pricing-bundle-card">
                                <div className="pricing-bundle-count">
                                  {pickLang(
                                    uiLang,
                                    `${b.n} script${b.n > 1 ? "s" : ""}`,
                                    `${b.n} 本`
                                  )}
                                </div>
                                <div className="pricing-bundle-total">¥{b.total}</div>
                                <div className="pricing-bundle-each">
                                  ¥{b.each}{" "}
                                  <span>
                                    <Bi text="each / 每本" />
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-primary pricing-bundle-cta"
                                  onClick={() => {
                                    void startStripeCheckout({ pack: `pack_${b.n}`, kind: "payment" });
                                  }}
                                >
                                  <Bi text="Purchase / 购买" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <h3 className="pricing-subtitle" style={{ marginTop: "1.75rem" }}>
                      <Bi text="Monthly tiers / 月付档位" />
                    </h3>
                    <p className="script-output-hint pricing-hint" style={{ marginBottom: "0.9rem" }}>
                      <Bi text="Aggressive included scripts + low overage rates. / 包含剧本数更激进，超出后单价更低。" />
                    </p>
                  </>
                ) : (
                  <>
                    <div className="pricing-payg-sub-row">
                      <div className="pricing-payg-col">
                        <article className="pricing-card">
                          <h3 className="pricing-name">
                            <Bi text="Pay-as-you-go / 按需付费" />
                          </h3>
                          <p className="pricing-rate">
                            ¥120{" "}
                            <span>
                              <Bi text="per script / 每本剧本" />
                            </span>
                          </p>
                          <ul className="pricing-features">
                            <li>
                              <Bi text="No monthly commitment — buy scripts as you need / 无月费，按本购买" />
                            </li>
                            <li>
                              <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                            </li>
                          </ul>
                          <div className="pricing-card-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{ width: "100%" }}
                              onClick={() => {
                                void startStripeCheckout({ pack: "payg_1", kind: "payment" });
                              }}
                            >
                              <Bi text="Purchase / 购买" />
                            </button>
                          </div>
                        </article>
                      </div>
                      <div className="pricing-sub-col">
                        <div className="pricing-grid pricing-grid-3 pricing-grid-tight">
                          <article className="pricing-card">
                            <h3 className="pricing-name">
                              <Bi text="Starter / 入门" />
                            </h3>
                            <p className="pricing-rate">
                              ¥599<span className="pricing-rate-unit">/month · 月</span>
                            </p>
                            <ul className="pricing-features">
                              <li>
                                <span className="bilingual-en">
                                  <strong>5 free scripts / month</strong> included
                                </span>
                                <span className="bilingual-zh">
                                  每月含 <strong>5 本免费</strong> 剧本额度
                                </span>
                              </li>
                              <li>
                                <span className="bilingual-en">
                                  <strong>¥80</strong> per script after quota
                                </span>
                                <span className="bilingual-zh">
                                  超额后每本 <strong>¥80</strong>
                                </span>
                              </li>
                              <li>
                                <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                              </li>
                            </ul>
                            <div className="pricing-card-actions">
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ width: "100%" }}
                                onClick={() => {
                                  void startStripeCheckout({ pack: "sub_starter", kind: "subscription" });
                                }}
                              >
                                <Bi text="Subscribe / 订阅" />
                              </button>
                            </div>
                          </article>

                          <article className="pricing-card">
                            <h3 className="pricing-name">
                              <Bi text="Professional / 专业" />
                            </h3>
                            <p className="pricing-rate">
                              ¥2,999<span className="pricing-rate-unit">/month · 月</span>
                            </p>
                            <ul className="pricing-features">
                              <li>
                                <span className="bilingual-en">
                                  <strong>20 free scripts / month</strong> included
                                </span>
                                <span className="bilingual-zh">
                                  每月含 <strong>20 本免费</strong> 剧本额度
                                </span>
                              </li>
                              <li>
                                <span className="bilingual-en">
                                  <strong>¥50</strong> per script after quota
                                </span>
                                <span className="bilingual-zh">
                                  超额后每本 <strong>¥50</strong>
                                </span>
                              </li>
                              <li>
                                <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                              </li>
                            </ul>
                            <div className="pricing-card-actions">
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ width: "100%" }}
                                onClick={() => {
                                  void startStripeCheckout({ pack: "sub_professional", kind: "subscription" });
                                }}
                              >
                                <Bi text="Subscribe / 订阅" />
                              </button>
                            </div>
                          </article>

                          <article className="pricing-card">
                            <h3 className="pricing-name">
                              <Bi text="Business / 商务" />
                            </h3>
                            <p className="pricing-rate">
                              ¥9,999<span className="pricing-rate-unit">/month · 月</span>
                            </p>
                            <ul className="pricing-features">
                              <li>
                                <span className="bilingual-en">
                                  <strong>100 free scripts / month</strong> included
                                </span>
                                <span className="bilingual-zh">
                                  每月含 <strong>100 本免费</strong> 剧本额度
                                </span>
                              </li>
                              <li>
                                <span className="bilingual-en">
                                  <strong>¥30</strong> per script after quota
                                </span>
                                <span className="bilingual-zh">
                                  超额后每本 <strong>¥30</strong>
                                </span>
                              </li>
                              <li>
                                <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                              </li>
                            </ul>
                            <div className="pricing-card-actions">
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ width: "100%" }}
                                onClick={() => {
                                  void startStripeCheckout({ pack: "sub_business", kind: "subscription" });
                                }}
                              >
                                <Bi text="Subscribe / 订阅" />
                              </button>
                            </div>
                          </article>
                        </div>
                      </div>
                    </div>

                    <div className="pricing-batch-section pricing-batch-under" style={{ marginTop: "1.25rem" }}>
                      <h3 className="pricing-subtitle">
                        <Bi text="Batch value pricing / 批量梯度价" />
                      </h3>
                      <p className="pricing-batch-lead">
                        <span className="bilingual-en">
                          Bundles are priced for value—the <strong>5-script pack</strong> is a product, not just a
                          discount.
                        </span>
                        <span className="bilingual-zh">
                          梯度打包体现价值——<strong>5 本剧本包</strong>是独立产品，而不是“随便减点价”。
                        </span>
                      </p>
                      <div className="pricing-bundle-grid">
                        {[
                          { n: 5, total: 400, each: 80 },
                          { n: 20, total: 1200, each: 60 },
                          { n: 100, total: 4000, each: 40 },
                        ].map((b) => (
                          <div key={b.n} className="pricing-bundle-card">
                            <div className="pricing-bundle-count">
                              {pickLang(
                                uiLang,
                                `${b.n} script${b.n > 1 ? "s" : ""}`,
                                `${b.n} 本`
                              )}
                            </div>
                            <div className="pricing-bundle-total">¥{b.total}</div>
                            <div className="pricing-bundle-each">
                              ¥{b.each}{" "}
                              <span>
                                <Bi text="each / 每本" />
                              </span>
                            </div>
                            <button
                              type="button"
                              className="btn btn-primary pricing-bundle-cta"
                              onClick={() => {
                                void startStripeCheckout({ pack: `pack_${b.n}`, kind: "payment" });
                              }}
                            >
                              <Bi text="Purchase / 购买" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div className={paidTier ? "pricing-grid pricing-grid-3" : "pricing-hidden"} style={paidTier ? undefined : { display: "none" }}>
                  <article className="pricing-card">
                    <h3 className="pricing-name">
                      <Bi text="Starter / 入门" />
                    </h3>
                    <p className="pricing-rate">
                      ¥599<span className="pricing-rate-unit">/month · 月</span>
                    </p>
                    <ul className="pricing-features">
                      <li>
                        <span className="bilingual-en">
                          <strong>5 free scripts / month</strong> included
                        </span>
                        <span className="bilingual-zh">
                          每月含 <strong>5 本免费</strong> 剧本额度
                        </span>
                      </li>
                      <li>
                        <span className="bilingual-en">
                          <strong>¥80</strong> per script after quota
                        </span>
                        <span className="bilingual-zh">
                          超额后每本 <strong>¥80</strong>
                        </span>
                      </li>
                      <li>
                        <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                      </li>
                    </ul>
                    <div className="pricing-card-actions">
                      {authToken && mePlanTier === "starter" ? (
                        meSubscriptionCancelAtPeriodEnd ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ width: "100%" }}
                            disabled
                          >
                            <Bi text="Cancellation scheduled / 已安排周期末取消" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ width: "100%" }}
                            onClick={() => setCancelSubModal(meStripeSubscriptionId ? "confirm" : "noStripe")}
                          >
                            <Bi text="Cancel / 取消" />
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ width: "100%" }}
                          onClick={() => {
                            void startStripeCheckout({ pack: "sub_starter", kind: "subscription" });
                          }}
                        >
                          <Bi text="Subscribe / 订阅" />
                        </button>
                      )}
                    </div>
                  </article>

                  <article className="pricing-card">
                    <h3 className="pricing-name">
                      <Bi text="Professional / 专业" />
                    </h3>
                    <p className="pricing-rate">
                      ¥2,999<span className="pricing-rate-unit">/month · 月</span>
                    </p>
                    <ul className="pricing-features">
                      <li>
                        <span className="bilingual-en">
                          <strong>20 free scripts / month</strong> included
                        </span>
                        <span className="bilingual-zh">
                          每月含 <strong>20 本免费</strong> 剧本额度
                        </span>
                      </li>
                      <li>
                        <span className="bilingual-en">
                          <strong>¥50</strong> per script after quota
                        </span>
                        <span className="bilingual-zh">
                          超额后每本 <strong>¥50</strong>
                        </span>
                      </li>
                      <li>
                        <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                      </li>
                    </ul>
                    <div className="pricing-card-actions">
                      {authToken && mePlanTier === "professional" ? (
                        meSubscriptionCancelAtPeriodEnd ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ width: "100%" }}
                            disabled
                          >
                            <Bi text="Cancellation scheduled / 已安排周期末取消" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ width: "100%" }}
                            onClick={() => setCancelSubModal(meStripeSubscriptionId ? "confirm" : "noStripe")}
                          >
                            <Bi text="Cancel / 取消" />
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ width: "100%" }}
                          onClick={() => {
                            void startStripeCheckout({ pack: "sub_professional", kind: "subscription" });
                          }}
                        >
                          <Bi text="Subscribe / 订阅" />
                        </button>
                      )}
                    </div>
                  </article>

                  <article className="pricing-card">
                    <h3 className="pricing-name">
                      <Bi text="Business / 商务" />
                    </h3>
                    <p className="pricing-rate">
                      ¥9,999<span className="pricing-rate-unit">/month · 月</span>
                    </p>
                    <ul className="pricing-features">
                      <li>
                        <span className="bilingual-en">
                          <strong>100 free scripts / month</strong> included
                        </span>
                        <span className="bilingual-zh">
                          每月含 <strong>100 本免费</strong> 剧本额度
                        </span>
                      </li>
                      <li>
                        <span className="bilingual-en">
                          <strong>¥30</strong> per script after quota
                        </span>
                        <span className="bilingual-zh">
                          超额后每本 <strong>¥30</strong>
                        </span>
                      </li>
                      <li>
                        <Bi text="Full 60-episode vertical script per generation / 每次生成完整 60 集垂直剧本" />
                      </li>
                    </ul>
                    <div className="pricing-card-actions">
                      {authToken && mePlanTier === "business" ? (
                        meSubscriptionCancelAtPeriodEnd ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ width: "100%" }}
                            disabled
                          >
                            <Bi text="Cancellation scheduled / 已安排周期末取消" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ width: "100%" }}
                            onClick={() => setCancelSubModal(meStripeSubscriptionId ? "confirm" : "noStripe")}
                          >
                            <Bi text="Cancel / 取消" />
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ width: "100%" }}
                          onClick={() => {
                            void startStripeCheckout({ pack: "sub_business", kind: "subscription" });
                          }}
                        >
                          <Bi text="Subscribe / 订阅" />
                        </button>
                      )}
                    </div>
                  </article>
                </div>
              </>
            );
          })()}

          <div className="pricing-refund-policy">
            <h3 className="pricing-subtitle">
              <Bi text="Refund policy / 退款政策" />
            </h3>
            <p className="pricing-refund-policy-en bilingual-en">
              <strong>Subscriptions:</strong> You may contact us to request a refund within{" "}
              <strong>7 days</strong> of your <strong>first</strong> subscription payment, and within{" "}
              <strong>2 days</strong> of each <strong>renewal</strong> payment after that.
            </p>
            <p className="pricing-refund-policy-zh bilingual-zh">
              <strong>订阅：</strong>首次订阅付款后 <strong>7 天内</strong>，以及之后每次<strong>续费</strong>
              付款后 <strong>2 天内</strong>，可联系我们申请退款。
            </p>
          </div>
        </section>
      )}

      {page === "scripts" && (
        <section className="script-output" style={{ maxWidth: 720 }}>
          <h2 style={{ marginTop: 0 }}>
            <Bi text="My Scripts / 我的剧本" />
          </h2>
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
              <Bi text="No scripts saved yet. Generate your first one. / 暂无已保存剧本。先生成你的第一份剧本吧。" />
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
                          {pickLang(uiLang, "Genre", "类型")}: {it.genre || "N/A"}
                        </div>
                        <div style={{ opacity: 0.85, fontSize: "0.85rem", marginTop: "0.1rem" }}>
                          {pickLang(uiLang, "Date", "生成时间")}: {created.toLocaleString()}
                        </div>
                        {it.status === "generating" || it.generating ? (
                          <div style={{ opacity: 0.9, fontSize: "0.85rem", marginTop: "0.35rem" }}>
                            {pickLang(uiLang, "Generating in background…", "后台生成中…")}{" "}
                            {it.episodeDone ?? 0}/{it.episodeTarget ?? 60}
                          </div>
                        ) : null}
                        {it.status === "failed" && it.errorMessage ? (
                          <div className="error" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
                            {it.errorMessage}
                          </div>
                        ) : null}
                        {(it.status === "failed" ||
                          (it.status === "complete" &&
                            Number(it.episodeTarget ?? 60) > 0 &&
                            Number(it.episodeDone ?? 0) < Number(it.episodeTarget ?? 60))) && (
                          <div
                            className="error"
                            style={{
                              marginTop: "0.45rem",
                              fontSize: "0.85rem",
                              lineHeight: 1.45,
                              opacity: 0.98,
                            }}
                          >
                            <div className="bilingual-en" style={{ fontWeight: 700 }}>
                              This generation experienced issues on the backend. We are actively investigating and your
                              script credit has been refunded. We apologize for the inconvenience.
                            </div>
                            <div className="bilingual-zh" style={{ marginTop: "0.35rem", opacity: 0.95 }}>
                              本次生成在后台遇到问题。我们正在积极排查，且已为您退还本次消耗的剧本额度。对此给您带来的不便，我们深表歉意。
                            </div>
                          </div>
                        )}
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
                <Bi text="You need to login/register to start generating scripts. / 为开始生成剧本，你需要先登录/注册。" />
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <h2 style={{ marginTop: 0 }}>
              <Bi text="Account / 账号" />
            </h2>

            {authToken ? (
              <div>
                <p style={{ marginTop: 0, marginBottom: "0.75rem", opacity: 0.9 }}>
                  <Bi text="Logged in. You can generate scripts. / 已登录。你可以开始生成剧本。" />
                </p>
                <button type="button" className="btn btn-secondary" onClick={handleLogout}>
                  <Bi text="Log out / 退出" />
                </button>
              </div>
            ) : (
              <div>
            {authMode === "register" && (
              <>
              <form onSubmit={handleRegister} className="auth-form">
                <label className="field">
                  <span>
                    <Bi text="Email / 邮箱" />
                  </span>
                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    type="email"
                    required
                  />
                </label>
                <label className="field">
                  <span>
                    <Bi text="Password / 密码" />
                  </span>
                  <input
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    type="text"
                    required
                    minLength={8}
                  />
                </label>
                <label className="field">
                  <span>
                    <Bi text="Confirm Password / 确认密码" />
                  </span>
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
                  <Bi text="Register / 注册" />
                </button>
              </form>
              <div className="auth-toggle">
                <span className="auth-toggle-text">
                  <Bi text="Already have an account? Log in / 已有账号？登录" />
                </span>
                <button
                  type="button"
                  className="btn btn-secondary auth-toggle-btn"
                  onClick={() => {
                    setAuthMode("login");
                    setAuthCode("");
                    setAuthConfirmPassword("");
                  }}
                >
                  <Bi text="Log in / 登录" />
                </button>
              </div>
              </>
            )}

            {/* Confirmation code is handled in a modal. */}

            {authMode === "login" && (
              <form onSubmit={handleLogin} className="auth-form">
                <label className="field">
                  <span>
                    <Bi text="Email / 邮箱" />
                  </span>
                  <input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    type="email"
                    required
                  />
                </label>
                <label className="field">
                  <span>
                    <Bi text="Password / 密码" />
                  </span>
                  <input
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    type="password"
                    required
                    minLength={8}
                  />
                </label>
                <button type="submit" className="btn btn-primary" disabled={!authEmail || !authPassword}>
                  <Bi text="Log in / 登录" />
                </button>
                <div className="auth-toggle">
                  <span className="auth-toggle-text">
                    <Bi text="New here? Register / 新用户？注册" />
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary auth-toggle-btn"
                    onClick={() => {
                      setAuthMode("register");
                      setAuthCode("");
                      setAuthConfirmPassword("");
                    }}
                  >
                    <Bi text="Register / 注册" />
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
                <Bi text="Script credits / 剧本额度" />
              </span>
              <span className="script-credits-value">
                {scriptCredits !== null ? scriptCredits : "—"}
              </span>
            </div>
          ) : null}
          {authToken && scriptCredits !== null && scriptCredits < 1 ? (
            <p className="script-credits-required-callout" role="alert">
              <span className="script-credits-required-en bilingual-en">
                Purchase credits to generate a script!
              </span>
              <span className="script-credits-required-zh bilingual-zh">
                购买剧本额度后方可生成剧本！
              </span>
            </p>
          ) : null}
          <div className="generate-page-hint">
            <p className="generate-page-hint-en bilingual-en">
              Once your generation begins it will proceed on the backend—you do not need to keep the browser tab
              open while it runs. If you close the tab, you can reopen the page later and check progress under{" "}
              <strong>My Scripts</strong>
              (refresh if needed). Keep the tab open{" "}
              <strong>only while translating the script to Chinese</strong>. It takes around 50 minutes to generate a
              script and about 10 minutes to translate it. You can have up to{" "}
              <strong>5 scripts</strong> generating at the same time.
            </p>
            <p className="generate-page-hint-zh bilingual-zh">
              生成开始后会由服务器在后台继续执行，
              <strong>生成过程中不必</strong>
              一直开着浏览器标签页。若已关闭标签页，可稍后重新打开页面，在
              <strong>我的剧本</strong>
              中查看进度（必要时刷新）。<strong>仅在将剧本翻译为简体中文时</strong>
              需要保持标签页打开。完整生成一部剧本大约需要 50 分钟，翻译约需 10 分钟。最多可同时有{" "}
              <strong>5 部剧本</strong>在生成中。
            </p>
          </div>
          <div className="generate-page-bug-note" role="note">
            <p className="generate-page-bug-note-en bilingual-en">
              *There is a bug that sometimes shuffles the episode end numbers. It is especially common for the EPISODE
              60 END to actually read EPISODE 20 END. However this bug does not affect the quality or length of the
              scripts; we guarantee 60 episodes will be created with each generation.
            </p>
            <p className="generate-page-bug-note-zh bilingual-zh">
              *已知显示问题：各集结尾处的集数编号有时会被打乱显示，尤其是第 60 集结尾可能显示为「第 20 集结尾」等。该问题
              <strong>不影响</strong>剧本质量与篇幅；我们保证每次生成均会产出完整 <strong>60 集</strong>内容。
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
                  pickLang(
                    uiLang,
                    "Loading your account… Please wait and try again.",
                    "正在加载账户信息，请稍后再试。"
                  )
                );
                return;
              }
              if (scriptCredits < 1) {
                setError(scriptCreditsRequiredMsg(uiLang));
                return;
              }
              const genCount = myScripts.filter(
                (s) => s.status === "generating" || s.generating
              ).length;
              if (genCount >= MAX_CONCURRENT_GENERATIONS) {
                setError(concurrentGenerationsCapMsg(uiLang));
                return;
              }
              setModalOpen(true);
            }}
          >
            <Bi text="Generate script / 生成剧本" />
          </button>
        </div>
      )}

      {page === "generate" && script && (
        <section className="script-output">
          <h2>
            <Bi text="Generated script / 已生成剧本" />
          </h2>
          <div className="script-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownloadPdfEn}
              disabled={downloading !== null}
            >
              {downloading === "en"
                ? "Preparing English PDF…"
                : biText(uiLang, "Download English PDF / 下载英文 PDF")}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDownloadPdfZh}
              disabled={!script || translating || downloading !== null}
            >
              {downloading === "zh"
                ? "Preparing Chinese PDF…"
                : biText(uiLang, "Download Chinese PDF / 下载中文 PDF")}
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
                {pickLang(
                  uiLang,
                  `Translating episode ${progress.episode} of ${progress.total}`,
                  `翻译第 ${progress.episode} 集`
                )}
              </p>
            </div>
          )}
          <pre className="script-text">
            {prepareEnglishScriptForDisplay(script)}
          </pre>
          {scriptZh ? (
            <>
              <h3 className="script-zh-title">
                <Bi text="Simplified Chinese / 简体中文" />
              </h3>
              <pre className="script-text script-text-zh">
                {prepareChineseScriptLikePdfInput(scriptZh)}
              </pre>
            </>
          ) : null}
        </section>
      )}

      <footer className="footer">
        <div className="ip-note">
          <p className="ip-note-en bilingual-en">
            Per our founding document, we will never claim ownership of the IP in scripts
            generated using this software. After generation, each script belongs to you, the user.
          </p>
          <p className="ip-note-zh bilingual-zh">
            本平台创始文档明确：Vertical Infinite 不会主张对通过本软件生成之剧本内容的知识产权。每一份生成后的剧本均归生成该剧本的用户所有。
          </p>
          <p className="ip-note-en" style={{ marginTop: "0.5rem" }}>
            Customer Support Contact = <strong>verticalinfinite@proton.me</strong>
          </p>
        </div>
      </footer>

      {cancelSubModal ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (cancelSubLoading) return;
            setCancelSubModal(null);
            setCancelDonePeriodEnd(null);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            {cancelSubModal === "noStripe" ? (
              <>
                <h2 className="modal-title">
                  <Bi text="No Stripe subscription / 无 Stripe 订阅" />
                </h2>
                <p className="bilingual-en" style={{ marginTop: 0, lineHeight: 1.55 }}>
                  This account doesn’t have an active Stripe subscription to cancel. If you were upgraded manually for
                  testing, use the Owner tab to switch back to Free.
                </p>
                <p className="bilingual-zh" style={{ marginTop: "0.65rem", lineHeight: 1.55, opacity: 0.95 }}>
                  当前账号没有可取消的 Stripe 订阅。若这是为了测试手动升级，请在 Owner 页将档位切回免费档。
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setCancelSubModal(null);
                      setError("");
                    }}
                  >
                    <Bi text="OK / 确定" />
                  </button>
                </div>
              </>
            ) : cancelSubModal === "confirm" ? (
              <>
                <h2 className="modal-title">
                  <Bi text="Cancel subscription? / 取消订阅？" />
                </h2>
                <p className="bilingual-en" style={{ marginTop: 0, lineHeight: 1.55 }}>
                  Are you sure you want to cancel? Your subscription will not auto-renew, but you will keep your
                  current plan benefits until the end of the billing period you already paid for.
                </p>
                <p className="bilingual-zh" style={{ marginTop: "0.65rem", lineHeight: 1.55, opacity: 0.95 }}>
                  确定要取消吗？取消后<strong>不会自动续费</strong>；在当前已付费的计费周期结束前，您仍可继续使用当前档位权益。
                </p>
                {error ? (
                  <p className="error" style={{ marginTop: "0.75rem" }}>
                    <Bi text="Error / 错误" />: {error}
                  </p>
                ) : null}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={cancelSubLoading}
                    onClick={() => {
                      setCancelSubModal(null);
                      setError("");
                    }}
                  >
                    <Bi text="Back / 返回" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={cancelSubLoading}
                    onClick={() => void confirmCancelSubscription()}
                  >
                    {cancelSubLoading ? (
                      <Bi text="Working… / 处理中…" />
                    ) : (
                      <Bi text="Yes, cancel / 确认取消" />
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="modal-title">
                  <Bi text="Subscription updated / 订阅已更新" />
                </h2>
                <p className="bilingual-en" style={{ marginTop: 0, lineHeight: 1.55 }}>
                  Your plan will <strong>not auto-renew</strong>. You will keep access to your subscription features
                  until the end of your current paid period
                  {cancelDonePeriodEnd || meSubscriptionPeriodEnd
                    ? ` (${new Date(cancelDonePeriodEnd || meSubscriptionPeriodEnd).toLocaleString()})`
                    : ""}
                  .
                </p>
                <p className="bilingual-zh" style={{ marginTop: "0.65rem", lineHeight: 1.55, opacity: 0.95 }}>
                  您的套餐<strong>到期后将不会自动续费</strong>。在当前已付费周期结束前，您仍可继续使用订阅权益
                  {cancelDonePeriodEnd || meSubscriptionPeriodEnd
                    ? `（约至 ${new Date(cancelDonePeriodEnd || meSubscriptionPeriodEnd).toLocaleString()}）`
                    : ""}
                  。
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setCancelSubModal(null);
                      setCancelDonePeriodEnd(null);
                      setError("");
                    }}
                  >
                    <Bi text="OK / 确定" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {deletePromptItem && (
        <div
          className="modal-backdrop"
          onClick={() => deletingId == null && setDeletePromptItem(null)}
        >
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">
              <Bi text="Delete script / 删除剧本" />
            </h2>
            <p className="bilingual-en" style={{ marginTop: 0, lineHeight: 1.5 }}>
              Are you sure you want to delete this script?
            </p>
            <p className="bilingual-zh" style={{ marginTop: "0.5rem", lineHeight: 1.5, opacity: 0.95 }}>
              您确定要删除此剧本吗？
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deletingId != null}
                onClick={() => setDeletePromptItem(null)}
              >
                <Bi text="Cancel / 取消" />
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deletingId != null}
                onClick={() => void confirmDeleteScript()}
              >
                <Bi text="Delete / 删除" />
              </button>
            </div>
          </div>
        </div>
      )}

      {page === "generate" && modalOpen && (
        <div className="modal-backdrop" onClick={() => !loading && setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">
              <Bi text="New script / 新剧本" />
            </h2>
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
                        ? pickLang(
                            uiLang,
                            `Translating episode ${progress.episode} of ${progress.total}`,
                            `翻译第 ${progress.episode} 集`
                          )
                        : progress.episode > 0
                          ? pickLang(
                              uiLang,
                              `Generating episode ${progress.episode} of ${progress.total}`,
                              `生成第 ${progress.episode} 集`
                            )
                          : pickLang(uiLang, "Starting…", "启动中…")}
                    </p>
                  </div>
                )}
              </>
            )}
            <form onSubmit={handleSubmit}>
              <label className="field">
                <span>
                  <Bi text="Genre / 类型" />
                </span>
                <select
                  value={genre}
                  onChange={(e) => {
                    setGenre(e.target.value);
                  }}
                >
                  <option value="">{biText(uiLang, "— Select a genre / 请选择类型 —")}</option>
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
                    const label = biText(uiLang, labelMap[g] || g);
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
                  <Bi text="A full 60-episode vertical script will be generated in your chosen genre. / 将根据您所选类型生成完整的 60 集垂直剧本。" />
                </p>
              )}
              {error && (
                <p className="error">
                  <Bi text="Error / 错误" />: {error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => !loading && setModalOpen(false)}
                  disabled={loading}
                >
                  <Bi text="Cancel / 取消" />
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
                      ? pickLang(
                          uiLang,
                          `Episode ${progress.episode}/${progress.total}`,
                          `生成中 ${progress.episode}/${progress.total}`
                        )
                      : pickLang(uiLang, "Generating…", "正在生成…")
                    : biText(uiLang, "Generate / 生成")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </div>
    </UiLangContext.Provider>
  );
}

export default App;
