/**
 * docs.test.ts — the README and the resolver must not disagree.
 *
 * Why this exists: the README listed the template precedence stack in the wrong
 * order for a whole release. The code was right; the docs were wrong. Nothing
 * caught it, because no test read the docs. A wrong precedence list is a silent
 * failure of exactly the kind this project keeps getting bitten by — a consumer
 * follows the docs, their template loses to the built-in stylesheet, and nothing
 * tells them why.
 *
 * So: parse the documented order out of README.md, ask resolveTemplate() for the
 * real one, and assert they agree. Then prove last-wins positionally — by where
 * each layer's bytes actually land — rather than by re-reading the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTemplate } from '../template-css.js';
import { PRINT_CSS } from '../css.js';

const quiet = () => undefined;

/** The README's precedence diagram, in order. */
function documentedOrder(): string[] {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  const block = readme.match(/```\n(built-in[^\n]*)\n/);
  assert.ok(block, 'README must still carry a precedence line starting with "built-in"');
  return block[1]
    .split('→')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A document with every layer of the stack populated, plus the labels the
 *  resolver gives back for each. */
async function fullStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdprint-docs-'));
  const doc = path.join(dir, 'report.md');
  const house = path.join(dir, 'house.css');
  fs.writeFileSync(doc, '# hi\n');
  fs.writeFileSync(path.join(dir, 'report.mdprint.css'), '.a{color:item}');
  fs.writeFileSync(house, '.b{color:house}');

  const r = await resolveTemplate(
    {
      filePath: doc,
      fileName: 'report.md',
      workspaceFile: house,
      inline: '.c{color:setting}',
      live: '.d{color:live}',
    },
    quiet
  );
  return r;
}

test('the README documents the same number of template layers as the resolver stacks', async () => {
  const documented = documentedOrder();
  const r = await fullStack();

  assert.equal(
    r.sources.length,
    documented.length,
    `README lists ${documented.length} layers but the resolver stacked ${r.sources.length}`
  );
});

test('the README precedence order matches the order the resolver actually layers', async () => {
  const documented = documentedOrder();
  const r = await fullStack();

  // The README's shorthand vs the resolver's human labels. Kept explicit so a
  // renamed layer forces a human to update both, rather than quietly passing.
  const readmeToLabel: Record<string, string> = {
    'built-in': 'built-in',
    'mdprint.themeFile': 'workspace file (house.css)',
    '<doc>.mdprint.css': 'report.mdprint.css (this item)',
    'mdprint.theme': 'setting (mdprint.theme)',
    'live buffer': 'live (unsaved)',
  };

  const expected = documented.map((d) => {
    const label = readmeToLabel[d];
    assert.ok(label, `README names a layer this test does not know: "${d}" — update the map`);
    return label;
  });

  assert.deepEqual(
    r.sources,
    expected,
    'README precedence disagrees with the resolver — the docs are lying to consumers'
  );
});

test('each template layer lands after the previous one, so the narrowest scope wins', async () => {
  const r = await fullStack();

  // Positional proof of last-wins: find where each layer's marker actually sits
  // in the final stylesheet. Re-reading the source would just mirror the bug.
  const markers = ['house', 'item', 'setting', 'live'];
  let prev = r.css.indexOf(PRINT_CSS) + PRINT_CSS.length;

  for (const marker of markers) {
    const at = r.css.indexOf(`color:${marker}`);
    assert.ok(at >= 0, `layer "${marker}" is missing from the resolved CSS entirely`);
    assert.ok(
      at > prev,
      `layer "${marker}" lands at ${at}, before the previous layer at ${prev} — precedence inverted`
    );
    prev = at;
  }
});

test('the live buffer is the last thing in the stack, after the built-in stylesheet', async () => {
  const r = await fullStack();

  // The headline promise of the feature: what you type in the scratchpad beats
  // everything, including mdprint's own stylesheet.
  const live = r.css.indexOf('color:live');
  const builtinAt = r.css.indexOf(PRINT_CSS);

  assert.ok(builtinAt >= 0, 'the built-in stylesheet must be in the output');
  assert.ok(live > builtinAt, 'the live buffer must stack after the built-in stylesheet');
  assert.equal(
    r.css.slice(live).includes('color:item'),
    false,
    'nothing may override the live buffer'
  );
});
