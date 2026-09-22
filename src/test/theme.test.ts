/**
 * theme.test.ts — the per-item template contract.
 *
 * Two things are worth pinning here, and both were chosen because the failure
 * mode is silent:
 *
 *  1. PRECEDENCE. The layers stack richest-last, and a layer that is absent
 *     must not blank the ones above it. If ordering silently inverted, the
 *     built-in stylesheet would win over the user's template and the page would
 *     look untouched — no error, just the wrong paper.
 *
 *  2. THE PAPER GUARD. A theme may restyle anything except the paper size. A
 *     shared template that quietly changed the sheet would be discovered as
 *     wrong-sized printing, not as a bad file. This one is a value judgement
 *     baked into code, so it gets a test.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { PRINT_CSS } from '../css';
import { resolveTemplate, siblingTemplatePath, stripPageSize } from '../template-css';

const quiet = (): void => undefined;

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mdprint-theme-'));
}

test('siblingTemplatePath sits beside the document and replaces the extension', () => {
  assert.equal(siblingTemplatePath('/tmp/docs/report.md'), '/tmp/docs/report.mdprint.css');
  assert.equal(siblingTemplatePath('/tmp/docs/a.b.md'), '/tmp/docs/a.b.mdprint.css');
  assert.equal(siblingTemplatePath('/tmp/docs/no-ext'), '/tmp/docs/no-ext.mdprint.css');
  // An unsaved buffer has no sibling to look for.
  assert.equal(siblingTemplatePath(undefined), undefined);
});

test('an item with no template resolves to just the built-in stylesheet', async () => {
  const r = await resolveTemplate({ fileName: 'plain.md' }, quiet);
  assert.equal(r.css, PRINT_CSS);
  assert.deepEqual(r.sources, ['built-in']);
  assert.deepEqual(r.refused, []);
});

test('a sibling template stacks AFTER the built-in one, not before', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  await fs.writeFile(doc, '# hi\n');
  await fs.writeFile(path.join(dir, 'report.mdprint.css'), 'body { color: rebeccapurple; }');

  const r = await resolveTemplate({ filePath: doc, fileName: 'report.md' }, quiet);

  assert.deepEqual(r.sources, ['built-in', 'report.mdprint.css (this item)']);
  const builtinAt = r.css.indexOf(PRINT_CSS);
  const themeAt = r.css.indexOf('rebeccapurple');
  assert.ok(builtinAt >= 0, 'built-in stylesheet must still be present');
  assert.ok(themeAt > builtinAt, 'the item template must come after the built-in rules to win');
});

test('the layer order is built-in -> workspace file -> item file -> setting -> live', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  const house = path.join(dir, 'house.css');
  await fs.writeFile(doc, '# hi\n');
  await fs.writeFile(path.join(dir, 'report.mdprint.css'), '.a{color:item}');
  await fs.writeFile(house, '.b{color:house}');

  const r = await resolveTemplate(
    {
      filePath: doc,
      fileName: 'report.md',
      workspaceFile: house,
      inline: '.c{color:setting}',
    },
    quiet
  );

  assert.deepEqual(r.sources, [
    'built-in',
    'workspace file (house.css)',
    'report.mdprint.css (this item)',
    'setting (mdprint.theme)',
  ]);

  const at = (needle: string): number => r.css.indexOf(needle);
  assert.ok(at('house') > at(PRINT_CSS), 'workspace file outranks built-in');
  assert.ok(at('item') > at('house'), 'item file outranks the workspace file');
  assert.ok(at('setting') > at('item'), 'the setting is the innermost saved layer');
});

test('a missing template file is skipped silently — it is the normal case', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  await fs.writeFile(doc, '# hi\n');

  const warnings: string[] = [];
  const r = await resolveTemplate({ filePath: doc, fileName: 'report.md' }, (l) => warnings.push(l));

  assert.deepEqual(r.sources, ['built-in']);
  assert.deepEqual(warnings, []);
});

test('an unreadable workspace themeFile is reported, not swallowed', async () => {
  const warnings: string[] = [];
  const r = await resolveTemplate(
    { fileName: 'x.md', workspaceFile: '/nope/definitely/not/here.css' },
    (l) => warnings.push(l)
  );

  assert.equal(r.sources.length, 1, 'a broken house style must not add a layer');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /couldn't be read/);
});

test('a theme may NOT set the paper size — the block is stripped and reported', async () => {
  const { css, refused } = stripPageSize('@page { size: Letter; margin: 10mm; }');

  assert.deepEqual(refused, ['Letter']);
  assert.ok(!/size\s*:/.test(css), 'the size declaration must be gone');
  assert.match(css, /margin\s*:\s*10mm/, 'margins are a layout preference and are kept');
});

test('a theme that tries Letter cannot beat the document, even stacked last', async () => {
  const r = await resolveTemplate(
    { fileName: 'x.md', inline: '@page { size: 216mm 279mm; margin: 5mm; }' },
    quiet
  );

  assert.deepEqual(r.refused, ['216mm 279mm']);
  const afterBuiltin = r.css.slice(r.css.indexOf(PRINT_CSS) + PRINT_CSS.length);
  assert.ok(
    !/@page\s*\{[^}]*size\s*:/i.test(afterBuiltin),
    'no theme layer may reintroduce a @page size after the built-in stylesheet'
  );
});

test('a theme that only sets margins keeps them, with no complaint', async () => {
  const r = await resolveTemplate({ fileName: 'x.md', inline: '@page { margin: 20mm 25mm; }' }, quiet);

  assert.deepEqual(r.refused, []);
  assert.match(r.css, /margin\s*:\s*20mm 25mm/);
});
