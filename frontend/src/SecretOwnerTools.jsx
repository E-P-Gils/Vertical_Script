import { useState } from "react";

export default function SecretOwnerTools({ API_BASE, authToken, onAfterGrant }) {
  const [email, setEmail] = useState("");
  const [delta, setDelta] = useState("1");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setMsg("");
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/owner/grant-script-credits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
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

  return (
    <section className="script-output page-panel" style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Owner / 站长</h2>
      <p style={{ marginTop: 0, lineHeight: 1.55, opacity: 0.95 }}>
        Grant script credits to a user by email. / 按邮箱为用户增加剧本额度。
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
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
          <input
            type="text"
            inputMode="numeric"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
          />
        </label>
        {err ? <p className="error">Error / 错误: {err}</p> : null}
        {msg ? <p style={{ margin: 0, lineHeight: 1.5 }}>{msg}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={loading || !email.trim()}>
          {loading ? "Saving… / 保存中…" : "Grant credits / 发放额度"}
        </button>
      </form>
    </section>
  );
}
