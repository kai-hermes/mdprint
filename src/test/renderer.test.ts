/**
 * renderer.test.ts — layer 1: the renderer against golden HTML.
 *
 * Each fixture is a document that once produced a bad SHEET OF PAPER. The
 * golden file records what the renderer did when the layout was known-good.
 * When a test here goes red, the question is never "how do I make it green" —
 * it's "did I change the output on purpose, and is the new output better on
 * paper?" See the regeneration rule at the bottom of this file.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { PRINT_CSS } from '../css';
import { buildHtml, inline, renderBlocks, splitFrontmatter, titleFromFilename } from '../renderer';
import { FIXTURE_DIR, diffLines, fixture, fixtureNames, squash, unbalancedTags, writeActual } from './runner';

/** Fixed clock and no stylesheet, so the golden files are stable and small. */
const FIXED = new Date(Date.UTC(2026, 8, 22, 12, 0, 0));

function renderFixture(name: string, css = ''): string {
  return buildHtml(fixture(name), name, { now: FIXED, css });
}

test('every fixture renders and is structurally sound', () => {
  for (const name of fixtureNames()) {
    const html = renderFixture(name);
    assert.ok(html.length > 0, `${name} produced no output`);

    const problems = unbalancedTags(html);
    assert.deepEqual(problems, [], `${name} has unbalanced tags`);

    assert.ok(html.includes('<body>'), `${name} lost its body`);
    assert.ok(html.includes('</html>'), `${name} is truncated`);
  }
});

test('golden fixtures match', () => {
  const failures: string[] = [];

  for (const name of fixtureNames()) {
    const goldenPath = path.join(FIXTURE_DIR, name.replace(/\.md$/, '.html'));
    const actual = renderFixture(name);

    if (!fs.existsSync(goldenPath)) {
      writeActual(name.replace(/\.md$/, '.html'), actual);
      failures.push(`${name}: no golden file — wrote .actual/${name.replace(/\.md$/, '.html')}`);
      continue;
    }

    const expected = fs.readFileSync(goldenPath, 'utf8');
    if (squash(expected) !== squash(actual)) {
      const file = writeActual(name.replace(/\.md$/, '.html'), actual);
      failures.push(`${name}:\n${diffLines(expected, actual)}\n  full output: ${file}`);
    }
  }

  assert.deepEqual(failures, [], failures.join('\n\n'));
});

// ------------------------------------------------------------ the paid-for bugs

test('BUG right-edge clip: long unbroken strings cannot escape the content column', () => {
  const html = renderFixture('page-width.md');
  // Nothing in the renderer may emit a fixed pixel width; the page column is the
  // stylesheet's job, and any width baked into markup would be a second, hidden
  // layout authority that the shim cannot override.
  assert.ok(!/width:\s*\d+px/i.test(html), 'renderer emitted a hard-coded pixel width');
  assert.ok(html.includes('https://example.com/a/very/long/path'), 'long URL was mangled or dropped');
});

test('BUG page 1 only: the stylesheet carries an explicit display:block in print', () => {
  const html = buildHtml(fixture('basic.md'), 'basic.md', { now: FIXED, css: PRINT_CSS });
  assert.ok(html.includes('@media print'), 'no print stylesheet was embedded');
  assert.ok(
    /@media print[\s\S]{0,4000}display:\s*block/.test(html),
    'the display:block fix for "only page 1 prints" is missing'
  );
});

test('BUG code bleed: pre wraps rather than overflowing', () => {
  const html = buildHtml(fixture('code-bleed.md'), 'code-bleed.md', { now: FIXED, css: PRINT_CSS });
  assert.ok(html.includes('<pre><code'), 'code fence did not render as pre/code');
  assert.ok(
    /pre\s*\{[^}]*white-space:\s*pre-wrap/.test(html),
    'pre must be white-space: pre-wrap under print, or long lines bleed off the page'
  );
});

test('BUG collapsed details: literal details text stays visible', () => {
  const html = renderFixture('details.md');
  // The fixture writes `<details>` as literal text. It must come out escaped and
  // visible, never as a live element that a viewer might collapse.
  assert.ok(html.includes('&lt;details&gt;'), 'literal <details> text was not escaped');
  assert.ok(!/<details[\s>]/i.test(html), 'a live <details> element reached the output');
});

test('BUG dark mode: colour tokens are pinned to light inside print', () => {
  const html = buildHtml(fixture('basic.md'), 'basic.md', { now: FIXED, css: PRINT_CSS });
  assert.ok(
    /@media print[\s\S]{0,2000}:root\s*\{/.test(html),
    'tokens are not re-declared in @media print :root, so dark mode will print wrong colours'
  );
});

// ------------------------------------------------------------ unit-level behaviour

test('frontmatter is stripped and its title wins over the file name', () => {
  const { meta, body } = splitFrontmatter(fixture('frontmatter.md'));
  assert.equal(meta['title'], 'Title From Frontmatter');
  assert.equal(meta['author'], 'Quoted Author', 'quoted values keep their contents, not their quotes');
  assert.ok(!body.includes('title: Title From Frontmatter'), 'frontmatter leaked into the body');
  assert.ok(!/^---/m.test(body), 'the closing fence leaked into the body');
});

test('filename fallback turns separators into spaces', () => {
  assert.equal(titleFromFilename('my-notes_v2.md'), 'my notes v2');
  assert.equal(titleFromFilename('README'), 'README');
});

test('inline emphasis nests in the right order', () => {
  assert.equal(inline('***both***'), '<strong><em>both</em></strong>');
  assert.equal(inline('**bold**'), '<strong>bold</strong>');
  assert.equal(inline('*italic*'), '<em>italic</em>');
  assert.equal(inline('`code`'), '<code>code</code>');
});

test('backslash escapes survive the inline pass', () => {
  // The parking trick: without it the emphasis rule eats this before anything
  // can protect it.
  const out = inline('\\*not italic\\* and \\_not italic\\_');
  assert.ok(!out.includes('<em>'), 'escaped asterisks became emphasis');
  assert.ok(out.includes('*not italic*'), 'the literal asterisks were lost');
});

test('html in a document is escaped, never executed', () => {
  const out = inline('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'), 'raw script tag reached the output');
  assert.ok(out.includes('&lt;script&gt;'));
});

test('a wide table is constrained and ragged rows do not shift columns', () => {
  const { body } = splitFrontmatter(fixture('table-wide.md'));
  const html = renderBlocks(body);
  const rows = html.match(/<tr>/g) ?? [];
  // Two tables in this fixture: 1 header + 3 body, then 1 header + 1 ragged body.
  assert.equal(rows.length, 6, 'unexpected row count');
  assert.ok(
    html.includes('<td>only two</td><td></td><td></td>'),
    'the ragged row was not padded to the header width'
  );
});

test('the preamble class lands only on the first paragraph', () => {
  const html = renderFixture('mixed-blocks.md');
  const count = (html.match(/class="preamble"/g) ?? []).length;
  assert.equal(count, 1, 'preamble styling applied more than once');
});

test('task list items are marked done or open', () => {
  const html = renderFixture('mixed-blocks.md');
  assert.ok(html.includes('class="task done"'), 'a checked task did not render as done');
  assert.ok(/class="task"/.test(html), 'an unchecked task did not render as open');
});

test('the title is not printed twice when the document opens with its own H1', () => {
  // A real sheet came back with "Template Proof" as a double heading: the
  // frontmatter title generated one <h1> and the author's own `# Template Proof`
  // produced another. Every existing test passed, because all of them asked
  // whether the title was PRESENT, never how many times.
  const md = '---\ntitle: Template Proof\n---\n\n# Template Proof\n\nBody text.\n';
  const html = buildHtml(md, 'proof.md', { now: FIXED, css: '' });

  const headings = html.match(/<h1[ >]/g) ?? [];
  assert.equal(
    headings.length,
    1,
    `the document starts with its own H1, so exactly one <h1> should reach the page — got ${headings.length}`
  );
  assert.match(html, /<h1>Template Proof<\/h1>/);
});

test('a document with no leading H1 still gets its title as a heading', () => {
  const md = '---\ntitle: Quiet Report\n---\n\nJust a paragraph, no heading of its own.\n';
  const html = buildHtml(md, 'quiet.md', { now: FIXED, css: '' });

  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, 'the generated title must still appear');
  assert.match(html, /<h1>Quiet Report<\/h1>/);
});

test('a bare document with no frontmatter and no H1 is titled from its filename', () => {
  const html = buildHtml('plain body\n', 'my-notes_v2.md', { now: FIXED, css: '' });
  assert.match(html, /<h1>my notes v2<\/h1>/);
});

test('a ## first heading does not suppress the generated title', () => {
  const md = '---\ntitle: Report\n---\n\n## Section\n\nbody\n';
  const html = buildHtml(md, 'r.md', { now: FIXED, css: '' });
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, 'an H2 is not a title');
  assert.match(html, /<h1>Report<\/h1>/);
});

// ------------------------------------------------------------ golden-file policy

/**
 * ── REGENERATING A GOLDEN FILE ────────────────────────────────────────────────
 * A golden fixture is a RECORD of output that was known to be good, not a
 * rubber stamp on whatever the code just did. So:
 *
 *   1. Run the suite. It writes the mismatch to `.actual/<case>.html`.
 *   2. Open that file next to the golden in a browser (or print both).
 *   3. Decide the new output is RIGHT — on paper, not in a diff.
 *   4. Only then copy `.actual/` over `test/fixtures/`.
 *
 * Regenerating a fixture to turn a red test green, without looking at a sheet or
 * a rendered image, deletes the only evidence that the layout still works. It is
 * the one way this test suite can be made useless while staying green.
 */
test('the golden-policy comment is still in this file', () => {
  // Read from the repo, not from out/: the compiled .js is a build artifact and
  // the rule has to live in the source a person actually edits.
  const src = path.resolve(__dirname, '../../src/test/renderer.test.ts');
  const self = fs.readFileSync(src, 'utf8');
  assert.ok(self.includes('REGENERATING A GOLDEN FILE'), 'the regeneration rule was deleted');
});
