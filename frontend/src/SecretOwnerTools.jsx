import { useState } from "react";

const PLAN_OPTIONS = [
  { value: "none", label: "None (free) / 无（免费档）" },
  { value: "starter", label: "Starter / 入门" },
  { value: "professional", label: "Professional / 专业" },
  { value: "business", label: "Business / 商务" },
];

export default function SecretOwnerTools({ API_BASE, authToken, onAfterGrant }) {
  const [email, setEmail] = useState("");
  const [delta, setDelta] = useState("1");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const [lookupEmail, setLookupEmail] = useState("");
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const [tierEmail, setTierEmail] = useState("");
  const [tierChoice, setTierChoice] = useState("none");
  const [tierLoading, setTierLoading] = useState(false);

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };

  const submitCredits = async (e) => {
    e.preventDefault();
    setErr("");
    setMsg("");
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/owner/grant-script-credits`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          email: email.trim(),
          delta: Number(delta),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(d.error || "Request failed");
      }
      setMsg(
        `OK — ${d.user?.email} now has ${d.user?.scriptCredits} script credit(s). / 已更新：${d.user?.email} 当前额度 ${d.user?.scriptCredits}。`
      );
      onAfterGrant?.();
    } catch (e2) {
      setErr(String(e2?.message || e2 || "Failed"));
    } finally {
      setLoading(false);
    }
  };

  const runLookup = async () => {
    setErr("");
    setMsg("");
    setLookupResult(null);
    const q = lookupEmail.trim();
    if (!q) {
      setErr("Enter an email for lookup. / 请输入要查询的邮箱。");
      return;
    }
    setLookupLoading(true);
    try {
      const r = await fetch(`${API_BASE}/owner/user-plan?email=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(d.error || "Lookup failed");
      }
      setLookupResult(d.user);
      setMsg("Plan lookup loaded. / 已加载套餐信息。");
    } catch (e2) {
      setErr(String(e2?.message || e2 || "Lookup failed"));
    } finally {
      setLookupLoading(false);
    }
  };

  const runSetTier = async (e) => {
    e.preventDefault();
    setErr("");
    setMsg("");
    const q = tierEmail.trim();
    if (!q) {
      setErr("Enter an email for plan change. / 请输入要修改套餐的邮箱。");
      return;
    }
    setTierLoading(true);
    try {
      const r = await fetch(`${API_BASE}/owner/set-plan-tier`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ email: q, planTier: tierChoice }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(d.error || "Update failed");
      }
      setMsg(
        `Plan set to "${d.user?.planTier}" for ${d.user?.email}. / 已将 ${d.user?.email} 设为「${d.user?.planTier}」档位。`
      );
      onAfterGrant?.();
      if (lookupEmail.trim().toLowerCase() === q.toLowerCase()) {
        setLookupResult((prev) =>
          prev && prev.email && prev.email.toLowerCase() === q.toLowerCase()
            ? { ...prev, planTier: d.user?.planTier }
            : prev
        );
      }
    } catch (e2) {
      setErr(String(e2?.message || e2 || "Update failed"));
    } finally {
      setTierLoading(false);
    }
  };

  return (
    <section className="script-output page-panel" style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>Owner / 站长</h2>
      <p style={{ marginTop: 0, lineHeight: 1.55, opacity: 0.95 }}>
        Script credits, plan lookup, and plan tier overrides (vertical_script <code>plan_tier</code>). / 剧本额度、套餐查询与档位覆盖。
      </p>

      <form onSubmit={submitCredits} style={{ display: "flex", flexDirection: "column", gap: "0.85rem", marginBottom: "1.75rem" }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>Grant script credits / 发放剧本额度</h3>
        <label className="field">
          <span>User email / 用户邮箱</span>
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
        </label>
        <label className="field">
          <span>Credits to add (integer; can be negative) / 增加额度（整数，可为负）</span>
          <input type="text" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={loading || !email.trim()}>
          {loading ? "Saving… / 保存中…" : "Grant credits / 发放额度"}
        </button>
      </form>

      <div style={{ borderTop: "1px solid var(--steel-light)", paddingTop: "1.25rem", marginBottom: "1.75rem" }}>
        <h3 style={{ margin: "0 0 0.65rem", fontSize: "1.05rem" }}>Look up plan / 查询套餐</h3>
        <p style={{ margin: "0 0 0.75rem", lineHeight: 1.5, opacity: 0.92, fontSize: "0.9rem" }}>
          Shows <code>plan_tier</code> (free / starter / professional / business), script credits, and Stripe ids if any. /
          显示当前档位、额度与 Stripe 订阅信息（若有）。
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="email"
            className="field-input-like"
            placeholder="user@example.com"
            value={lookupEmail}
            onChange={(e) => setLookupEmail(e.target.value)}
            style={{ flex: "1 1 220px", minWidth: 200, padding: "0.45rem 0.6rem", borderRadius: 6 }}
          />
          <button type="button" className="btn btn-secondary" disabled={lookupLoading} onClick={() => void runLookup()}>
            {lookupLoading ? "Loading… / 查询中…" : "Look up / 查询"}
          </button>
        </div>
        {lookupResult ? (
          <ul
            style={{
              margin: "0.85rem 0 0",
              padding: "0.75rem 1rem",
              lineHeight: 1.65,
              fontSize: "0.88rem",
              borderRadius: 8,
              border: "1px solid var(--steel-light)",
              background: "rgba(26,26,29,0.45)",
              listStyle: "none",
            }}
          >
            <li>
              <strong>Email:</strong> {lookupResult.email}
            </li>
            <li>
              <strong>User id:</strong> {lookupResult.id}
            </li>
            <li>
              <strong>Plan tier:</strong> {lookupResult.planTier}
            </li>
            <li>
              <strong>Script credits:</strong> {lookupResult.scriptCredits}
            </li>
            <li>
              <strong>Stripe customer:</strong> {lookupResult.stripeCustomerId ?? "—"}
            </li>
            <li>
              <strong>Stripe subscription:</strong> {lookupResult.stripeSubscriptionId ?? "—"}
            </li>
            <li>
              <strong>Cancel at period end:</strong> {lookupResult.subscriptionCancelAtPeriodEnd ? "yes" : "no"}
            </li>
            <li>
              <strong>Current period ends:</strong>{" "}
              {lookupResult.subscriptionCurrentPeriodEnd
                ? new Date(lookupResult.subscriptionCurrentPeriodEnd).toLocaleString()
                : "—"}
            </li>
          </ul>
        ) : null}
      </div>

      <div style={{ borderTop: "1px solid var(--steel-light)", paddingTop: "1.25rem" }}>
        <h3 style={{ margin: "0 0 0.65rem", fontSize: "1.05rem" }}>Set plan tier / 设置档位</h3>
        <p style={{ margin: "0 0 0.75rem", lineHeight: 1.5, opacity: 0.92, fontSize: "0.9rem" }}>
          Updates <code>plan_tier</code> only (does not cancel Stripe). Use <strong>None</strong> for the free tier. /
          仅更新数据库档位；不取消 Stripe 订阅。选「None」即免费档。
        </p>
        <form onSubmit={runSetTier} style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <label className="field">
            <span>User email / 用户邮箱</span>
            <input
              type="email"
              autoComplete="off"
              value={tierEmail}
              onChange={(e) => setTierEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </label>
          <label className="field">
            <span>Plan / 档位</span>
            <select value={tierChoice} onChange={(e) => setTierChoice(e.target.value)}>
              {PLAN_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={tierLoading || !tierEmail.trim()}>
            {tierLoading ? "Applying… / 应用中…" : "Apply plan tier / 应用档位"}
          </button>
        </form>
      </div>

      {err ? <p className="error" style={{ marginTop: "1rem" }}>Error / 错误: {err}</p> : null}
      {msg ? (
        <p style={{ margin: "1rem 0 0", lineHeight: 1.5 }} className="script-output-hint">
          {msg}
        </p>
      ) : null}
    </section>
  );
}
