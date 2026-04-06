import { useCallback, useEffect, useState } from "react";

function adminMoney(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "—";
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export default function AdminDashboard({ API_BASE, authToken, adminEmail }) {
  const [tab, setTab] = useState("users");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const adminFetch = useCallback(
    async (path, options = {}) => {
      const r = await fetch(`${API_BASE}/admin${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...options.headers,
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
      return data;
    },
    [API_BASE, authToken]
  );

  const run = async (fn) => {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // —— User management ——
  const [userQ, setUserQ] = useState("");
  const [users, setUsers] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [scripts, setScripts] = useState([]);

  const loadUsers = () =>
    run(async () => {
      const q = encodeURIComponent(userQ.trim());
      const d = await adminFetch(`/users?limit=80&q=${q}`);
      setUsers(d.users || []);
    });

  const loadDetail = (id) =>
    run(async () => {
      const uid = id || selectedId;
      if (!uid) return;
      const d = await adminFetch(`/users/${encodeURIComponent(uid)}`);
      setDetail(d.user);
      const s = await adminFetch(`/users/${encodeURIComponent(uid)}/scripts?limit=50`);
      setScripts(s.scripts || []);
    });

  useEffect(() => {
    if (tab === "users") loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [newPwd, setNewPwd] = useState("");
  const [extendDays, setExtendDays] = useState("30");
  const [creditDelta, setCreditDelta] = useState("1");
  const [freeGenCount, setFreeGenCount] = useState("1");
  const [finUserId, setFinUserId] = useState("");
  const [finAmount, setFinAmount] = useState("2500");
  const [finDesc, setFinDesc] = useState("");

  // —— Generation tab ——
  const [activeGens, setActiveGens] = useState([]);
  const [failedGens, setFailedGens] = useState([]);

  const loadGenerations = () =>
    run(async () => {
      const [a, f] = await Promise.all([
        adminFetch("/generations/active"),
        adminFetch("/generations/failed?limit=80"),
      ]);
      setActiveGens(a.scripts || []);
      setFailedGens(f.scripts || []);
    });

  useEffect(() => {
    if (tab === "generations") loadGenerations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // —— Financial ——
  const [revFrom, setRevFrom] = useState("");
  const [revTo, setRevTo] = useState("");
  const [revenue, setRevenue] = useState(null);
  const [subscriptions, setSubscriptions] = useState(null);
  const [churn, setChurn] = useState(null);
  const [invoices, setInvoices] = useState([]);

  const loadFinancial = () =>
    run(async () => {
      const qs =
        revFrom || revTo
          ? `?from=${encodeURIComponent(revFrom)}&to=${encodeURIComponent(revTo)}`
          : "";
      const [rev, sub, ch, inv] = await Promise.all([
        adminFetch(`/financial/revenue${qs}`),
        adminFetch("/financial/subscriptions"),
        adminFetch("/financial/churn"),
        adminFetch("/financial/invoices"),
      ]);
      setRevenue(rev);
      setSubscriptions(sub);
      setChurn(ch);
      setInvoices(inv.invoices || []);
    });

  useEffect(() => {
    if (tab === "financial") loadFinancial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // —— Health + analytics ——
  const [health, setHealth] = useState(null);
  const [genres, setGenres] = useState([]);
  const [conversion, setConversion] = useState(null);
  const [retention, setRetention] = useState(null);

  const loadHealth = () =>
    run(async () => {
      const d = await adminFetch("/health");
      setHealth(d);
    });
  const loadAnalytics = () =>
    run(async () => {
      const [g, c, r] = await Promise.all([
        adminFetch("/analytics/genres"),
        adminFetch("/analytics/conversion"),
        adminFetch("/analytics/retention"),
      ]);
      setGenres(g.genres || []);
      setConversion(c);
      setRetention(r);
    });

  useEffect(() => {
    if (tab === "health") loadHealth();
    if (tab === "analytics") loadAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const tabBtn = (id, label) => (
    <button
      type="button"
      className={tab === id ? "btn btn-primary" : "btn btn-secondary"}
      style={{ borderRadius: 6, fontSize: "0.85rem" }}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <section className="script-output page-panel admin-dashboard" style={{ maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>Admin / 管理</h2>
      {adminEmail ? (
        <p style={{ opacity: 0.9, marginTop: "-0.15rem" }}>
          Signed in as <strong>{adminEmail}</strong>
        </p>
      ) : null}
      <p className="script-output-hint" style={{ marginTop: "-0.35rem" }}>
        Operator console. Payment is not live — financial rows are manual ledger entries. Generation stats come from
        saved scripts and in‑process queue state.
      </p>

      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        {tabBtn("users", "User management")}
        {tabBtn("generations", "Generation management")}
        {tabBtn("financial", "Financial")}
        {tabBtn("health", "System health")}
        {tabBtn("analytics", "Analytics")}
      </div>

      {msg ? <p className="script-output-hint">{msg}</p> : null}
      {err ? <p className="error">{err}</p> : null}

      {tab === "users" && (
        <div className="admin-section">
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.75rem" }}>
            <input
              className="field-input-like"
              placeholder="Search email…"
              value={userQ}
              onChange={(e) => setUserQ(e.target.value)}
              style={{ minWidth: 220, padding: "0.45rem 0.6rem", borderRadius: 6 }}
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={loadUsers}>
              Search / Refresh
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(200px,1fr) minmax(320px,2fr)", gap: "1rem" }}>
            <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--steel-light)", borderRadius: 8, padding: "0.5rem" }}>
              {(users || []).map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(String(u.id));
                    setDetail(null);
                    run(async () => {
                      const d = await adminFetch(`/users/${u.id}`);
                      setDetail(d.user);
                      const s = await adminFetch(`/users/${u.id}/scripts?limit=50`);
                      setScripts(s.scripts || []);
                    });
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "0.35rem 0.5rem",
                    marginBottom: 4,
                    borderRadius: 6,
                    border: selectedId === String(u.id) ? "2px solid var(--blood-pale)" : "1px solid transparent",
                    background: "rgba(26,26,29,0.45)",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{u.email}</div>
                  <div style={{ fontSize: "0.8rem", opacity: 0.85 }}>
                    #{u.id} · {u.plan_slug}
                    {u.account_suspended ? " · SUSPENDED" : ""}
                  </div>
                </button>
              ))}
            </div>
            <div>
              {!detail ? (
                <p style={{ opacity: 0.85 }}>Select a user.</p>
              ) : (
                <>
                  <h3 style={{ marginTop: 0 }}>Profile</h3>
                  <ul style={{ lineHeight: 1.6, opacity: 0.95, fontSize: "0.9rem" }}>
                    <li>
                      <strong>Email:</strong> {detail.email}
                    </li>
                    <li>
                      <strong>Plan:</strong> {detail.plan_slug}
                    </li>
                    <li>
                      <strong>Credits:</strong> {detail.generation_credits ?? 0}
                    </li>
                    <li>
                      <strong>Trial ends:</strong> {detail.trial_ends_at ? new Date(detail.trial_ends_at).toLocaleString() : "—"}
                    </li>
                    <li>
                      <strong>Subscription ends:</strong>{" "}
                      {detail.subscription_ends_at ? new Date(detail.subscription_ends_at).toLocaleString() : "—"}
                    </li>
                    <li>
                      <strong>Scripts (count):</strong> {detail.scriptsCount}
                    </li>
                    <li>
                      <strong>Suspended:</strong> {detail.account_suspended ? "yes" : "no"}
                    </li>
                  </ul>

                  <h4>Billing history (ledger)</h4>
                  <div style={{ maxHeight: 160, overflow: "auto", fontSize: "0.82rem", marginBottom: "0.75rem" }}>
                    {(detail.billingHistory || []).length === 0 ? (
                      <span style={{ opacity: 0.8 }}>No ledger rows.</span>
                    ) : (
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th>Type</th>
                            <th>Amount</th>
                            <th>When</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(detail.billingHistory || []).map((row) => (
                            <tr key={row.id}>
                              <td>{row.entry_type}</td>
                              <td>{adminMoney(row.amount_cents)}</td>
                              <td>{new Date(row.created_at).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <h4>Actions</h4>
                  <div className="admin-actions-grid">
                    <div className="admin-action-card">
                      <div className="admin-action-title">Free trial</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[7, 14, 30].map((d) => (
                          <button
                            key={d}
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await adminFetch(`/users/${detail.id}/trial`, {
                                  method: "POST",
                                  body: JSON.stringify({ days: d }),
                                });
                                setMsg(`Trial set: ${d} days from now.`);
                                loadDetail(detail.id);
                              })
                            }
                          >
                            {d}d
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Plan</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {["free", "starter", "professional"].map((p) => (
                          <button
                            key={p}
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await adminFetch(`/users/${detail.id}/plan`, {
                                  method: "POST",
                                  body: JSON.stringify({ planSlug: p }),
                                });
                                setMsg(`Plan → ${p}`);
                                loadDetail(detail.id);
                              })
                            }
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Extend subscription (days)</div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          value={extendDays}
                          onChange={(e) => setExtendDays(e.target.value)}
                          type="number"
                          min={1}
                          style={{ width: 72, padding: "0.35rem" }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/subscription-extend`, {
                                method: "POST",
                                body: JSON.stringify({ days: Number(extendDays) || 30 }),
                              });
                              setMsg("Subscription extended.");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Free generations (credits)</div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          value={freeGenCount}
                          onChange={(e) => setFreeGenCount(e.target.value)}
                          type="number"
                          min={1}
                          style={{ width: 56, padding: "0.35rem" }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/apply-free-generation`, {
                                method: "POST",
                                body: JSON.stringify({ count: Number(freeGenCount) || 1 }),
                              });
                              setMsg("Credits added.");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/refund-generation-credit`, { method: "POST", body: "{}" });
                              setMsg("+1 credit refund.");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Refund 1 credit
                        </button>
                      </div>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Adjust credits (delta)</div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          value={creditDelta}
                          onChange={(e) => setCreditDelta(e.target.value)}
                          type="number"
                          style={{ width: 72, padding: "0.35rem" }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/generation-credits`, {
                                method: "POST",
                                body: JSON.stringify({ delta: Number(creditDelta) || 0 }),
                              });
                              setMsg("Credits updated.");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Suspend / reactivate</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/suspend`, {
                                method: "POST",
                                body: JSON.stringify({ suspended: true }),
                              });
                              setMsg("User suspended.");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Suspend
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/suspend`, {
                                method: "POST",
                                body: JSON.stringify({ suspended: false }),
                              });
                              setMsg("User reactivated.");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Reactivate
                        </button>
                      </div>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Force logout (all devices)</div>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await adminFetch(`/users/${detail.id}/force-logout`, { method: "POST", body: "{}" });
                            setMsg("Sessions invalidated (token version bumped).");
                            loadDetail(detail.id);
                          })
                        }
                      >
                        Invalidate JWTs
                      </button>
                    </div>
                    <div className="admin-action-card">
                      <div className="admin-action-title">Reset password</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={newPwd}
                          onChange={(e) => setNewPwd(e.target.value)}
                          placeholder="New password (8+ chars)"
                          style={{ flex: "1 1 180px", minWidth: 160, padding: "0.35rem" }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || newPwd.length < 8}
                          onClick={() =>
                            run(async () => {
                              await adminFetch(`/users/${detail.id}/reset-password`, {
                                method: "POST",
                                body: JSON.stringify({ newPassword: newPwd }),
                              });
                              setMsg("Password reset.");
                              setNewPwd("");
                              loadDetail(detail.id);
                            })
                          }
                        >
                          Set password
                        </button>
                      </div>
                    </div>
                    <div className="admin-action-card admin-action-danger">
                      <div className="admin-action-title">Delete account</div>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Permanently delete ${detail.email} and all scripts?`)) return;
                          run(async () => {
                            await adminFetch(`/users/${detail.id}`, { method: "DELETE" });
                            setMsg("User deleted.");
                            setDetail(null);
                            setSelectedId("");
                            loadUsers();
                          });
                        }}
                      >
                        Delete user
                      </button>
                    </div>
                  </div>

                  <h4>Generation history (this user)</h4>
                  <div style={{ maxHeight: 220, overflow: "auto", fontSize: "0.82rem" }}>
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Genre</th>
                          <th>Progress</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(scripts || []).map((s) => (
                          <tr key={s.id}>
                            <td>{s.status}</td>
                            <td>{s.genre}</td>
                            <td>
                              {s.episode_done}/{s.episode_target}
                            </td>
                            <td>{new Date(s.updated_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "generations" && (
        <div className="admin-section">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={loadGenerations} style={{ marginBottom: "0.75rem" }}>
            Refresh queue & failures
          </button>
          <h3 style={{ marginTop: 0 }}>Active / queued (status = generating)</h3>
          <p className="script-output-hint" style={{ marginTop: "-0.25rem" }}>
            Rows may be stale after a deploy until marked failed by startup cleanup.
          </p>
          <div style={{ overflow: "auto", marginBottom: "1.25rem" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Genre</th>
                  <th>Progress</th>
                  <th>Script</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(activeGens || []).map((s) => (
                  <tr key={s.id}>
                    <td>{s.user_email}</td>
                    <td>{s.genre}</td>
                    <td>
                      {s.episode_done}/{s.episode_target}
                    </td>
                    <td style={{ fontSize: "0.75rem", maxWidth: 200, wordBreak: "break-all" }}>{s.id}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await adminFetch(`/generations/${s.id}/cancel`, {
                              method: "POST",
                              body: JSON.stringify({ reason: "Cancelled from admin." }),
                            });
                            setMsg("Generation marked failed / cancelled.");
                            loadGenerations();
                          })
                        }
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Failed (with error message)</h3>
          <div style={{ overflow: "auto", maxHeight: 360 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Genre</th>
                  <th>Error</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {(failedGens || []).map((s) => (
                  <tr key={s.id}>
                    <td>{s.user_email}</td>
                    <td>{s.genre}</td>
                    <td style={{ maxWidth: 360, fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>{s.error_message}</td>
                    <td>{new Date(s.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "financial" && revenue && (
        <div className="admin-section">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={loadFinancial} style={{ marginBottom: "0.75rem" }}>
            Refresh
          </button>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem", alignItems: "center" }}>
            <label style={{ fontSize: "0.85rem" }}>
              From{" "}
              <input value={revFrom} onChange={(e) => setRevFrom(e.target.value)} type="date" style={{ marginLeft: 4 }} />
            </label>
            <label style={{ fontSize: "0.85rem" }}>
              To{" "}
              <input value={revTo} onChange={(e) => setRevTo(e.target.value)} type="date" style={{ marginLeft: 4 }} />
            </label>
          </div>
          <h3 style={{ marginTop: 0 }}>Revenue (manual ledger)</h3>
          <p style={{ opacity: 0.9 }}>Total: {adminMoney(revenue.totalRevenueCents)} — {revenue.note}</p>
          <ul>
            {(revenue.byTier || []).map((t) => (
              <li key={t.tier_slug || "none"}>
                Tier {t.tier_slug || "(none)"}: {adminMoney(t.total_cents)}
              </li>
            ))}
          </ul>
          <h3>Churn (activity proxy)</h3>
          <pre style={{ fontSize: "0.82rem", opacity: 0.9, whiteSpace: "pre-wrap" }}>{JSON.stringify(churn, null, 2)}</pre>
          <h3>Subscriptions by tier</h3>
          <pre style={{ fontSize: "0.82rem", opacity: 0.9, whiteSpace: "pre-wrap" }}>{JSON.stringify(subscriptions, null, 2)}</pre>
          <h3>Outstanding invoices</h3>
          {(invoices || []).length === 0 ? (
            <p style={{ opacity: 0.85 }}>None. Create via “New invoice” below.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Amount</th>
                  <th>Desc</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td>{adminMoney(inv.amount_cents)}</td>
                    <td>{inv.description}</td>
                    <td>{new Date(inv.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>Manual refund</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              placeholder="user id"
              value={finUserId}
              onChange={(e) => setFinUserId(e.target.value)}
              style={{ width: 80, padding: "0.35rem" }}
            />
            <input
              placeholder="amount (cents)"
              value={finAmount}
              onChange={(e) => setFinAmount(e.target.value)}
              style={{ width: 120, padding: "0.35rem" }}
            />
            <input
              placeholder="description"
              value={finDesc}
              onChange={(e) => setFinDesc(e.target.value)}
              style={{ flex: "1 1 160px", minWidth: 140, padding: "0.35rem" }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await adminFetch("/financial/manual-refund", {
                    method: "POST",
                    body: JSON.stringify({
                      userId: finUserId ? Number(finUserId) : null,
                      amountCents: Number(finAmount) || 0,
                      description: finDesc || "Refund",
                    }),
                  });
                  setMsg("Refund recorded.");
                  loadFinancial();
                })
              }
            >
              Record refund
            </button>
          </div>
          <h3 style={{ marginTop: "1rem" }}>Record revenue (manual)</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await adminFetch("/financial/record-revenue", {
                    method: "POST",
                    body: JSON.stringify({
                      userId: finUserId ? Number(finUserId) : null,
                      amountCents: Number(finAmount) || 0,
                      description: finDesc || "Revenue",
                    }),
                  });
                  setMsg("Revenue recorded.");
                  loadFinancial();
                })
              }
            >
              Record revenue
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!finUserId) throw new Error("user id required for invoice");
                  await adminFetch("/financial/invoice", {
                    method: "POST",
                    body: JSON.stringify({
                      userId: Number(finUserId),
                      amountCents: Number(finAmount) || 0,
                      description: finDesc || "Invoice",
                    }),
                  });
                  setMsg("Invoice created (open).");
                  loadFinancial();
                })
              }
            >
              New invoice
            </button>
          </div>
        </div>
      )}

      {tab === "financial" && !revenue && <p style={{ opacity: 0.85 }}>Loading…</p>}

      {tab === "health" && health && (
        <div className="admin-section">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={loadHealth} style={{ marginBottom: "0.75rem" }}>
            Refresh
          </button>
          <ul style={{ lineHeight: 1.75 }}>
            <li>
              <strong>Active concurrent generations:</strong> {health.activeConcurrentGenerations}
            </li>
            <li>
              <strong>Failed rate</strong> (failed / (failed+complete)):{" "}
              {health.failedGenerationRate != null ? `${(health.failedGenerationRate * 100).toFixed(1)}%` : "—"}
            </li>
            <li>
              <strong>Avg complete generation time:</strong>{" "}
              {health.averageCompleteGenerationSeconds != null
                ? `${(health.averageCompleteGenerationSeconds / 60).toFixed(1)} min`
                : "—"}
            </li>
            <li>
              <strong>Status breakdown:</strong> {JSON.stringify(health.statusBreakdown)}
            </li>
            <li>
              <strong>OpenAI spend estimate (env cents/mo):</strong>{" "}
              {health.openaiSpendCentsMonthlyEstimate != null ? health.openaiSpendCentsMonthlyEstimate : "not set"}
            </li>
            <li>
              <strong>Revenue (30d, ledger):</strong> {adminMoney(health.estimatedRevenueLast30dCents)}
            </li>
            <li style={{ opacity: 0.9 }}>{health.spendVsRevenueHint}</li>
            <li style={{ opacity: 0.9 }}>{health.openaiVsRevenueNote}</li>
          </ul>
        </div>
      )}
      {tab === "health" && !health && <p style={{ opacity: 0.85 }}>Loading…</p>}

      {tab === "analytics" && conversion && (
        <div className="admin-section">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={loadAnalytics} style={{ marginBottom: "0.75rem" }}>
            Refresh
          </button>
          <h3 style={{ marginTop: 0 }}>Top genres</h3>
          <ul>
            {genres.map((g) => (
              <li key={g.genre}>
                {g.genre}: {g.cnt}
              </li>
            ))}
          </ul>
          <h3>Trial → paid (heuristic)</h3>
          <pre style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>{JSON.stringify(conversion, null, 2)}</pre>
          <h3>Retention by tier (proxy)</h3>
          <pre style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>{JSON.stringify(retention, null, 2)}</pre>
        </div>
      )}
      {tab === "analytics" && !conversion && <p style={{ opacity: 0.85 }}>Loading…</p>}
    </section>
  );
}
