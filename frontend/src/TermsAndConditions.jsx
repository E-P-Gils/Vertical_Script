import "./TermsAndConditions.css";

function pickLang(lang, en, zh) {
  return lang === "zh" ? zh : en;
}

function TermsBlocks({ uiLang }) {
  const zh = uiLang === "zh";
  return (
    <>
      <section className="terms-block" aria-labelledby="refunds-heading">
        <h2 id="refunds-heading">{pickLang(uiLang, "Refund policy", "退款政策")}</h2>
        <p>
          {zh ? (
            <>
              <strong>订阅：</strong>
              您可在<strong>首次订阅付款后的 7 天内</strong>联系我们申请退款；对于之后的<strong>每次续费付款</strong>，您可在
              <strong>续费后的 2 天内</strong>联系我们申请退款。
            </>
          ) : (
            <>
              <strong>Subscriptions:</strong> You may contact us to request a refund within{" "}
              <strong>7 days</strong> of your first subscription payment, and within{" "}
              <strong>2 days</strong> of each renewal payment after that.
            </>
          )}
        </p>
      </section>

      <section className="terms-block" aria-labelledby="ip-heading">
        <h2 id="ip-heading">
          {pickLang(
            uiLang,
            "Intellectual property (scripts you generate)",
            "知识产权（您生成的剧本）"
          )}
        </h2>
        <p>
          {zh ? (
            <>
              根据我们的创始文件，我们<strong>不会主张</strong>对您使用本软件所生成剧本内容的知识产权。生成完成后，每部剧本归
              <strong>您（用户）</strong>所有。
            </>
          ) : (
            <>
              Per our founding document, we will never claim ownership of the IP in scripts generated using
              this software. After generation, each script belongs to you, the user.
            </>
          )}
        </p>
      </section>

      <section className="terms-block" aria-labelledby="support-heading">
        <h2 id="support-heading">{pickLang(uiLang, "Customer support", "客户支持")}</h2>
        <p>
          {pickLang(uiLang, "Email:", "联系邮箱：")}{" "}
          <a href="mailto:verticalinfinite@proton.me">verticalinfinite@proton.me</a>
        </p>
      </section>
    </>
  );
}

/** Terms content embedded in the main app (Pricing-style panel). */
export function TermsAndConditionsPanel({ onBack, uiLang }) {
  const lang = uiLang === "zh" ? "zh" : "en";
  return (
    <section className="script-output pricing-panel" style={{ maxWidth: 720 }}>
      <h2 className="pricing-title" style={{ textAlign: "center" }}>
        {pickLang(lang, "Terms & conditions", "条款与条件")}
      </h2>
      <TermsBlocks uiLang={lang} />
      <div style={{ display: "flex", justifyContent: "center", marginTop: "1.25rem" }}>
        <button type="button" className="btn btn-primary" onClick={onBack}>
          {pickLang(lang, "Back to home", "返回首页")}
        </button>
      </div>
    </section>
  );
}

