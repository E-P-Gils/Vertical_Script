import "./TermsAndConditions.css";

/**
 * Standalone legal page for Paddle / checkout.
 * Served at /terms-and-conditions when the host uses SPA fallback (index.html for all routes).
 * If this URL 404s on deploy, add a static rewrite so /terms-and-conditions serves index.html.
 */
export default function TermsAndConditions() {
  return (
    <div className="terms-page">
      <div className="terms-inner">
        <h1>Vertical Infinite</h1>
        <p className="terms-lead">
          Terms &amp; conditions (for checkout and Paddle merchant review)
        </p>

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
            Per our founding document, we will never claim ownership of the IP in scripts generated
            using this software. After generation, each script belongs to you, the user.
          </p>
        </section>

        <section className="terms-block" aria-labelledby="support-heading">
          <h2 id="support-heading">Customer support</h2>
          <p>
            Email:{" "}
            <a href="mailto:verticalinfinite@proton.me">verticalinfinite@proton.me</a>
          </p>
        </section>

        <a className="terms-back" href="/">
          ← Back to app
        </a>
      </div>
    </div>
  );
}
