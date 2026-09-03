'use strict';

/**
 * Unit conversion helpers shared by the convert layer.
 *
 * The canvas is 960x540 CSS px = 720x405 pt = 10x5.625 in (LAYOUT_16x9).
 * 1px = 0.75pt; 1in = 72pt = 96px.
 */

const PT_PER_PX = 0.75;
const PX_PER_IN = 96;

function pxToPt(px) {
  return px * PT_PER_PX;
}

function pxToInch(px) {
  return px / PX_PER_IN;
}

// 'rgb(r, g, b)' / 'rgba(r, g, b, a)' → 'RRGGBB'; transparent → null.
function rgbToHex(rgb) {
  if (!rgb) return null;
  if (rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return null;
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return m.slice(1).map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

module.exports = { PT_PER_PX, PX_PER_IN, pxToPt, pxToInch, rgbToHex };