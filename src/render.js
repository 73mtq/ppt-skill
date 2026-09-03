'use strict';

/**
 * render — browser measurement layer (HTML → layout IR).
 *
 * renderPage(htmlPath, opts) renders the page in headless chromium
 * (viewport 960x540 CSS px, deviceScaleFactor 1), waits for networkidle AND
 * document.fonts.ready, injects CSS disabling animations/transitions, then
 * extracts the allowlisted element tree into the binding IR schema:
 *
 *   { page, size: {w, h},
 *     elements: [{pptId, tag, rect: {x,y,w,h}, styles: {...}}],
 *     lines: {[pptId]: {count, rects}},
 *     warnings: [], errors: [] }
 *
 * errors/warnings use the structured shape
 *   {page, data-ppt-id, rule, measured, available, suggested_fix}.
 * Non-empty `errors` marks a hard constraint violation (the CLI exits
 * non-zero); measurement data is still returned for diagnosis.
 *
 * opts.browser: reuse an existing playwright chromium browser (the CLI loops
 * pages in one browser). Otherwise a one-shot browser is launched and closed.
 */

const path = require('node:path');
const { chromium } = require('playwright');
const { extractPageIR } = require('./render/page-extract.js');

const VIEWPORT = { width: 960, height: 540 };
const GOTO_TIMEOUT_MS = 30000;
const FONT_READY_TIMEOUT_MS = 10000;
const IMAGE_TIMEOUT_MS = 10000;

function toFileUrl(absPath) {
  const forward = absPath.replace(/\\/g, '/');
  // encodeURI keeps CJK paths working (chars are percent-encoded); POSIX paths
  // already start with '/', Windows drive paths need the third slash.
  const prefix = forward.startsWith('/') ? '' : '///';
  return 'file://' + prefix + encodeURI(forward);
}

// file:///D:/a/b.png → D:\a\b.png (Windows) or /a/b.png (POSIX).
function fromFileUrl(fileUrl) {
  try {
    const u = new URL(fileUrl);
    if (u.protocol !== 'file:') return fileUrl;
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // strip leading slash before drive letter
    return p.replace(/\//g, path.sep);
  } catch (e) {
    return fileUrl;
  }
}

async function renderPage(htmlPath, opts = {}) {
  const absPath = path.resolve(htmlPath);
  const pageName = path.basename(absPath);
  const fileUrl = toFileUrl(absPath);

  let ownedBrowser = null;
  const browser = opts.browser || (ownedBrowser = await chromium.launch({ headless: true }));

  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    try {
      await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });
      await page.addStyleTag({
        content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
      });
      // document.fonts.ready can hang on a broken font stack; race it against a timer.
      await page.evaluate((timeoutMs) => Promise.race([
        document.fonts.ready.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]), FONT_READY_TIMEOUT_MS);
      // Image load can hang on a stalled request; bound it too.
      await page.evaluate((timeoutMs) => Promise.race([
        Promise.all(
          Array.from(document.images).map((img) => (
            img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve; })
          ))
        ),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]), IMAGE_TIMEOUT_MS);
      // Two frames so disabled transitions/styles settle before measuring.
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const extracted = await page.evaluate(extractPageIR);
      // Resolve img srcs to absolute filesystem paths (the browser reports a
      // file:// URL; PptxGenJS needs a path it can readFileSync).
      for (const el of extracted.elements) {
        if (el.tag === 'img' && el.attrs && el.attrs.src) {
          const src = el.attrs.src;
          if (/^file:/i.test(src)) {
            el.attrs.src = fromFileUrl(src);
          } else if (!/^(https?:|data:)/i.test(src)) {
            el.attrs.src = path.resolve(path.dirname(absPath), src);
          }
        }
      }
      return {
        page: pageName,
        size: { w: VIEWPORT.width, h: VIEWPORT.height },
        elements: extracted.elements,
        lines: extracted.lines,
        warnings: extracted.warnings.map((w) => ({ ...w, page: pageName })),
        errors: extracted.errors.map((e) => ({ ...e, page: pageName })),
      };
    } finally {
      await page.close();
    }
  } finally {
    if (ownedBrowser) await ownedBrowser.close();
  }
}

module.exports = { renderPage, VIEWPORT };
