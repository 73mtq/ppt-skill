'use strict';

/**
 * IR → pptxgen slide. buildPresentation(irPages, tokens) is the pure entry
 * point: it returns a pptxgen instance (no file I/O — file writing is owned
 * by the CLI layer). Conversion is deterministic: no Date.now / Math.random
 * anywhere in the output.
 */

const PptxGenJS = require('pptxgenjs');
const { sortElements, emitElement } = require('./containers.js');

function buildSlide(pptx, irPage) {
  const slide = pptx.addSlide();
  const lines = irPage.lines || {};
  const elements = sortElements(irPage.elements || []);
  for (const el of elements) {
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
    buildSlide(pptx, irPage);
  }
  return pptx;
}

module.exports = { buildPresentation, buildSlide };