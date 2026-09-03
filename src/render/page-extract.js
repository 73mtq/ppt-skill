'use strict';

/**
 * In-page DOM extraction for the render measurement layer.
 *
 * This function is serialized by Playwright and executed INSIDE the page:
 * it must stay fully self-contained (no Node closures, no requires).
 *
 * Extracts the allowlisted element tree into the binding layout IR:
 *   { elements: [{pptId, tag, rect, styles}], lines: {[pptId]: {count, rects}},
 *     warnings: [], errors: [] }
 *
 * Structured errors/warnings share the binding shape
 *   {page, data-ppt-id, rule, measured, available, suggested_fix}
 * (`page` is filled in by the Node-side wrapper). Non-allowlist elements are
 * NEVER silently skipped: they produce an element-not-allowed error and their
 * subtree is not descended into.
 */

function extractPageIR() {
  const errors = [];
  const warnings = [];
  const elements = [];
  const lines = {};

  const ALLOWED = new Set(['BODY', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'IMG', 'A', 'SPAN']);
  const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'A', 'SPAN']);
  // Block-level allowlist members: text inside these descendants is owned by
  // the descendant, not by the ancestor being measured.
  const BLOCKISH = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI']);
  const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', '-apple-system']);
  const CN_ALIAS = { '微软雅黑': 'Microsoft YaHei', '等线': 'DengXian', '宋体': 'SimSun', '黑体': 'SimHei', '楷体': 'KaiTi', '仿宋': 'FangSong' };
  const CJK_FALLBACKS = ['Microsoft YaHei', 'DengXian', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'Microsoft JhengHei', 'PMingLiU'];
  const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const CJK_SAMPLE = '永国字一回了啊';
  const EPS = 0.5; // px tolerance for sub-pixel layout noise

  // lang="zh-CN" is mandatory on <html> (html-level error; data-ppt-id null).
  const htmlLang = document.documentElement.getAttribute('lang');
  if (htmlLang !== 'zh-CN') {
    errors.push({
      page: null,
      'data-ppt-id': null,
      rule: 'lang-missing',
      measured: htmlLang,
      available: 'zh-CN',
      suggested_fix: 'Add lang="zh-CN" to the <html> tag of this page.',
    });
  }

  // Deterministic ppt-id assignment: smallest unused ppt-N, ascending DOM order.
  const usedIds = new Set();
  document.querySelectorAll('[data-ppt-id]').forEach((el) => {
    usedIds.add(el.getAttribute('data-ppt-id'));
  });
  function nextId() {
    let n = 1;
    while (usedIds.has('ppt-' + n)) n++;
    const id = 'ppt-' + n;
    usedIds.add(id);
    return id;
  }

  // Offscreen canvas for font ascent/descent (measureText fontBoundingBox*).
  const canvas = document.createElement('canvas');
  canvas.width = 10;
  canvas.height = 10;
  const ctx = canvas.getContext('2d');

  function parseStack(stack) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|([^,]+)/g;
    let m;
    while ((m = re.exec(stack)) !== null) {
      const fam = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '').trim();
      if (fam) out.push(CN_ALIAS[fam] || fam);
    }
    return out;
  }

  function familyInstalled(family) {
    try {
      return document.fonts.check('16px "' + family.replace(/"/g, '') + '"');
    } catch (e) {
      return false;
    }
  }

  function familyCjkCapable(family) {
    try {
      return document.fonts.check('16px "' + family.replace(/"/g, '') + '"', CJK_SAMPLE);
    } catch (e) {
      return false;
    }
  }

  // Font resolution per run: first installed family in the stack; text with
  // CJK promotes the first CJK-capable family. Always returns an English name.
  function resolveFont(stack, text) {
    const hasCJK = CJK_RE.test(text || '');
    const families = parseStack(stack).filter((f) => !GENERIC_FAMILIES.has(f.toLowerCase()));
    const probe = hasCJK ? familyCjkCapable : familyInstalled;
    for (const f of families) {
      if (probe(f)) return f;
    }
    if (hasCJK) {
      for (const f of CJK_FALLBACKS) {
        if (familyCjkCapable(f)) return f;
      }
      return 'Microsoft YaHei'; // last resort on a CJK-broken machine; still English
    }
    return families[0] || 'Segoe UI';
  }

  function directTextLength(el) {
    let n = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        n += node.textContent.trim().length;
      }
    }
    return n;
  }

  // Dominant text run: group own text nodes by style signature, keep the longest.
  function dominantRun(el) {
    const elCS = getComputedStyle(el);
    const groups = new Map();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node.textContent;
      if (!t.trim()) continue;
      const host = node.parentElement;
      const cs = getComputedStyle(host);
      const key = cs.fontFamily + '|' + cs.fontWeight + '|' + cs.fontStyle + '|' + cs.fontSize;
      if (!groups.has(key)) {
        groups.set(key, {
          text: '',
          style: {
            family: cs.fontFamily,
            weight: cs.fontWeight,
            style: cs.fontStyle,
            sizePx: parseFloat(cs.fontSize) || 0,
          },
        });
      }
      groups.get(key).text += t;
    }
    let best = null;
    for (const g of groups.values()) {
      if (!best || g.text.trim().length > best.text.trim().length) best = g;
    }
    if (!best) {
      best = {
        text: '',
        style: { family: elCS.fontFamily, weight: elCS.fontWeight, style: elCS.fontStyle, sizePx: parseFloat(elCS.fontSize) || 0 },
      };
    }
    return best;
  }

  // Text nodes owned by el: direct text plus inline descendants (span/a/img
  // have no block box), excluding subtrees of block-level descendants.
  function ownTextNodes(el) {
    const nodes = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent.trim()) nodes.push(child);
      } else if (child.nodeType === Node.ELEMENT_NODE && !BLOCKISH.has(child.tagName)) {
        for (const n of ownTextNodes(child)) nodes.push(n);
      }
    }
    return nodes;
  }

  // Split a text node into per-visual-line fragments (text + first-char rect).
  // Iterates character-by-character so surrogate pairs stay whole and the
  // fragment boundaries land exactly on the browser's line breaks.
  function textNodeFragments(node) {
    const text = node.textContent;
    const range = document.createRange();
    const fragments = [];
    let current = '';
    let currentRect = null;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const end = (code >= 0xD800 && code <= 0xDBFF) ? i + 2 : i + 1;
      range.setStart(node, i);
      range.setEnd(node, end);
      const r = range.getBoundingClientRect();
      if (r.width > EPS && r.height > EPS) {
        if (currentRect === null) {
          currentRect = { x: r.x, y: r.y, w: r.width, h: r.height };
          current = text.slice(i, end);
        } else if (Math.abs(r.y - currentRect.y) > EPS) {
          fragments.push({ text: current, y: currentRect.y, h: currentRect.h });
          currentRect = { x: r.x, y: r.y, w: r.width, h: r.height };
          current = text.slice(i, end);
        } else {
          current += text.slice(i, end);
        }
      }
      if (end > i + 1) i = end - 1;
    }
    if (current) fragments.push({ text: current, y: currentRect.y, h: currentRect.h });
    return fragments;
  }

  // Nearest <a href> ancestor of a text node (within the measured element).
  function nearestLinkHref(node, stopEl) {
    let p = node.parentElement;
    while (p && p !== stopEl) {
      if (p.tagName === 'A' && p.getAttribute('href')) return p.getAttribute('href');
      p = p.parentElement;
    }
    return null;
  }

  // Line boxes via Range.getClientRects(), merged per visual line, plus the
  // per-line text runs (split wherever the computed style differs).
  function measureLines(el) {
    const nodes = ownTextNodes(el);
    const pieces = [];
    for (const node of nodes) {
      const range = document.createRange();
      range.selectNode(node);
      for (const r of range.getClientRects()) {
        if (r.width > EPS && r.height > EPS) {
          pieces.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        }
      }
    }
    pieces.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const r of pieces) {
      const last = merged[merged.length - 1];
      if (last && r.y < last.y + last.h - EPS && r.y + r.h > last.y + EPS) {
        const xEnd = Math.max(last.x + last.w, r.x + r.w);
        last.x = Math.min(last.x, r.x);
        last.w = xEnd - last.x;
        last.y = Math.min(last.y, r.y);
        last.h = Math.max(last.h, r.h);
      } else {
        merged.push({ x: r.x, y: r.y, w: r.w, h: r.h });
      }
    }
    // Per-line runs: split each contributing text node into fragments and
    // assign each fragment to the line whose y-range contains its center.
    const runs = merged.map(() => []);
    for (const node of nodes) {
      const host = node.parentElement;
      const cs = getComputedStyle(host);
      const runStyle = {
        fontResolved: resolveFont(cs.fontFamily, node.textContent),
        fontSizePx: parseFloat(cs.fontSize) || 0,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        color: cs.color,
        letterSpacingPx: cs.letterSpacing === 'normal' ? 0 : (parseFloat(cs.letterSpacing) || 0),
        href: nearestLinkHref(node, el),
      };
      for (const frag of textNodeFragments(node)) {
        if (!frag.text.trim()) continue;
        const fragY = frag.y + frag.h / 2;
        const li = merged.findIndex((m) => fragY >= m.y - EPS && fragY <= m.y + m.h + EPS);
        if (li >= 0) runs[li].push({ text: frag.text, styles: runStyle });
      }
    }
    return { rects: merged, runs };
  }

  function normalizeAlign(align) {
    if (align === 'start') return 'left';
    if (align === 'end') return 'right';
    return align;
  }

  function borderSide(cs, side) {
    const cap = side.charAt(0).toUpperCase() + side.slice(1);
    const width = parseFloat(cs['border' + cap + 'Width']) || 0;
    const style = cs['border' + cap + 'Style'];
    if (style === 'none' || style === 'hidden' || width === 0) {
      return { widthPx: 0, style: 'none', color: 'rgba(0, 0, 0, 0)' };
    }
    return { widthPx: width, style, color: cs['border' + cap + 'Color'] };
  }

  // Inline span/a whose text is already owned by an ancestor text block
  // (p/h1-h6/li/a/span). The convert layer must not emit them as separate
  // text boxes or the text would be duplicated.
  function isInlineTextDescendant(el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (TEXT_TAGS.has(p.tagName)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function walk(el) {
    const tag = el.tagName; // uppercase
    if (!ALLOWED.has(tag)) {
      errors.push({
        page: null,
        'data-ppt-id': el.getAttribute('data-ppt-id') || null,
        rule: 'element-not-allowed',
        measured: '<' + tag.toLowerCase() + '>',
        available: 'body, div, h1-h6, p, ul, ol, li, img, a, span',
        suggested_fix: 'Replace <' + tag.toLowerCase() + '> with an allowed element (see skill/references/html-constraints.md).',
      });
      return; // do not descend: the subtree is unrenderable as native objects
    }

    let pptId = el.getAttribute('data-ppt-id');
    if (!pptId) {
      pptId = nextId();
      warnings.push({
        page: null,
        'data-ppt-id': pptId,
        rule: 'ppt-id-missing',
        measured: null,
        available: null,
        suggested_fix: 'Add data-ppt-id="' + pptId + '" to this <' + tag.toLowerCase() + '> element.',
      });
    }

    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const isTextBlock = TEXT_TAGS.has(tag) || directTextLength(el) > 0;

    let lineData = null;
    if (isTextBlock) {
      lineData = measureLines(el);
      lines[pptId] = { count: lineData.rects.length, rects: lineData.rects, runs: lineData.runs };
    }

    let ascentPx = 0;
    let descentPx = 0;
    let fontResolved = '';
    if (isTextBlock) {
      const run = dominantRun(el);
      fontResolved = resolveFont(run.style.family, run.text);
      ctx.font = run.style.style + ' ' + run.style.weight + ' ' + run.style.sizePx + 'px "' + fontResolved + '"';
      const m = ctx.measureText(run.text.trim() || CJK_SAMPLE);
      ascentPx = m.fontBoundingBoxAscent;
      descentPx = m.fontBoundingBoxDescent;
    }

    const lh = cs.lineHeight;
    let lineHeightUsedPx;
    if (lh === 'normal') {
      // Used line-height for `normal`: the measured first line box, else the
      // browser default factor approximation for empty blocks.
      lineHeightUsedPx = lineData && lineData.rects.length ? lineData.rects[0].h : parseFloat(cs.fontSize) * 1.15;
    } else {
      lineHeightUsedPx = parseFloat(lh) || 0;
    }

    const corners = [
      parseFloat(cs.borderTopLeftRadius) || 0,
      parseFloat(cs.borderTopRightRadius) || 0,
      parseFloat(cs.borderBottomRightRadius) || 0,
      parseFloat(cs.borderBottomLeftRadius) || 0,
    ];

    const attrs = {};
    if (tag === 'IMG') {
      attrs.src = el.currentSrc || el.getAttribute('src') || '';
      attrs.objectFit = cs.objectFit || 'fill';
    }
    if (tag === 'A') {
      attrs.href = el.getAttribute('href') || '';
    }
    if (tag === 'SPAN' || tag === 'A') {
      if (isInlineTextDescendant(el)) attrs.inline = true;
    }
    const notes = el.getAttribute('data-ppt-notes');
    if (notes) attrs.notes = notes;
    const chart = el.getAttribute('data-ppt-chart');
    if (chart) attrs.chart = chart;
    if (tag === 'UL' || tag === 'OL') attrs.listType = tag.toLowerCase();
    if (tag === 'LI') {
      let depth = 0;
      let p = el.parentElement;
      while (p && p !== document.body) {
        if (p.tagName === 'UL' || p.tagName === 'OL') depth++;
        p = p.parentElement;
      }
      attrs.depth = depth;
    }

    const element = {
      pptId,
      tag: tag.toLowerCase(),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      styles: {
        bg: cs.backgroundColor,
        color: cs.color,
        fontStack: cs.fontFamily,
        fontResolved,
        fontSizePx: parseFloat(cs.fontSize) || 0,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        lineHeightUsedPx,
        letterSpacingPx: cs.letterSpacing === 'normal' ? 0 : (parseFloat(cs.letterSpacing) || 0),
        textAlign: normalizeAlign(cs.textAlign),
        border: {
          top: borderSide(cs, 'top'),
          right: borderSide(cs, 'right'),
          bottom: borderSide(cs, 'bottom'),
          left: borderSide(cs, 'left'),
        },
        radiusPx: Math.max.apply(null, corners),
        shadow: cs.boxShadow === 'none' ? null : cs.boxShadow,
        opacity: parseFloat(cs.opacity),
        zIndex: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0),
        fontBoundingBoxAscentPx: ascentPx,
        fontBoundingBoxDescentPx: descentPx,
      },
      attrs,
    };
    if (isTextBlock) {
      let fullText = '';
      for (const node of ownTextNodes(el)) fullText += node.textContent;
      element.text = fullText;
    }
    elements.push(element);

    for (const child of el.children) walk(child);
  }

  if (document.body) walk(document.body);

  return { elements, lines, warnings, errors };
}

module.exports = { extractPageIR };
