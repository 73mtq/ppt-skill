'use strict';

// corpus-static.test.js — static assertions over the 12 golden corpus fixture pages.
// Pure fs: requires only node built-ins, never src/ or playwright.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGES_DIR = path.join(__dirname, '..', 'corpus', 'pages');
const FILES = ['01.html', '02.html', '03.html', '04.html', '05.html', '06.html', '07.html', '08.html', '09.html', '10.html', '11.html', '12.html'];
const TEXT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'a', 'span'];

function stripWhitespace(s) {
  return s.replace(/\s+/g, '');
}

for (const file of FILES) {
  test(`corpus-static ${file}`, () => {
    const html = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');

    // (a) lang="zh-CN" present
    assert.ok(html.includes('lang="zh-CN"'), `${file}: lang="zh-CN" missing`);

    // (b) body CSS rule contains width:960px and height:540px (whitespace-insensitive)
    const m = html.match(/body\s*\{([^}]*)\}/);
    assert.ok(m, `${file}: body CSS rule not found`);
    const bodyCss = stripWhitespace(m[1]);
    assert.ok(bodyCss.includes('width:960px'), `${file}: body width 960px missing`);
    assert.ok(bodyCss.includes('height:540px'), `${file}: body height 540px missing`);

    // (c) no bare text outside p/h1-h6/li/a/span
    let s = html.replace(/<head[\s\S]*?<\/head>/i, '');
    for (const t of TEXT_TAGS) {
      s = s.replace(new RegExp(`<${t}(\\s[^>]*)?>[\\s\\S]*?</${t}>`, 'gi'), '');
    }
    s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim();
    assert.strictEqual(s, '', `${file}: bare text outside text elements: "${s.slice(0, 80)}"`);

    // (d) every opening text tag carries data-ppt-id
    const openRe = new RegExp('<(' + TEXT_TAGS.join('|') + ')((?:\\s[^>]*)?)>', 'gi');
    let om;
    while ((om = openRe.exec(html)) !== null) {
      assert.ok(
        /\bdata-ppt-id="[^"]+"/.test(om[2] || ''),
        `${file}: <${om[1]}> at offset ${om.index} lacks data-ppt-id`
      );
    }

    // (e) every data-ppt-chart value parses as JSON with type bar|line
    const chartRe = /data-ppt-chart=(["'])([\s\S]*?)\1/g;
    let cm;
    while ((cm = chartRe.exec(html)) !== null) {
      let chart;
      assert.doesNotThrow(() => { chart = JSON.parse(cm[2]); }, `${file}: data-ppt-chart is not valid JSON`);
      assert.ok(
        chart && (chart.type === 'bar' || chart.type === 'line'),
        `${file}: chart type must be bar|line, got ${chart && chart.type}`
      );
    }

    // (f) no <table> anywhere
    assert.ok(!html.toLowerCase().includes('<table'), `${file}: <table> is forbidden`);
  });
}
