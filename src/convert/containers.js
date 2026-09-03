'use strict';

/**
 * Element mappers: IR element → native PptxGenJS object.
 *
 * Emission order is (zIndex, DOM order) ascending — PptxGenJS has no z-index,
 * so add-order is paint order (later objects paint on top).
 */

const { pxToPt, pxToInch, rgbToHex } = require('./units.js');
const { emitText } = require('./text.js');

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'a', 'span']);

// Stable sort by (zIndex, DOM order). Array.prototype.sort is stable, so
// sorting by zIndex alone preserves DOM order for ties.
function sortElements(elements) {
  return elements
    .map((el, domIndex) => ({ el, domIndex }))
    .sort((a, b) => {
      const za = a.el.styles && a.el.styles.zIndex ? a.el.styles.zIndex : 0;
      const zb = b.el.styles && b.el.styles.zIndex ? b.el.styles.zIndex : 0;
      return za - zb || a.domIndex - b.domIndex;
    })
    .map((x) => x.el);
}

function hasSolidFill(styles) {
  const bg = styles && styles.bg;
  return !!bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
}

function hasBorder(styles) {
  const border = (styles && styles.border) || {};
  return ['top', 'right', 'bottom', 'left'].some((side) => {
    const b = border[side];
    return b && b.style !== 'none' && b.style !== 'hidden' && b.widthPx > 0;
  });
}

// Solid fill / border → rect; border-radius → roundRect.
function emitShape(slide, element, pptx) {
  const s = element.styles || {};
  const fill = hasSolidFill(s);
  const border = hasBorder(s);
  if (!fill && !border) return;
  const radiusPx = s.radiusPx || 0;
  const options = {
    x: pxToInch(element.rect.x),
    y: pxToInch(element.rect.y),
    w: pxToInch(element.rect.w),
    h: pxToInch(element.rect.h),
  };
  if (fill) {
    options.fill = { color: rgbToHex(s.bg) };
    if (typeof s.opacity === 'number' && s.opacity < 1) {
      options.fill.transparency = Math.round((1 - s.opacity) * 100);
    }
  }
  if (border) {
    const b = s.border.top;
    options.line = {
      color: rgbToHex(b.color) || '000000',
      width: pxToPt(b.widthPx),
    };
  }
  if (radiusPx > 0) {
    // rectRadius is 0..1 as a fraction of the smaller dimension.
    options.rectRadius = Math.min(1, radiusPx / Math.min(element.rect.w, element.rect.h));
  }
  slide.addShape(radiusPx > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, options);
}

// img: object-fit cover → cover sizing; contain → contain (fit).
function emitImage(slide, element) {
  const attrs = element.attrs || {};
  if (!attrs.src) return;
  const objectFit = attrs.objectFit || 'fill';
  const options = {
    path: attrs.src,
    x: pxToInch(element.rect.x),
    y: pxToInch(element.rect.y),
    w: pxToInch(element.rect.w),
    h: pxToInch(element.rect.h),
  };
  options.sizing = {
    type: objectFit === 'contain' ? 'contain' : 'cover',
    w: options.w,
    h: options.h,
  };
  slide.addImage(options);
}

// li: text with a bullet; nested li gets a deeper indentLevel.
function emitListItem(slide, element, lines, pptx) {
  const attrs = element.attrs || {};
  const listType = attrs.listType || 'ul';
  const depth = attrs.depth || 1;
  emitText(slide, element, lines[element.pptId], {
    firstRunExtra: { bullet: listType === 'ol' ? { type: 'number' } : true },
    boxExtra: { indentLevel: Math.max(0, depth - 1) },
  });
}

// Dispatch one IR element to its native PptxGenJS object(s).
function emitElement(slide, element, lines, pptx) {
  const tag = element.tag;
  const attrs = element.attrs || {};
  if (attrs.inline) return; // inline span/a: text already owned by an ancestor text block
  if (tag === 'img') {
    emitImage(slide, element);
    return;
  }
  emitShape(slide, element, pptx); // solid fill / border → rect / roundRect
  if (tag === 'li') {
    emitListItem(slide, element, lines, pptx);
    return;
  }
  if (tag === 'a' && attrs.href) {
    emitText(slide, element, lines[element.pptId], {
      runExtra: { hyperlink: { url: attrs.href } },
    });
    return;
  }
  const lineData = lines[element.pptId];
  if (lineData && lineData.count > 0) {
    emitText(slide, element, lineData);
  }
}

module.exports = { sortElements, emitElement, emitShape, emitImage, emitListItem, TEXT_TAGS };