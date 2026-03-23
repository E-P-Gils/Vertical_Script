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
 * Thin / zero-width spaces: browsers render a gap, but the old English PDF path stripped
 * non–Latin-1 without replacing them first → glued words in PDF only. Always normalize
 * before PDF or use the exported helpers for on-page display so web and PDF match.
 */
function normalizeWhitespaceForPdf(script) {
  if (!script || typeof script !== "string") return script;
  return script
    .replace(/\r\n/g, "\n")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, " ");
}

/** Chinese PDF input + display: unicode whitespace cleanup only (full CJK preserved). */
export function prepareChineseScriptLikePdfInput(script) {
  return normalizeWhitespaceForPdf(script);
}

/**
 * English PDF input + display: same normalization, punctuation, Latin-1 window, and
 * conservative glue repair as `buildScreenplayPdfBytes` uses before layout.
 * (Sentence-case softening of shouty dialogue is still PDF-only during line typing.)
 */
export function prepareEnglishScriptLikePdfInput(script) {
  if (!script || typeof script !== "string") return script;
  let t = normalizeWhitespaceForPdf(script);
  t = t
    .replace(/\u3002/g, ".")
    .replace(/\uFF0C/g, ",")
    .replace(/\uFF1A/g, ":")
    .replace(/\uFF1B/g, ";")
    .replace(/\uFF01/g, "!")
    .replace(/\uFF1F/g, "?")
    .replace(/\u2018|\u2019|\uFF07/g, "'")
    .replace(/\u201C|\u201D|\uFF02/g, '"');
  t = t.replace(/[^\x00-\xFF]/g, "");
  return t.split("\n").map((ln) => repairStuckWordsLine(ln)).join("\n");
}

/**
 * Conservative glue fixes only. Broader patterns like /...+(the|and|here)/ were removed:
 * they fire inside normal words ("grand", "atmosphere", "otherwise").
 */
function repairStuckWordsLine(line) {
  let s = line;
  // Normalize a few common glued-token failures (word-boundary safe).
  // These come directly from your examples: enteringthe, Lucasthis, histhere's, etc.
  const gluedReplacements = [
    [/\benteringthe\b/gi, "entering the"],
    [/\bnearbythe\b/gi, "nearby the"],
    [/\bsharplyand\b/gi, "sharply and"],
    [/\bcloseragainabout\b/gi, "closer again about"],
    [/\bcloseragain\b/gi, "closer again"],
    [/\bagainabout\b/gi, "again about"],
    [/\btogetherthen\b/gi, "together then"],
    [/\bLucasthis\b/g, "Lucas this"],
    [/\bstiffensher\b/gi, "stiffens her"],
    [/\bherselfconsciously\b/gi, "herself-consciously"],
    [/\bsomeoneelse\b/gi, "someone else"],
    [/\bwithoutwarning\b/gi, "without warning"],
    [/\bfrombehind\b/gi, "from behind"],
    [/\belsein\b/gi, "else in"],
    [/\bdresseda\b/gi, "dressed a"],
    [/\btoithis\b/gi, "to it his"],
    [/\bforithis\b/gi, "for it his"],
    [/\bhisthere's\b/gi, "his there's"],
    [/\bwithout\s+warning\b/gi, "without warning"],
  ];
  for (const [re, rep] of gluedReplacements) s = s.replace(re, rep);

  // dateIsabelle, other lower->TitleCase glitches.
  s = s.replace(/([a-z])([A-Z][a-z]+)\b/g, "$1 $2");

  // SHOUTYTOKENSTUCK — only when both halves are ASCII caps.
  s = s.replace(
    /\b([A-Z]{2,})(ABOUT|TOGETHER|THEN|THERE|THE|THAT|THIS|WHAT|WHEN|WITH|FROM|INTO|ONTO|OVER|UNDER|AFTER|BEFORE|INSIDE|OUTSIDE|AROUND|AGAIN|ALSO|EVEN|ONLY|JUST|LEAN|KISS|BACK|WELL|SUDDENLY)\b/g,
    "$1 $2"
  );

  // Punctuation spacing for English-only output.
  s = s.replace(/([.!?])([A-Za-z])/g, "$1 $2");
  s = s.replace(/([,;:])([A-Za-z])/g, "$1 $2");
  s = s.replace(/ {2,}/g, " ");
  return s;
}

/** Shouty ALL-CAPS dialogue / parentheticals → sentence case */
function softenAllCapsLine(s) {
  const t = s.trim();
  if (t.length < 8) return s;
  const paren = /^\(([^)]*)\)$/.test(t);
  const core = paren ? t.slice(1, -1) : t;
  if (core.length < 6) return s;
  if (core !== core.toUpperCase()) return s;
  if (/[^A-Z\s,'\-!?]/.test(core)) return s;
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length < 2) return s;
  let lower = core.toLowerCase().replace(/\bi\b/g, "I");
  const out = lower.charAt(0).toUpperCase() + lower.slice(1);
  return paren ? `(${out})` : out;
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

  const workText =
    variant === "en"
      ? prepareEnglishScriptLikePdfInput(script)
      : prepareChineseScriptLikePdfInput(script);

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
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length >= 5 && !/\(/.test(s)) return false;
    if (words.length >= 7) return false;
    if (/[,:;]/.test(s) && !/\([^)]+\)/.test(s)) return false;
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

  const canStartCharacterSlug = (pt) =>
    pt === "blank" || pt === "scene" || pt === "action" || pt === "dialogue";

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
  let skipLonelyDigitAfterEpisode = false;

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

    if (skipLonelyDigitAfterEpisode && /^\d{1,2}$/.test(trimmed)) {
      skipLonelyDigitAfterEpisode = false;
      continue;
    }

    let lineType;
    if (isSceneHeading(trimmed)) {
      lineType = "scene";
      if (/^EPISODE\s+\d+/i.test(trimmed)) {
        skipLonelyDigitAfterEpisode = true;
      }
    } else if (prevType === "character" && isParenthetical(trimmed)) {
      lineType = "parenthetical";
    } else if (
      prevType === "character" ||
      prevType === "parenthetical" ||
      prevType === "dialogue"
    ) {
      lineType = "dialogue";
    } else if (canStartCharacterSlug(prevType) && isCharacterLine(trimmed)) {
      const oneWord =
        trimmed.split(/\s+/).filter(Boolean).length === 1 && !/\(/.test(trimmed);
      const shoutAfterDialogue =
        prevType === "dialogue" &&
        oneWord &&
        /^(HERE|YES|NO|OK|OKAY|WHY|HOW|WHAT|WHO|HMM|OH|AH|UH|UM|STOP|RUN|WAIT)$/i.test(
          trimmed
        );
      lineType = shoutAfterDialogue ? "dialogue" : "character";
    } else if (isParenthetical(trimmed)) {
      lineType = "parenthetical";
    } else {
      lineType = "action";
    }

    const sceneLine = trimmed.toUpperCase();
    let displayText = lineType === "scene" ? sceneLine : trimmed;
    if (variant === "en" && (lineType === "dialogue" || lineType === "parenthetical")) {
      displayText = softenAllCapsLine(displayText);
    }

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
