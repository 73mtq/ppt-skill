'use strict';

/**
 * IR → pptxgen slide. buildPresentation(irPages, tokens) is the pure entry
 * point: it returns a pptxgen instance (no file I/O — file writing is owned
 * by the CLI layer). Conversion is deterministic: no Date.now / Math.random
 * anywhere in the output.
 *
 * Emission order (paint order = add order):
 *   1. raster decoration layers (el.raster) — always BEFORE overlaid native
 *      text, so a rasterized gradient background sits under the text;
 *   2. native shapes / text / images / charts in (zIndex, DOM order).
 */

const PptxGenJS = require('pptxgenjs');
const { sortElements, emitElement, emitShape } = require('./containers.js');
const { emitChart } = require('./chart.js');
const { pxToInch } = require('./units.js');

// Raster image: el.raster = { imageData: Buffer, rect, format, filename }.
// pptxgenjs addImage `data` must be a base64 data-URI string.
function emitRasterImage(slide, element) {
  const raster = element.raster;
  if (!raster || !raster.imageData) return;
  const mime = raster.format === 'png' ? 'image/png' : 'image/jpeg';
  const data = mime + ';base64,' + raster.imageData.toString('base64');
  slide.addImage({
    data,
    x: pxToInch(raster.rect.x),
    y: pxToInch(raster.rect.y),
    w: pxToInch(raster.rect.w),
    h: pxToInch(raster.rect.h),
  });
}

function buildSlide(pptx, irPage, tokens) {
  const slide = pptx.addSlide();
  const lines = irPage.lines || {};
  const elements = sortElements(irPage.elements || []);
  // Pass 1: raster decoration layers — always before overlaid native text.
  for (const el of elements) {
    if (el.raster) emitRasterImage(slide, el);
  }
  // Pass 2: native shapes / text / images / charts.
  for (const el of elements) {
    if (el.raster) continue; // fully represented by its raster image
    const attrs = el.attrs || {};
    if (attrs.chart) {
      // Container background shape first, then the native chart at its rect.
      emitShape(slide, el, pptx);
      emitChart(slide, el, attrs.chart, irPage, tokens);
      continue;
    }
    emitElement(slide, el, lines, pptx);
  }
  const notes = (irPage.elements || [])
    .filter((e) => e.attrs && e.attrs.notes)
    .map((e) => e.attrs.notes);
  if (notes.length) slide.addNotes(notes.join('\n'));
  return slide;
}

function buildPresentation(irPages, tokens) {
  const pptx = new PptxGenJS();
  // 10 x 5.625 in = 720 x 405 pt; 1px = 0.75pt; x/y/w/h in inches = px*0.75/72.
  pptx.layout = 'LAYOUT_16x9';
  for (const irPage of irPages) {
    buildSlide(pptx, irPage, tokens);
  }
  return pptx;
}

module.exports = { buildPresentation, buildSlide, emitRasterImage };