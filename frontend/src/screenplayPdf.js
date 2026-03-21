import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

/** Noto Sans SC (Simplified) — required for embedding CJK in pdf-lib. First download can be large / slow. */
// Load from local Vite `public/` folder so PDF rendering does not depend on 3rd-party CDN availability.
// Use BASE_URL so fonts resolve when the app is served under a subpath (e.g. GitHub Pages).
const viteBase =
  typeof import.meta !== "undefined" && import.meta.env?.BASE_URL != null
    ? String(import.meta.env.BASE_URL)
    : "/";
const NOTO_SC_OTF = `${viteBase.endsWith("/") ? viteBase : `${viteBase}/`}fonts/NotoSansCJKsc-Regular.otf`;

let notoFontBytesPromise = null;

export function loadNotoSansScFontBytes() {
  if (!notoFontBytesPromise) {
    notoFontBytesPromise = (async () => {
      // Browser: fetch from Vite `public/` folder.
      if (typeof window !== "undefined") {
        const r = await fetch(NOTO_SC_OTF);
        if (!r.ok) {
          throw new Error(
            `Could not download Chinese font (${r.status}). Check your network and try again.`
          );
        }
        return r.arrayBuffer();
      }

      // Node: read the same file from disk (so our PDF logic is testable).
      const fs = await import("fs");
      const { fileURLToPath } = await import("url");
      const fontPath = fileURLToPath(
        new URL("../public/fonts/NotoSansCJKsc-Regular.otf", import.meta.url)
      );
      return fs.promises.readFile(fontPath);
    })();
  }
  return notoFontBytesPromise;
}

/**
 * Models often emit thin/narrow/zero-width spaces. English PDF path then strips non–Latin-1
 * bytes, which removes those characters entirely and can glue words (looks fine in <pre>).
 */
function normalizeWhitespaceForPdf(script) {
  if (!script || typeof script !== "string") return script;
  return script
    .replace(/\r\n/g, "\n")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, " ");
}

function wrapToWidthAscii(font, text, size, maxWidth) {
  const lines = [];
  const words = text.split(/\s+/);
  let line = "";
  for (const w of words) {
    if (!w) continue;
    const candidate = line ? `${line} ${w}` : w;
    const ww = font.widthOfTextAtSize(candidate, size);
    if (ww <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Greedy wrap for mixed CJK / Latin (character-wise, works with embedded OTF). */
function wrapToWidthUnicode(font, text, size, maxWidth) {
  const lines = [];
  let line = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    const next = line + ch;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = ch;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * @param {string} script
 * @param {"en" | "zh"} variant
 * @returns {Promise<Uint8Array>}
 */
export async function buildScreenplayPdfBytes(script, variant = "en") {
  const yieldToMain = () => new Promise((r) => setTimeout(r, 0));

  let workText = normalizeWhitespaceForPdf(script);
  if (variant === "en") {
    workText = script
      .replace(/\u3002/g, ".")
      .replace(/\uFF0C/g, ",")
      .replace(/\uFF1A/g, ":")
      .replace(/\uFF1B/g, ";")
      .replace(/\uFF01/g, "!")
      .replace(/\uFF1F/g, "?")
      .replace(/\u2018|\u2019|\uFF07/g, "'")
      .replace(/\u201C|\u201D|\uFF02/g, '"');
    workText = workText.replace(/[^\x00-\xFF]/g, "");
  }

  const pdfDoc = await PDFDocument.create();
  // Required for embedding custom fonts (e.g. Noto Sans SC OTF) in pdf-lib.
  pdfDoc.registerFontkit(fontkit);
  const fontSize = 12;
  const lineHeight = 14;

  let bodyFont;
  let pageNumFont;
  if (variant === "zh") {
    const bytes = await loadNotoSansScFontBytes();
    // subset:true + fontkit often yields empty/broken CJK outlines in the saved PDF (blank in viewers).
    // Full embed is larger (~font file size) but renders reliably.
    bodyFont = await pdfDoc.embedFont(bytes, { subset: false });
    pageNumFont = bodyFont;
  } else {
    bodyFont = await pdfDoc.embedFont(StandardFonts.Courier);
    pageNumFont = bodyFont;
  }

  const wrap = (font, text, size, maxWidth) =>
    variant === "zh"
      ? wrapToWidthUnicode(font, text, size, maxWidth)
      : wrapToWidthAscii(font, text, size, maxWidth);

  const PAGE_WIDTH = 612;
  const PAGE_HEIGHT = 792;
  const CONTENT_WIDTH = 324;
  const CONTENT_LEFT = (PAGE_WIDTH - CONTENT_WIDTH) / 2;
  const TOP_BOTTOM_MARGIN = 72;
  const DIALOGUE_INDENT = 36;
  const DIALOGUE_WIDTH = CONTENT_WIDTH - DIALOGUE_INDENT;
  const ACTION_INDENT = 18;

  const isSceneHeading = (t) =>
    /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(t.trim()) ||
    /^EPISODE\s+\d+/i.test(t.trim());

  const isCharacterLine = (t) => {
    const s = t.trim();
    if (!s) return false;
    // Whole cue on one line: ANNOUNCER (V.O.) / EMILY LAWRENCE (CONT'D)
    const parenCue = s.match(
      /^([A-Z0-9][A-Z0-9\s\-'.]{0,30})(\([^)]{1,28}\))\s*$/
    );
    if (parenCue) {
      if (s.length > 44) return false;
      const base = parenCue[1].replace(/\s+/g, " ").trim();
      const letters = base.replace(/[^A-Za-z]/g, "");
      if (letters.length >= 2 && base === base.toUpperCase()) return true;
    }
    if (s.length > 35) return false;
    if (/[.!?]/.test(s) && !/^[A-Z\s\-']+[.!?]?$/.test(s)) return false;
    const letters = s.replace(/[^A-Za-z]/g, "");
    return (
      letters.length >= 2 &&
      (s === s.toUpperCase() || letters.length >= Math.floor(s.length * 0.5))
    );
  };

  const isParenthetical = (t) => {
    const s = t.trim();
    return /^\([^)]+\)$/.test(s) || /^\（[^）]+\）$/.test(s);
  };

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - TOP_BOTTOM_MARGIN;
  let pageNum = 1;

  const drawPageNumber = (p) => {
    const num = String(pageNum);
    const w = pageNumFont.widthOfTextAtSize(num, 10);
    p.drawText(num, { x: 36, y: PAGE_HEIGHT - 36, size: 10, font: pageNumFont });
    p.drawText(num, {
      x: PAGE_WIDTH - 36 - w,
      y: PAGE_HEIGHT - 36,
      size: 10,
      font: pageNumFont,
    });
  };

  const ensureSpace = (neededLines) => {
    if (y - neededLines * lineHeight < TOP_BOTTOM_MARGIN) {
      drawPageNumber(page);
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pageNum += 1;
      y = PAGE_HEIGHT - TOP_BOTTOM_MARGIN;
    }
  };

  const lines = workText.split(/\r?\n/);
  let prevType = "blank";
  let lineIndex = 0;

  for (const raw of lines) {
    lineIndex += 1;
    if (lineIndex % 150 === 0) await yieldToMain();
    const text = raw.replace(/\s+$/g, "");
    const trimmed = text.trim();

    if (!trimmed) {
      y -= lineHeight;
      prevType = "blank";
      continue;
    }

    let lineType;
    if (isSceneHeading(trimmed)) {
      lineType = "scene";
    } else if (isCharacterLine(trimmed)) {
      lineType = "character";
    } else if (isParenthetical(trimmed)) {
      lineType = "parenthetical";
    } else if (
      prevType === "character" ||
      prevType === "parenthetical" ||
      prevType === "dialogue"
    ) {
      lineType = "dialogue";
    } else {
      lineType = "action";
    }

    const sceneLine = trimmed.toUpperCase();
    const displayText = lineType === "scene" ? sceneLine : trimmed;

    if (lineType === "scene" && prevType !== "blank") y -= lineHeight;
    if (lineType === "character" && prevType !== "blank" && prevType !== "scene") {
      y -= lineHeight * 0.5;
    }

    if (lineType === "scene") {
      const segs = wrap(bodyFont, displayText, fontSize, CONTENT_WIDTH);
      ensureSpace(segs.length);
      for (const seg of segs) {
        page.drawText(seg, {
          x: CONTENT_LEFT,
          y,
          size: fontSize,
          font: bodyFont,
        });
        y -= lineHeight;
      }
    } else if (lineType === "character") {
      ensureSpace(1);
      const upper = displayText.toUpperCase();
      const w = bodyFont.widthOfTextAtSize(upper, fontSize);
      const x = CONTENT_LEFT + (CONTENT_WIDTH - w) / 2;
      page.drawText(upper, { x, y, size: fontSize, font: bodyFont });
      y -= lineHeight;
    } else if (lineType === "parenthetical") {
      const segs = wrap(bodyFont, displayText, fontSize - 1, CONTENT_WIDTH - 80);
      ensureSpace(segs.length);
      const parenX = CONTENT_LEFT + 60;
      for (const seg of segs) {
        page.drawText(seg, {
          x: parenX,
          y,
          size: fontSize - 1,
          font: bodyFont,
        });
        y -= lineHeight;
      }
    } else if (lineType === "dialogue") {
      const segs = wrap(bodyFont, displayText, fontSize, DIALOGUE_WIDTH);
      ensureSpace(segs.length);
      for (const seg of segs) {
        page.drawText(seg, {
          x: CONTENT_LEFT + DIALOGUE_INDENT,
          y,
          size: fontSize,
          font: bodyFont,
        });
        y -= lineHeight;
      }
    } else {
      const actionLines = wrap(
        bodyFont,
        displayText,
        fontSize,
        CONTENT_WIDTH - ACTION_INDENT
      );
      const maxParagraphLines = 3;
      const paragraphs = [];
      for (let i = 0; i < actionLines.length; i += maxParagraphLines) {
        paragraphs.push(actionLines.slice(i, i + maxParagraphLines));
      }
      for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p];
        ensureSpace(para.length + 1);
        for (const seg of para) {
          page.drawText(seg, {
            x: CONTENT_LEFT + ACTION_INDENT,
            y,
            size: fontSize,
            font: bodyFont,
          });
          y -= lineHeight;
        }
        if (p < paragraphs.length - 1) y -= lineHeight * 0.5;
      }
    }

    prevType = lineType;
  }

  drawPageNumber(page);

  try {
    return await pdfDoc.save();
  } catch (saveErr) {
    console.error(saveErr);
    throw new Error(
      "PDF too large or out of memory. Try a shorter script or fewer episodes."
    );
  }
}
