'use strict';

/**
 * raster — decoration-layer rasterization (backgrounds only).
 *
 * Rasterization is ONLY for pure decoration layers: a container div whose
 * computed style carries a linear/radial gradient, a clip-path, or an explicit
 * data-ppt-raster marker. An element containing VISIBLE text is NEVER
 * rasterized whole — that is a hard constraint error (raster-with-text).
 *
 * rasterizePage(ir, htmlPath, opts) re-opens the page in the same browser,
 * clones each candidate element (text nodes visibility:hidden — layout is
 * never removed), screenshots the clone at deviceScaleFactor 2, post-processes
 * with sharp (longest edge capped at 2560px; PNG when the image has real
 * transparency, JPEG q80 when fully opaque), and attaches
 *   el.raster = { imageData: Buffer, rect, format: 'png'|'jpeg', filename }
 * to the matching IR element. Errors are returned in the binding structured
 * shape {page, data-ppt-id, rule, measured, available, suggested_fix}.
 *
 * sharp is ONLY a post-processor here — HTML/CSS rendering is done by
 * Playwright's element.screenshot(), never by sharp.
 */

const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');

const VIEWPORT = { width: 960, height: 540 };
const GOTO_TIMEOUT_MS = 30000;
const FONT_READY_TIMEOUT_MS = 10000;
const MAX_EDGE_PX = 2560;
const JPEG_QUALITY = 80;

function toFileUrl(absPath) {
  const forward = absPath.replace(/\\/g, '/');
  // encodeURI keeps CJK paths working; POSIX paths already start with '/',
  // Windows drive paths need the third slash.
  const prefix = forward.startsWith('/') ? '' : '///';
  return 'file://' + prefix + encodeURI(forward);
}

// Browser-side (self-contained, serialized into the page): which IR elements
// are raster candidates, and does each contain visible text?
function detectCandidates(elements) {
  const results = [];
  for (const el of elements) {
    if (!el.rect || el.rect.w <= 0 || el.rect.h <= 0) continue;
    const dom = document.querySelector('[data-ppt-id="' + el.pptId + '"]');
    if (!dom) continue;
    const cs = getComputedStyle(dom);
    const bgImage = cs.backgroundImage || 'none';
    const isGradient = /linear-gradient|radial-gradient/i.test(bgImage);
    const hasClip = (cs.clipPath || 'none') !== 'none';
    const hasMarker = dom.hasAttribute('data-ppt-raster');
    if (!isGradient && !hasClip && !hasMarker) continue;
    // Visible text check: any rendered text node in the subtree.
    let hasVisibleText = false;
    const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const pcs = getComputedStyle(parent);
      if (pcs.visibility === 'hidden' || pcs.display === 'none') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0.5 && r.height > 0.5) {
        hasVisibleText = true;
        break;
      }
    }
    results.push({
      pptId: el.pptId,
      rect: el.rect,
      isGradient,
      hasClip,
      hasMarker,
      hasVisibleText,
    });
  }
  return results;
}

// Browser-side: clone the element, hide text nodes (never remove layout), pin
// the clone at the measured rect, and return the clone element handle.
async function cloneForScreenshot(page, pptId, rect) {
  const handle = await page.evaluateHandle(({ pptId, rect }) => {
    const orig = document.querySelector('[data-ppt-id="' + pptId + '"]');
    if (!orig) return null;
    const clone = orig.cloneNode(true);
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement) node.parentElement.style.visibility = 'hidden';
    }
    clone.style.position = 'fixed';
    clone.style.left = rect.x + 'px';
    clone.style.top = rect.y + 'px';
    clone.style.width = rect.w + 'px';
    clone.style.height = rect.h + 'px';
    clone.style.margin = '0';
    clone.style.transform = 'none';
    clone.style.zIndex = '2147483647';
    clone.setAttribute('data-ppt-raster-clone', '1');
    document.body.appendChild(clone);
    return clone;
  }, { pptId, rect });
  const elHandle = handle.asElement();
  if (!elHandle) {
    await handle.dispose();
    return null;
  }
  return elHandle;
}

async function screenshotClone(page, pptId, rect) {
  const elHandle = await cloneForScreenshot(page, pptId, rect);
  if (!elHandle) return null;
  try {
    // Two frames so the clone's styles settle before capturing.
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    return await elHandle.screenshot();
  } finally {
    await page.evaluate(() => {
      const c = document.querySelector('[data-ppt-raster-clone="1"]');
      if (c) c.remove();
    });
    await elHandle.dispose();
  }
}

// sharp post-processing: cap longest edge at 2560px; PNG when the image has
// real transparency (any pixel alpha < 255), JPEG q80 when fully opaque.
async function postProcess(pngBuffer) {
  const meta = await sharp(pngBuffer).metadata();
  const stats = await sharp(pngBuffer).stats();
  const hasTransparency = stats.channels.length >= 4 ? stats.channels[3].min < 255 : false;
  const longest = Math.max(meta.width || 0, meta.height || 0);
  let pipeline = sharp(pngBuffer);
  if (longest > MAX_EDGE_PX) {
    const scale = MAX_EDGE_PX / longest;
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round((meta.width || 0) * scale)),
      height: Math.max(1, Math.round((meta.height || 0) * scale)),
    });
  }
  const format = hasTransparency ? 'png' : 'jpeg';
  const imageData = hasTransparency
    ? await pipeline.png().toBuffer()
    : await pipeline.flatten({ background: '#FFFFFF' }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  return { imageData, format };
}

// Suggested relative filename (todo 8 owns writing it under assets/).
function suggestedFilename(page, pptId, format) {
  const base = String(page || 'page').replace(/\.html$/i, '');
  return 'assets/' + base + '-' + pptId + '.' + format;
}

/**
 * Rasterize every decoration-layer candidate in the IR.
 *
 * Returns { ir, errors } — the same IR object with el.raster attached to each
 * rasterized element, plus the structured errors (raster-with-text etc.).
 * Reuses opts.browser when given; otherwise launches and closes a one-shot
 * browser. Everything is closed in finally (no leaked browsers).
 */
async function rasterizePage(ir, htmlPath, opts = {}) {
  const absPath = path.resolve(htmlPath);
  const fileUrl = toFileUrl(absPath);
  const errors = [];
  let ownedBrowser = null;
  const browser = opts.browser || (ownedBrowser = await chromium.launch({ headless: true }));
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    try {
      await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });
      await page.addStyleTag({
        content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
      });
      await page.evaluate((timeoutMs) => Promise.race([
        document.fonts.ready.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]), FONT_READY_TIMEOUT_MS);
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));

      const elements = (ir.elements || []).map((e) => ({ pptId: e.pptId, rect: e.rect }));
      const candidates = await page.evaluate(detectCandidates, elements);
      for (const cand of candidates) {
        if (cand.hasVisibleText) {
          errors.push({
            page: ir.page,
            'data-ppt-id': cand.pptId,
            rule: 'raster-with-text',
            measured: 'visible text inside raster container',
            available: 'text-free decoration layer',
            suggested_fix: 'split: rasterize the background layer only, keep text native (move text to a sibling element above the raster div)',
          });
          continue;
        }
        const shot = await screenshotClone(page, cand.pptId, cand.rect);
        if (!shot) continue;
        const processed = await postProcess(shot);
        const el = (ir.elements || []).find((e) => e.pptId === cand.pptId);
        if (el) {
          el.raster = {
            imageData: processed.imageData,
            rect: { x: cand.rect.x, y: cand.rect.y, w: cand.rect.w, h: cand.rect.h },
            format: processed.format,
            filename: suggestedFilename(ir.page, cand.pptId, processed.format),
          };
        }
      }
    } finally {
      await page.close();
    }
  } finally {
    if (ownedBrowser) await ownedBrowser.close();
  }
  return { ir, errors };
}

module.exports = { rasterizePage, postProcess, suggestedFilename, MAX_EDGE_PX };