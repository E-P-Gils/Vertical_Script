import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TermsAndConditions from "./TermsAndConditions.jsx";
import "./index.css";

const isTermsPath = /^\/terms-and-conditions\/?$/.test(
  window.location.pathname || ""
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isTermsPath ? <TermsAndConditions /> : <App />}
  </React.StrictMode>
);
