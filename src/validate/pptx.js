'use strict';

/**
 * pptx.js — structural validation of a generated .pptx against the source IR.
 *
 * validatePptx(pptxBuffer, irPages, tokens) → {ok, errors[]}
 *
 * Unzips the archive (jszip), parses each slideN.xml with fast-xml-parser and
 * asserts:
 *   1. every IR text string appears in the slide XML (normalized whitespace,
 *      content + count match) → missing-text
 *   2. no shape exceeds the slide bounds (EMU: x/y ≥ 0, x+w ≤ 9144000,
 *      y+h ≤ 5143500) → out-of-bounds
 *   3. every <p:txBody> bodyPr has explicit lIns/rIns/tIns/bIns="0" and an
 *      anchor attribute → bodypr-insets / bodypr-anchor
 *   4. every pic has a valid rels entry + dims within bounds → pic-rel-missing
 *   5. every typeface ∈ tokens fonts → font-not-in-tokens
 *
 * Errors use the binding shape {page, data-ppt-id, rule, measured, available,
 * suggested_fix}. `ok` is true only when errors is empty.
 */

const path = require('node:path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const SLIDE_W_EMU = 9144000; // 10 in (LAYOUT_16x9)
const SLIDE_H_EMU = 5143500; // 5.625 in

const parser = new XMLParser({ ignoreAttributes: false });

function err(page, id, rule, measured, available, suggested_fix) {
  return { page, 'data-ppt-id': id, rule, measured, available, suggested_fix };
}

function childByTag(node, tag) {
  if (!node || typeof node !== 'object') return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === tag || key.endsWith(':' + tag)) return value;
  }
  return undefined;
}

function collectByTag(node, tag, out = []) {
  if (node == null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === tag || key.endsWith(':' + tag)) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
    if (Array.isArray(value)) {
      for (const v of value) collectByTag(v, tag, out);
    } else if (value && typeof value === 'object') {
      collectByTag(value, tag, out);
    }
  }
  return out;
}

function getXfrm(shape) {
  const spPr = childByTag(shape, 'spPr');
  const xfrm = spPr ? childByTag(spPr, 'xfrm') : undefined;
  if (!xfrm) return null;
  const off = childByTag(xfrm, 'off');
  const ext = childByTag(xfrm, 'ext');
  if (!off || !ext) return null;
  return {
    x: parseInt(off['@_x'], 10),
    y: parseInt(off['@_y'], 10),
    cx: parseInt(ext['@_cx'], 10),
    cy: parseInt(ext['@_cy'], 10),
  };
}

function checkBounds(xfrm, page, errors) {
  if (!xfrm) return;
  const { x, y, cx, cy } = xfrm;
  if ([x, y, cx, cy].some((n) => Number.isNaN(n))) {
    errors.push(err(page, null, 'out-of-bounds', JSON.stringify(xfrm), 'numeric EMU', 'Shape geometry must be numeric EMU values.'));
    return;
  }
  if (x < 0 || y < 0 || x + cx > SLIDE_W_EMU || y + cy > SLIDE_H_EMU) {
    errors.push(err(page, null, 'out-of-bounds', `x=${x} y=${y} w=${cx} h=${cy}`, `0..${SLIDE_W_EMU} x 0..${SLIDE_H_EMU}`, 'Move the shape inside the slide bounds.'));
  }
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// Every per-line run text from the IR (the convert layer emits each run as its
// own <a:t>, so these are the atomic strings the slide XML must contain).
function collectIrTexts(irPage) {
  const texts = [];
  const lines = irPage.lines || {};
  for (const el of irPage.elements || []) {
    const lineData = lines[el.pptId];
    if (lineData && Array.isArray(lineData.runs)) {
      for (const line of lineData.runs) {
        for (const run of line) {
          const t = normalizeText(run.text);
          if (t) texts.push(t);
        }
      }
    } else if (el.text) {
      const t = normalizeText(el.text);
      if (t) texts.push(t);
    }
  }
  return texts;
}

async function validatePptx(pptxBuffer, irPages, tokens) {
  const errors = [];
  let zip;
  try {
    zip = await JSZip.loadAsync(pptxBuffer);
  } catch (e) {
    return { ok: false, errors: [err(null, null, 'pptx-unzip', e.message, 'valid pptx zip', 'The file is not a readable pptx archive.')] };
  }

  const allowedFonts = new Set();
  if (tokens && tokens.fonts) {
    for (const v of Object.values(tokens.fonts)) allowedFonts.add(v);
  }

  const pages = Array.isArray(irPages) ? irPages : [];
  for (let i = 0; i < pages.length; i++) {
    const irPage = pages[i];
    const pageName = irPage && irPage.page ? irPage.page : `slide${i + 1}.xml`;
    const slideFile = `ppt/slides/slide${i + 1}.xml`;
    const slideEntry = zip.file(slideFile);
    if (!slideEntry) {
      errors.push(err(pageName, null, 'slide-missing', slideFile, 'ppt/slides/slideN.xml', 'The deck is missing a slide for this page.'));
      continue;
    }
    const xml = await slideEntry.async('string');
    let doc;
    try {
      doc = parser.parse(xml);
    } catch (e) {
      errors.push(err(pageName, null, 'slide-parse', e.message, 'well-formed slide XML', 'The slide XML is malformed.'));
      continue;
    }

    // 1. Text content + count match.
    const xmlNorm = normalizeText(xml);
    const textCounts = new Map();
    for (const t of collectIrTexts(irPage)) {
      textCounts.set(t, (textCounts.get(t) || 0) + 1);
    }
    for (const [t, irCount] of textCounts) {
      const xmlCount = countOccurrences(xmlNorm, escapeXml(t));
      if (xmlCount < irCount) {
        errors.push(err(pageName, null, 'missing-text', t, `expected ${irCount} occurrence(s), found ${xmlCount}`, 'Every IR text run must appear in the slide XML.'));
      }
    }

    // 2. Shape bounds (sp + pic).
    const shapes = [...collectByTag(doc, 'sp'), ...collectByTag(doc, 'pic')];
    for (const shape of shapes) {
      checkBounds(getXfrm(shape), pageName, errors);
    }

    // 3. bodyPr insets + anchor on every txBody.
    for (const tb of collectByTag(doc, 'txBody')) {
      const bodyPr = childByTag(tb, 'bodyPr');
      if (!bodyPr) {
        errors.push(err(pageName, null, 'bodypr-missing', 'txBody without bodyPr', 'a:bodyPr', 'Every text box must carry a bodyPr.'));
        continue;
      }
      for (const k of ['lIns', 'rIns', 'tIns', 'bIns']) {
        if (bodyPr['@_' + k] !== '0') {
          errors.push(err(pageName, null, 'bodypr-insets', `${k}=${bodyPr['@_' + k]}`, `${k}="0"`, 'Text boxes must have explicit zero insets (margin:0).'));
        }
      }
      if (!bodyPr['@_anchor']) {
        errors.push(err(pageName, null, 'bodypr-anchor', 'missing anchor', 'anchor="t|ctr|b"', 'Every text box must declare an explicit vertical anchor.'));
      }
    }

    // 4. pic rels + dims.
    const relMap = {};
    const relsEntry = zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`);
    if (relsEntry) {
      try {
        const relsDoc = parser.parse(await relsEntry.async('string'));
        for (const rel of collectByTag(relsDoc, 'Relationship')) {
          relMap[rel['@_Id']] = rel['@_Target'];
        }
      } catch (e) { /* missing rels handled below */ }
    }
    for (const pic of collectByTag(doc, 'pic')) {
      const blipFill = childByTag(pic, 'blipFill');
      const blip = blipFill ? childByTag(blipFill, 'blip') : undefined;
      const embed = blip ? (blip['@_embed'] || blip['@_r:embed']) : undefined;
      if (!embed || !relMap[embed]) {
        errors.push(err(pageName, null, 'pic-rel-missing', embed || 'no r:embed', 'valid rels entry', 'Every picture must reference an existing relationship.'));
      } else {
        const target = relMap[embed];
        const mediaPath = target.startsWith('/')
          ? target.replace(/^\//, '')
          : path.posix.normalize('ppt/slides/' + target);
        if (!zip.file(mediaPath)) {
          errors.push(err(pageName, null, 'pic-rel-missing', `${embed} -> ${target}`, 'existing media file', `The picture relationship target ${target} does not exist in the archive.`));
        }
      }
      checkBounds(getXfrm(pic), pageName, errors);
    }

    // 5. typeface ∈ tokens fonts (latin/ea/cs carry the resolved font).
    const typefaces = new Set();
    for (const tag of ['latin', 'ea', 'cs']) {
      for (const el of collectByTag(doc, tag)) {
        if (el['@_typeface']) typefaces.add(el['@_typeface']);
      }
    }
    for (const tf of typefaces) {
      if (!allowedFonts.has(tf)) {
        errors.push(err(pageName, null, 'font-not-in-tokens', tf, [...allowedFonts].join(', '), 'Every typeface in the slide must come from tokens.fonts.'));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validatePptx, SLIDE_W_EMU, SLIDE_H_EMU };