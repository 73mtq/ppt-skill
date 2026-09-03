'use strict';

/**
 * Native chart emission (data-ppt-chart).
 *
 * data-ppt-chart carries a JSON string per skill/references/html-constraints.md
 * §3:
 *   { "type": "bar" | "line",
 *     "labels": ["Q1", ...],
 *     "series": [{ "name": "...", "data": [n, ...] }, ...] }
 *
 * parseChart validates the schema (malformed JSON → chart-schema; type other
 * than bar/line → chart-type-unsupported). emitChart maps the container rect
 * to a NATIVE pptxgenjs chart (c:barChart / c:lineChart in the chart XML) —
 * never a rendered image. Colors/fonts are injected from tokens (todo 8 wires
 * the real tokens; missing tokens fall back to the default business palette).
 */

const { pxToInch } = require('./units.js');

const SUPPORTED_TYPES = new Set(['bar', 'line']);
const DEFAULT_CHART_COLORS = ['1F4E79', 'DDBB4F', '3A6EA5', 'C9A227'];
const DEFAULT_CHART_FONT = 'Microsoft YaHei';

function schemaError(element, measured) {
  return {
    'data-ppt-id': element.pptId,
    rule: 'chart-schema',
    measured,
    available: '{"type":"bar|line","labels":string[],"series":[{name,data:number[]}]}',
    suggested_fix: 'Rewrite data-ppt-chart per skill/references/html-constraints.md §3 (single-quoted JSON in the attribute).',
  };
}

/**
 * Parse + validate a data-ppt-chart attribute value.
 * Returns { ok: true, chartData } or { ok: false, error } where error is the
 * structured shape {data-ppt-id, rule, measured, available, suggested_fix}.
 */
function parseChart(raw, element) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: schemaError(element, raw) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: schemaError(element, raw) };
  }
  const type = data.type;
  if (!SUPPORTED_TYPES.has(type)) {
    return {
      ok: false,
      error: {
        'data-ppt-id': element.pptId,
        rule: 'chart-type-unsupported',
        measured: type,
        available: 'bar, line',
        suggested_fix: 'MVP supports bar/line only',
      },
    };
  }
  if (!Array.isArray(data.labels) || data.labels.length === 0) {
    return { ok: false, error: schemaError(element, 'labels') };
  }
  if (!Array.isArray(data.series) || data.series.length === 0) {
    return { ok: false, error: schemaError(element, 'series') };
  }
  for (const s of data.series) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !Array.isArray(s.data)) {
      return { ok: false, error: schemaError(element, JSON.stringify(s)) };
    }
    if (s.data.length !== data.labels.length) {
      return {
        ok: false,
        error: schemaError(element, 'series "' + s.name + '" data length ' + s.data.length + ' != labels length ' + data.labels.length),
      };
    }
    for (const v of s.data) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, error: schemaError(element, 'non-number value ' + JSON.stringify(v)) };
      }
    }
  }
  return { ok: true, chartData: { type, labels: data.labels, series: data.series } };
}

// Chart colors from tokens.palette (strip '#'); fall back to the default
// business blue-gold palette when tokens are absent.
function chartColorsFromTokens(tokens) {
  const palette = (tokens && tokens.palette) || {};
  const strip = (c) => (typeof c === 'string' ? c.replace(/^#/, '') : '');
  const colors = [
    strip(palette.primary),
    strip(palette.accentLight),
    strip(palette.primaryLight),
    strip(palette.accent),
    strip(palette.accentDark),
  ].filter(Boolean);
  return colors.length ? colors : DEFAULT_CHART_COLORS;
}

function chartFontFromTokens(tokens) {
  const fonts = (tokens && tokens.fonts) || {};
  return fonts.chart || fonts.body || fonts.heading || DEFAULT_CHART_FONT;
}

/**
 * Emit a native chart at the container rect. Throws a structured error
 * (embedded as JSON in the message) when the chart JSON is invalid.
 */
function emitChart(slide, element, raw, irPage, tokens) {
  const result = parseChart(raw, element);
  if (!result.ok) {
    const err = { page: irPage ? irPage.page : null, ...result.error };
    throw new Error('convert: chart error ' + JSON.stringify(err));
  }
  const { type, labels, series } = result.chartData;
  const data = series.map((s) => ({ name: s.name, labels, values: s.data }));
  const fontFace = chartFontFromTokens(tokens);
  const options = {
    x: pxToInch(element.rect.x),
    y: pxToInch(element.rect.y),
    w: pxToInch(element.rect.w),
    h: pxToInch(element.rect.h),
    chartColors: chartColorsFromTokens(tokens),
    showLegend: series.length > 1,
    legendPos: 'b',
    showTitle: false,
    showValue: false,
    catAxisLabelFontFace: fontFace,
    catAxisLabelFontSize: 10,
    catAxisLabelColor: '595959',
    valAxisLabelFontFace: fontFace,
    valAxisLabelFontSize: 10,
    valAxisLabelColor: '595959',
  };
  slide.addChart(type, data, options);
}

module.exports = { parseChart, emitChart, chartColorsFromTokens, chartFontFromTokens, SUPPORTED_TYPES };