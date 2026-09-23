/**
 * toc.test.ts — heading ids and the generated table of contents.
 *
 * The load-bearing property under test throughout: this is all GATED behind a
 * shell actually asking for `{{mdprint:toc}}`. Two calls to buildHtml() with
 * the SAME markdown must differ only in that one spot — proving the opt-in
 * contract directly, rather than trusting it by construction.
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { addHeadingIds, buildHtml, renderBlocks, renderToc, splitFrontmatter } from '../renderer';

const FIXED = new Date(Date.UTC(2026, 8, 22, 12, 0, 0));

const MD = [
  '# Overview',
  '',
  'Top matter.',
  '',
  '## Details',
  '',
  'More text.',
  '',
  '### Overview',
  '',
  'A repeated heading, on purpose — proves collision handling.',
  '',
  '#### Too Deep',
  '',
  'h4 must not get an id or appear in the TOC.',
  '',
].join('\n');

function contentFor(md: string): string {
  return renderBlocks(splitFrontmatter(md).body);
}

test('addHeadingIds covers h1-h3 and leaves h4 untouched', () => {
  const { html, headings } = addHeadingIds(contentFor(MD));

  assert.equal(headings.length, 3, 'h4 must not be collected');
  assert.deepEqual(
    headings.map((h) => h.level),
    [1, 2, 3]
  );
  assert.ok(!/<h4 id=/.test(html), 'h4 must not get an id');
  assert.match(html, /<h4>Too Deep<\/h4>/, 'h4 is left exactly as renderBlocks produced it');
});

test('a repeated heading text gets a numeric-suffixed slug, not a collision', () => {
  const { headings } = addHeadingIds(contentFor(MD));

  assert.equal(headings[0].slug, 'overview');
  assert.equal(headings[2].slug, 'overview-2', 'the second "Overview" must not silently reuse the first slug');
});

test('slugs strip markup and punctuation', () => {
  const { headings } = addHeadingIds(contentFor('# Hello, `World`!\n\nbody\n'));
  assert.equal(headings[0].slug, 'hello-world');
});

test('renderToc nests h1 > h2 > h3 without inventing wrapper levels', () => {
  const { headings } = addHeadingIds(contentFor(MD));
  const toc = renderToc(headings);

  assert.equal((toc.match(/<ul/g) ?? []).length, 3, 'one <ul> per nesting depth');
  assert.equal((toc.match(/<\/ul>/g) ?? []).length, 3);
  assert.equal((toc.match(/<li>/g) ?? []).length, 3);
  assert.match(toc, /<a href="#overview">Overview<\/a>/);
  assert.match(toc, /<a href="#overview-2">Overview<\/a>/);
});

test('a skipped level (h1 straight to h3) nests directly, with no invented h2 wrapper', () => {
  const toc = renderToc([
    { level: 1, text: 'A', slug: 'a' },
    { level: 3, text: 'B', slug: 'b' },
  ]);

  // Exactly two <ul>s: the outer one for A, one more for B nesting inside —
  // never three, which would mean a phantom level was invented for the gap.
  assert.equal((toc.match(/<ul/g) ?? []).length, 2);
  assert.equal((toc.match(/<\/ul>/g) ?? []).length, 2);
});

test('renderToc of an empty heading list is an empty string', () => {
  assert.equal(renderToc([]), '');
});

test('buildHtml with no shell override never emits heading ids or a TOC', () => {
  const html = buildHtml(MD, 'proof.md', { now: FIXED, css: '' });

  assert.ok(!/<h[1-6] id=/.test(html), 'default render must not add heading ids');
  assert.ok(!html.includes('mdprint-toc'), 'default render must not emit a TOC');
});

test('a shell using {{mdprint:toc}} gets heading ids and a rendered TOC — same markdown, different output', () => {
  const shell = [
    '<section class="cover"><h1>{{mdprint:title}}</h1><p>{{mdprint:date}}</p></section>',
    '{{mdprint:toc}}',
    '<main>{{mdprint:header}}{{mdprint:content}}</main>',
    '{{mdprint:footer}}',
  ].join('\n');

  const withoutShell = buildHtml(MD, 'proof.md', { now: FIXED, css: '' });
  const withShell = buildHtml(MD, 'proof.md', { now: FIXED, css: '', shell });

  assert.ok(!withoutShell.includes('mdprint-toc'), 'the unmodified call must stay untouched');

  assert.ok(withShell.includes('class="cover"'), 'the cover section from the custom shell must appear');
  assert.ok(withShell.includes('mdprint-toc'), 'the TOC must be rendered when the shell asks for it');
  assert.match(withShell, /<h1 id="overview">Overview<\/h1>/, 'headings must carry ids when a TOC is in play');
  assert.ok(withShell.includes('class="page-footer"'), 'the footer token must still resolve to the real footer');
  assert.match(withShell, /<a href="#overview">Overview<\/a>/, 'the TOC must link to the heading it names');
});
