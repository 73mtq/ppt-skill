'use strict';

/**
 * tokens-html.js — token schema validation + HTML constraint validation at the
 * IR level. Both are PURE functions (no I/O, no browser): they take the layout
 * IR produced by src/render.js and the frozen tokens, and return an array of
 * structured errors
 *
 *   {page, data-ppt-id, rule, measured, available, suggested_fix}
 *
 * An empty array means PASS. There are NO silent fallbacks: every violation is
 * an error that gates conversion (the CLI exits non-zero).
 *
 * Rule catalogue (1:1 with skill/references/html-constraints.md):
 *   lang-missing / page-size-mismatch / element-not-allowed / bare-text /
 *   gradient-on-text / cjk-letter-spacing / raster-with-text / chart-schema /
 *   chart-type-unsupported / style-forbidden / color-not-in-tokens /
 *   font-not-in-tokens / size-not-in-scale / token-schema
 */

const ALLOWED_TAGS = new Set(['body', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'img', 'a', 'span']);
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'a', 'span']);
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

// Design-system §3 type-scale ranges (px) on the 960x540 canvas.
const TYPE_SCALE_RANGES = {
  h1: [48, 64],
  h2: [32, 40],
  h3: [24, 28],
  body: [16, 18],
  small: [12, 14],
};
const SIZE_TOLERANCE_PX = 2;

// Design-system §2 font whitelist (Windows built-ins, English names only).
const FONT_WHITELIST = new Set([
  'Microsoft YaHei', 'DengXian', 'Segoe UI', 'Arial', 'Georgia', 'Consolas',
  'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'Microsoft JhengHei', 'PMingLiU',
]);

const REQUIRED_PALETTE = ['bg', 'surface', 'primary', 'accent', 'text', 'muted'];
const REQUIRED_FONTS = ['heading', 'body', 'latin', 'mono'];
const REQUIRED_TYPE_SCALE = ['h1', 'h2', 'h3', 'body', 'small'];

function err(page, id, rule, measured, available, suggested_fix) {
  return { page, 'data-ppt-id': id, rule, measured, available, suggested_fix };
}

// 'rgb(r,g,b)' / 'rgba(r,g,b,a)' / '#RGB' / '#RRGGBB' → '#RRGGBB' (uppercase);
// transparent / unknown → null (not a color violation).
function normalizeColor(c) {
  if (!c) return null;
  if (c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return '#' + m.slice(1).map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return '#' + c.slice(1).split('').map((ch) => ch + ch).join('').toUpperCase();
  }
  return null;
}

function isGradient(bg) {
  return typeof bg === 'string' && /gradient/i.test(bg);
}

function hasVisibleText(el) {
  return typeof el.text === 'string' && el.text.trim().length > 0;
}

function buildChildrenMap(elements) {
  const map = new Map();
  for (const el of elements) {
    const pid = el.parentId;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(el);
  }
  return map;
}

function hasTextDescendant(el, childrenMap) {
  if (hasVisibleText(el)) return true;
  const kids = childrenMap.get(el.pptId) || [];
  for (const k of kids) {
    if (hasTextDescendant(k, childrenMap)) return true;
  }
  return false;
}

function inTypeScale(sizePx) {
  for (const [min, max] of Object.values(TYPE_SCALE_RANGES)) {
    if (sizePx >= min - SIZE_TOLERANCE_PX && sizePx <= max + SIZE_TOLERANCE_PX) return true;
  }
  return false;
}

function typeScaleAvailable() {
  return Object.entries(TYPE_SCALE_RANGES)
    .map(([k, [min, max]]) => `${k} ${min}-${max}px`)
    .join(', ');
}

function dedupe(errors) {
  const seen = new Set();
  const out = [];
  for (const e of errors) {
    const key = JSON.stringify(e);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/**
 * Schema validation of a frozen tokens.json. Returns structured errors
 * (rule 'token-schema'); empty array = valid.
 */
function validateTokens(tokens) {
  const errors = [];
  const page = null;
  const id = null;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return [err(page, id, 'token-schema', typeof tokens, 'object', 'tokens.json must be a JSON object.')];
  }

  const ps = tokens.pageSize;
  if (!ps || typeof ps !== 'object' || typeof ps.w !== 'number' || typeof ps.h !== 'number' || ps.w <= 0 || ps.h <= 0) {
    errors.push(err(page, id, 'token-schema', JSON.stringify(ps), '{w:number,h:number}', 'pageSize must be {w,h} positive numbers (960x540 px).'));
  }

  const pal = tokens.palette;
  if (!pal || typeof pal !== 'object') {
    errors.push(err(page, id, 'token-schema', typeof pal, 'object', 'palette must be an object of hex colors.'));
  } else {
    for (const key of REQUIRED_PALETTE) {
      if (!(key in pal)) {
        errors.push(err(page, id, 'token-schema', `missing palette.${key}`, REQUIRED_PALETTE.join(', '), `Add palette.${key} (hex color).`));
      }
    }
    for (const [key, value] of Object.entries(pal)) {
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        errors.push(err(page, id, 'token-schema', `${key}=${JSON.stringify(value)}`, '#RRGGBB', `palette.${key} must be a 6-digit hex color.`));
      }
    }
  }

  const fonts = tokens.fonts;
  if (!fonts || typeof fonts !== 'object') {
    errors.push(err(page, id, 'token-schema', typeof fonts, 'object', 'fonts must be an object of font names.'));
  } else {
    for (const key of REQUIRED_FONTS) {
      if (!(key in fonts)) {
        errors.push(err(page, id, 'token-schema', `missing fonts.${key}`, REQUIRED_FONTS.join(', '), `Add fonts.${key}.`));
      }
    }
    for (const [key, value] of Object.entries(fonts)) {
      if (typeof value !== 'string' || !FONT_WHITELIST.has(value)) {
        errors.push(err(page, id, 'token-schema', `${key}=${JSON.stringify(value)}`, [...FONT_WHITELIST].join(', '), `fonts.${key} must be a Windows built-in font (see design-system.md §2).`));
      }
    }
  }

  const ts = tokens.typeScale;
  if (!ts || typeof ts !== 'object') {
    errors.push(err(page, id, 'token-schema', typeof ts, 'object', 'typeScale must be an object of px sizes.'));
  } else {
    for (const key of REQUIRED_TYPE_SCALE) {
      if (!(key in ts)) {
        errors.push(err(page, id, 'token-schema', `missing typeScale.${key}`, REQUIRED_TYPE_SCALE.join(', '), `Add typeScale.${key}.`));
      }
    }
    for (const [key, value] of Object.entries(ts)) {
      const range = TYPE_SCALE_RANGES[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(err(page, id, 'token-schema', `${key}=${JSON.stringify(value)}`, 'number', `typeScale.${key} must be a number.`));
      } else if (range && (value < range[0] || value > range[1])) {
        errors.push(err(page, id, 'token-schema', `${key}=${value}`, `${range[0]}..${range[1]}`, `typeScale.${key} must be within the design-system §3 range.`));
      }
    }
  }

  if (tokens.spacing !== 8) {
    errors.push(err(page, id, 'token-schema', tokens.spacing, 8, 'spacing must be 8 (8px grid).'));
  }

  return errors;
}

/**
 * HTML constraint validation at the IR level. Returns structured errors;
 * empty array = PASS. Render-level errors (ir.errors) are carried over because
 * they are hard constraint violations too (element-not-allowed, lang-missing).
 */
function validateHtmlIR(ir, tokens) {
  const errors = [];
  const page = ir && ir.page ? ir.page : null;
  const elements = ir && Array.isArray(ir.elements) ? ir.elements : [];
  const lines = ir && ir.lines ? ir.lines : {};
  const childrenMap = buildChildrenMap(elements);

  if (ir && Array.isArray(ir.errors)) errors.push(...ir.errors);

  // lang-missing
  if (!ir || ir.lang !== 'zh-CN') {
    errors.push(err(page, null, 'lang-missing', ir ? ir.lang : null, 'zh-CN', 'Add lang="zh-CN" to the <html> tag of this page.'));
  }

  // page-size-mismatch: the body's computed size must equal tokens.pageSize.
  const body = elements.find((e) => e.tag === 'body');
  if (body && tokens && tokens.pageSize) {
    const tw = tokens.pageSize.w;
    const th = tokens.pageSize.h;
    if (Math.abs(body.rect.w - tw) > 0.5 || Math.abs(body.rect.h - th) > 0.5) {
      errors.push(err(page, body.pptId, 'page-size-mismatch', `${body.rect.w}x${body.rect.h}`, `${tw}x${th}`, 'Set body { width:960px; height:540px; margin:0; }.'));
    }
  }

  // Token-derived whitelists.
  const allowedColors = new Set();
  if (tokens && tokens.palette) {
    for (const v of Object.values(tokens.palette)) {
      const n = normalizeColor(v);
      if (n) allowedColors.add(n);
    }
  }
  const allowedFonts = new Set();
  if (tokens && tokens.fonts) {
    for (const v of Object.values(tokens.fonts)) allowedFonts.add(v);
  }

  for (const el of elements) {
    const s = el.styles || {};
    const attrs = el.attrs || {};
    const id = el.pptId;

    // element-not-allowed (defense in depth; render already errors on these)
    if (!ALLOWED_TAGS.has(el.tag)) {
      errors.push(err(page, id, 'element-not-allowed', `<${el.tag}>`, 'body, div, h1-h6, p, ul, ol, li, img, a, span', 'Replace with an allowed element (see html-constraints.md §1.2).'));
    }

    // bare-text
    if (hasVisibleText(el) && !TEXT_TAGS.has(el.tag)) {
      errors.push(err(page, id, 'bare-text', el.text.trim(), 'p, h1-h6, li, a, span', 'Wrap the text in a p/span with data-ppt-id.'));
    }

    // gradient-on-text / raster-with-text
    const isGrad = isGradient(s.backgroundImage);
    const isClipText = s.backgroundClip === 'text';
    const isRasterCandidate = isGrad || (s.clipPath && s.clipPath !== 'none') || !!attrs.raster;
    if (hasVisibleText(el) && isGrad && isClipText) {
      errors.push(err(page, id, 'gradient-on-text', s.backgroundImage, 'solid color token', 'Use a solid palette color for text; gradients are only allowed on rasterized decoration layers.'));
    } else if (isRasterCandidate && !isClipText && hasTextDescendant(el, childrenMap)) {
      errors.push(err(page, id, 'raster-with-text', s.backgroundImage || s.clipPath || 'data-ppt-raster', 'decoration layer without text', 'Move text out of the rasterized container; rasterization is for pure decoration only.'));
    }

    // cjk-letter-spacing
    if (CJK_RE.test(el.text || '') && s.letterSpacingPx > s.fontSizePx * 0.02) {
      errors.push(err(page, id, 'cjk-letter-spacing', s.letterSpacingPx, `<= ${(s.fontSizePx * 0.02).toFixed(2)}px`, 'Keep CJK letter-spacing at or below 2% of the font size.'));
    }

    // style-forbidden (animation / backdrop-filter / CSS columns / fixed|sticky)
    if (s.position === 'fixed' || s.position === 'sticky') {
      errors.push(err(page, id, 'style-forbidden', `position:${s.position}`, 'static/relative/absolute', 'position:fixed/sticky has no PPTX equivalent; use absolute positioning.'));
    }
    if (s.backdropFilter && s.backdropFilter !== 'none') {
      errors.push(err(page, id, 'style-forbidden', `backdrop-filter:${s.backdropFilter}`, 'none', 'backdrop-filter has no PPTX equivalent; remove it.'));
    }
    if (s.columnCount > 1) {
      errors.push(err(page, id, 'style-forbidden', `columns:${s.columnCount}`, '1', 'CSS columns have no PPTX equivalent; use separate divs.'));
    }
    if (s.animationName && s.animationName !== 'none') {
      errors.push(err(page, id, 'style-forbidden', `animation:${s.animationName}`, 'none', 'Animations have no PPTX equivalent; the page must be static.'));
    }

    // color-not-in-tokens (bg / color / border sides)
    const colorCandidates = [s.bg, s.color];
    const border = s.border || {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (border[side] && border[side].color) colorCandidates.push(border[side].color);
    }
    for (const c of colorCandidates) {
      const n = normalizeColor(c);
      if (n && !allowedColors.has(n)) {
        errors.push(err(page, id, 'color-not-in-tokens', n, [...allowedColors].join(', '), 'Use a color from tokens.palette.'));
        break;
      }
    }

    // font-not-in-tokens
    if (s.fontResolved && !allowedFonts.has(s.fontResolved)) {
      errors.push(err(page, id, 'font-not-in-tokens', s.fontResolved, [...allowedFonts].join(', '), 'Use a font from tokens.fonts.'));
    }

    // size-not-in-scale
    if (s.fontSizePx > 0 && !inTypeScale(s.fontSizePx)) {
      errors.push(err(page, id, 'size-not-in-scale', s.fontSizePx, typeScaleAvailable(), 'Use a font size from the design-system §3 type scale.'));
    }

    // chart checks (data-ppt-chart)
    if (attrs.chart) {
      let parsed = null;
      try {
        parsed = JSON.parse(attrs.chart);
      } catch (e) {
        errors.push(err(page, id, 'chart-schema', attrs.chart, 'valid JSON {type,labels,series}', 'Fix the data-ppt-chart JSON (single-quote the attribute, double-quote inside).'));
      }
      if (parsed) {
        const schemaOk = parsed && typeof parsed === 'object' &&
          typeof parsed.type === 'string' &&
          Array.isArray(parsed.labels) && parsed.labels.length >= 1 &&
          Array.isArray(parsed.series) && parsed.series.length >= 1 &&
          parsed.series.every((ser) => ser && typeof ser.name === 'string' && Array.isArray(ser.data) && ser.data.length === parsed.labels.length);
        if (!schemaOk) {
          errors.push(err(page, id, 'chart-schema', attrs.chart, '{type:"bar|line",labels:[...],series:[{name,data}]}', 'Match the chart JSON schema (see html-constraints.md §3).'));
        } else if (parsed.type !== 'bar' && parsed.type !== 'line') {
          errors.push(err(page, id, 'chart-type-unsupported', parsed.type, 'bar, line', 'MVP supports only bar and line charts.'));
        }
      }
    }

    // Per-run checks (lines): CJK letter-spacing, font, size, color.
    const lineData = lines[el.pptId];
    if (lineData && Array.isArray(lineData.runs)) {
      for (const line of lineData.runs) {
        for (const run of line) {
          const rs = run.styles || {};
          if (CJK_RE.test(run.text || '') && rs.letterSpacingPx > rs.fontSizePx * 0.02) {
            errors.push(err(page, id, 'cjk-letter-spacing', rs.letterSpacingPx, `<= ${(rs.fontSizePx * 0.02).toFixed(2)}px`, 'Keep CJK letter-spacing at or below 2% of the font size.'));
          }
          if (rs.fontResolved && !allowedFonts.has(rs.fontResolved)) {
            errors.push(err(page, id, 'font-not-in-tokens', rs.fontResolved, [...allowedFonts].join(', '), 'Use a font from tokens.fonts.'));
          }
          if (rs.fontSizePx > 0 && !inTypeScale(rs.fontSizePx)) {
            errors.push(err(page, id, 'size-not-in-scale', rs.fontSizePx, typeScaleAvailable(), 'Use a font size from the design-system §3 type scale.'));
          }
          const n = normalizeColor(rs.color);
          if (n && !allowedColors.has(n)) {
            errors.push(err(page, id, 'color-not-in-tokens', n, [...allowedColors].join(', '), 'Use a color from tokens.palette.'));
          }
        }
      }
    }
  }

  return dedupe(errors);
}

module.exports = { validateTokens, validateHtmlIR, normalizeColor, TYPE_SCALE_RANGES, FONT_WHITELIST };