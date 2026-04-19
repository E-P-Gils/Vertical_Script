import "./TermsAndConditions.css";

function TermsBlocks() {
  return (
    <>
      <section className="terms-block" aria-labelledby="refunds-heading">
        <h2 id="refunds-heading">Refund policy</h2>
        <p>
          <strong>Subscriptions:</strong> You may contact us to request a refund within{" "}
          <strong>7 days</strong> of your first subscription payment, and within{" "}
          <strong>2 days</strong> of each renewal payment after that.
        </p>
      </section>

      <section className="terms-block" aria-labelledby="ip-heading">
        <h2 id="ip-heading">Intellectual property (scripts you generate)</h2>
        <p>
          Per our founding document, we will never claim ownership of the IP in scripts generated using
          this software. After generation, each script belongs to you, the user.
        </p>
      </section>

      <section className="terms-block" aria-labelledby="support-heading">
        <h2 id="support-heading">Customer support</h2>
        <p>
          Email:{" "}
          <a href="mailto:verticalinfinite@proton.me">verticalinfinite@proton.me</a>
        </p>
      </section>
    </>
  );
}

/** Terms content embedded in the main app (Pricing-style panel). */
export function TermsAndConditionsPanel({ onBack }) {
  return (
    <section className="script-output pricing-panel" style={{ maxWidth: 720 }}>
      <h2 className="pricing-title" style={{ textAlign: "center" }}>
        Terms &amp; conditions
      </h2>
      <p className="script-output-hint pricing-hint" style={{ textAlign: "center", marginBottom: "1rem" }}>
        For checkout and Paddle merchant review / 结账与商户审核用条款
      </p>
      <TermsBlocks />
      <div style={{ display: "flex", justifyContent: "center", marginTop: "1.25rem" }}>
        <button type="button" className="btn btn-primary" onClick={onBack}>
          Back to home / 返回首页
        </button>
      </div>
    </section>
  );
}
