/**
 * css.test.ts — layer 2: the stylesheet's load-bearing rules.
 *
 * These are string assertions on `src/css.ts`, which is unusual enough to
 * justify a note: the CSS is DATA here, not code. It's copied verbatim from a
 * stylesheet that was proven on real paper, and every rule in it exists because
 * its absence produced a bad sheet.
 *
 * The specific risk being defended against: a future contributor (or a CSS
 * formatter, or an "unused rule" linter) deleting a rule that looks redundant
 * because the class name appears nowhere in the TypeScript. `@media print`
 * rules never appear in the source, so they look dead. They are not.
 *
 * Each assertion carries its why, so nobody has to go and find out.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRINT_CSS } from '../css';

/** The stylesheet with comments stripped, so a rule can't pass by being mentioned in prose. */
const CSS = PRINT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

test('the print stylesheet is embedded in the bundle', () => {
  assert.ok(PRINT_CSS.length > 4000, 'stylesheet looks truncated or missing');
  assert.ok(CSS.includes('@media print'), 'no @media print block at all');
});

test('@page declares A4 and a real margin box', () => {
  // WKWebView ignores @page for the page box, so the Swift shim parses this rule
  // instead. If this changes shape, the shim's regexes must change with it — and
  // that pairing is the reason this assertion exists.
  assert.match(CSS, /@page\s*\{/, 'no @page rule: the shim would fall back to its own defaults');
  assert.match(CSS, /size:\s*A4/, '@page must name A4 or the shim cannot set the page size');
  assert.match(CSS, /margin:\s*[0-9.]+mm/, '@page must declare a margin box in mm');
});

test('BUG right-edge clip: the print block constrains content to the column', () => {
  // Without a width constraint inside @media print, content lays out at the full
  // page width and anything wider is sliced off at the right paper edge. This is
  // the bug that produced a clipped real sheet.
  assert.match(CSS, /@media print/, 'no print block');
  const printBlock = CSS.slice(CSS.indexOf('@media print'));
  assert.match(
    printBlock,
    /(max-width|width)\s*:\s*100%/,
    'print block must constrain content width or the right edge clips'
  );
});

test('BUG only page 1 printed: display:block is forced in print', () => {
  const printBlock = CSS.slice(CSS.indexOf('@media print'));
  assert.match(
    printBlock,
    /display:\s*block/,
    'the display:block fix is what stopped the printer emitting a single page'
  );
});

test('BUG code bleed: pre wraps in print', () => {
  const printBlock = CSS.slice(CSS.indexOf('@media print'));
  assert.match(
    printBlock,
    /pre[\s\S]{0,200}white-space:\s*pre-wrap/,
    'without pre-wrap, long code lines run off the right edge of the paper'
  );
  assert.match(
    printBlock,
    /overflow-wrap:\s*anywhere|word-wrap:\s*break-word|word-break:\s*break-word/,
    'unbroken strings need an overflow-wrap/word-break rule to wrap inside the column'
  );
});

test('BUG dark mode: tokens are re-pinned to light inside print', () => {
  const printBlock = CSS.slice(CSS.indexOf('@media print'));
  assert.match(
    printBlock,
    /:root\s*\{/,
    'print block must re-declare :root tokens, or a dark theme prints dark backgrounds'
  );
});

test('self-contained: no external font, image, or stylesheet references', () => {
  // The document is rendered from a temp file with no network access and no
  // guarantee of any asset being present, so a remote reference would silently
  // change the layout of every print.
  assert.ok(!/url\(\s*['"]?https?:/i.test(CSS), 'stylesheet references a remote URL');
  assert.ok(!/@import/i.test(CSS), 'stylesheet imports another stylesheet');
});

test('there is exactly one @page block, not a :left/:right/:first split the shim cannot honour', () => {
  // The Swift shim (see shim.swift's @page-parsing comment) reads every
  // @page block it finds in file order and lets a later declaration win —
  // it has no concept of facing pages or a first-page exception, so a
  // `@page :left { margin-left:20mm }` / `@page :right { margin-right:20mm }`
  // split doesn't produce roomier inner margins for stapling: it silently
  // blends into one set of margins that matches neither side. A single
  // block is the only version of this stylesheet that says what actually
  // happens when the shim reads it.
  const pageBlocks = CSS.match(/@page[^{]*\{/g) ?? [];
  assert.equal(pageBlocks.length, 1, `expected exactly one @page block, found ${pageBlocks.length}`);
  assert.doesNotMatch(
    CSS,
    /@page\s*:(left|right|first)/,
    'a @page pseudo-class split reappeared — the shim cannot honour it, see the note above @page in css.ts'
  );
});

test('the footer is fixed-position so it lands on every page', () => {
  assert.match(CSS, /\.page-footer/, 'footer styling is gone');
  assert.match(CSS, /\.page-footer[\s\S]{0,200}position:\s*fixed/, 'the footer must be fixed to repeat per page');
});

test('the page size stays A4 and never becomes a fixed mm box', () => {
  // A fixed mm page size is exactly how the paper shrank to 179.9mm wide once
  // already: sizing the rasterisation rect to the content produced smaller
  // paper. The page box stays A4; the margins do the insetting.
  const pageRules = CSS.match(/@page[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(pageRules.length > 0, 'no @page rules found');
  for (const rule of pageRules) {
    assert.ok(
      !/size:\s*[0-9.]+mm/.test(rule),
      `a @page rule names an absolute page size instead of A4: ${rule}`
    );
  }
  assert.match(CSS, /@page\s*\{[^}]*size:\s*A4/, 'the base @page rule must keep size:A4');
});

test('screen rules never set page geometry', () => {
  // @page is the only authority on paper size and margins. A screen rule that
  // also sets page geometry is a second, conflicting one.
  const firstPageRule = CSS.indexOf('@page');
  assert.ok(firstPageRule > 0, 'no @page rule');
  const screenBlock = CSS.slice(0, firstPageRule);
  assert.ok(!/size:\s*A4/.test(screenBlock), 'A4 declared outside an @page rule');
});
