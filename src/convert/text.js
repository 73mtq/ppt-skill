'use strict';

/**
 * Per-line native text emission (load-bearing).
 *
 * PowerPoint must NEVER re-wrap: every measured line box from the IR becomes
 * its own hard-broken segment (`softBreakBefore` → `<a:br/>` in the slide
 * XML), so the browser's line breaks are preserved exactly. Runs within a
 * line are split wherever the computed style differs (per CSS span).
 *
 * Every text box carries the mandatory triple: `margin:0`, explicit `valign`,
 * and exact `lineSpacing` (used line-height px × 0.75 pt, asserted to be
 * ≥ font ascent + descent so PowerPoint never compresses the line).
 */

const { pxToPt, pxToInch, rgbToHex } = require('./units.js');

const LINE_WIDTH_BUFFER = 1.015; // DPI rounding headroom; PowerPoint must not re-wrap

function isBold(weight) {
  if (!weight) return false;
  if (weight === 'bold') return true;
  const n = parseFloat(weight);
  return !Number.isNaN(n) && n >= 600;
}

function normalizeAlign(align) {
  if (align === 'start') return 'left';
  if (align === 'end') return 'right';
  return align || 'left';
}

function runToPptx(run, extra = {}) {
  const s = run.styles || {};
  const options = {
    fontFace: s.fontResolved || 'Microsoft YaHei',
    fontSize: pxToPt(s.fontSizePx || 12),
    bold: isBold(s.fontWeight),
    italic: s.fontStyle === 'italic',
    color: rgbToHex(s.color) || '000000',
    charSpacing: pxToPt(s.letterSpacingPx || 0),
    lang: 'zh-CN',
    ...extra,
  };
  if (s.href) options.hyperlink = { url: s.href };
  return { text: run.text, options };
}

// Exact lineSpacing in pt; throws when the IR lacks line-height data or the
// spacing would be smaller than the font's ascent+descent.
function assertLineSpacing(element) {
  const s = element.styles || {};
  const lh = s.lineHeightUsedPx;
  if (typeof lh !== 'number' || !Number.isFinite(lh) || lh <= 0) {
    throw new Error(
      `convert: element "${element.pptId}" is missing lineHeightUsedPx (lineSpacing data)`
    );
  }
  const ascent = s.fontBoundingBoxAscentPx || 0;
  const descent = s.fontBoundingBoxDescentPx || 0;
  const lineSpacingPt = pxToPt(lh);
  const minPt = pxToPt(ascent + descent);
  if (lineSpacingPt < minPt) {
    throw new Error(
      `convert: element "${element.pptId}" lineSpacing ${lineSpacingPt.toFixed(2)}pt < ascent+descent ${minPt.toFixed(2)}pt`
    );
  }
  return lineSpacingPt;
}

/**
 * Emit one text box for a text-block element.
 *
 * opts:
 *   runExtra       — options applied to every run (e.g. hyperlink)
 *   firstRunExtra  — options applied to the first run of the first line (e.g. bullet)
 *   boxExtra       — options merged into the text-box options (e.g. indentLevel)
 */
function emitText(slide, element, lineData, opts = {}) {
  const { runExtra = {}, firstRunExtra = {}, boxExtra = {} } = opts;
  const s = element.styles || {};
  const lineSpacingPt = assertLineSpacing(element);
  const lineRuns = (lineData && lineData.runs) || [];
  const count = (lineData && lineData.count) || 0;

  // Flatten per-line runs into one run array; the first run of every line
  // after the first carries softBreakBefore → `<a:br/>` in the XML.
  const flatRuns = [];
  for (let i = 0; i < count; i++) {
    const runs = lineRuns[i] || [];
    for (let j = 0; j < runs.length; j++) {
      const isFirstRunOfLine = j === 0;
      flatRuns.push(runToPptx(runs[j], {
        ...runExtra,
        ...(isFirstRunOfLine && i > 0 ? { softBreakBefore: true } : {}),
        ...(i === 0 && j === 0 ? firstRunExtra : {}),
      }));
    }
  }
  if (flatRuns.length === 0) return;

  const box = {
    x: pxToInch(element.rect.x),
    y: pxToInch(element.rect.y),
    w: pxToInch(element.rect.w * LINE_WIDTH_BUFFER),
    h: pxToInch(element.rect.h),
    margin: 0,
    valign: 'top',
    lineSpacing: lineSpacingPt,
    align: normalizeAlign(s.textAlign),
    isTextBox: true,
    ...boxExtra,
  };
  slide.addText(flatRuns, box);
}

module.exports = { emitText, runToPptx, assertLineSpacing, isBold, normalizeAlign, LINE_WIDTH_BUFFER };