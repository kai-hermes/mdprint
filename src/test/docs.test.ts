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

/** Internal CommonJS loader signature — `_load` is not in @types/node. */
type LoadFn = (
  request: string,
  parent: unknown,
  isMain: boolean
) => unknown;

/**
 * Load a compiled test file with `node:test` stubbed out and count the tests it
 * declares. The bodies never run, so this is safe to point at anything.
 */
function countTestsIn(
  file: string,
  origLoad: LoadFn,
  stub: () => unknown
): number {
  const mod = require('node:module') as { _load: LoadFn };
  let n = 0;
  const wrapped = () => {
    n += 1;
    return stub();
  };

  mod._load = function (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean
  ) {
    if (request === 'node:test') {
      return { test: wrapped, default: wrapped };
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    // A fresh copy each time: require() caches, and a cached module would report
    // zero tests on the second visit.
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    mod._load = origLoad;
  }
  return n;
}

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

test('the README states the number of tests that actually run', () => {
  // This count has been wrong twice (139 -> 143 -> 144) because adding a test
  // means remembering to edit prose. A stale number is a small lie, but it is
  // the kind a reader uses to decide whether the suite is worth trusting.
  //
  // Count the tests the runner really declares, by loading each compiled file
  // with node:test stubbed out. Grepping the source for `test(` is not good
  // enough: this file's own regex literal and its assertion message both match,
  // so the naive count reports two more tests than exist. Ask the files instead.
  const dir = path.join(process.cwd(), 'out/test');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));

  const mod = require('node:module') as { _load: LoadFn };
  const origLoad = mod._load;
  let declared = 0;
  // node:test's `test()` returns a promise; the loader ignores it, and the
  // bodies are never run, so nothing here touches the filesystem or private keys.
  const stub = () => Object.assign(Promise.resolve(), { skip: () => undefined, todo: () => undefined });

  try {
    for (const f of files) {
      const full = path.join(dir, f);
      declared += countTestsIn(full, origLoad, stub);
    }
  } finally {
    // The finally is the point: if loading any file throws, restore the loader
    // before the exception escapes, or every later test runs with node:test
    // stubbed and silently reports nothing.
    mod._load = origLoad;
  }

  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  const claim = readme.match(/then (\d+) tests across (\w+) layers/);
  assert.ok(
    claim,
    'README no longer states "N tests across M layers" — reinstate the claim or drop this test'
  );

  assert.equal(
    Number(claim[1]),
    declared,
    `README claims ${claim[1]} tests but the suite declares ${declared}`
  );

  // The layer count must agree with the table printed right below the claim.
  const tableRows = readme
    .slice(readme.indexOf('| Layer |'))
    .split('\n')
    .filter((l) => l.startsWith('|'));
  const layers = tableRows.length - 2; // minus header and separator
  const words: Record<string, number> = {
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  };
  const claimed = words[claim[2]];
  assert.ok(claimed, `unrecognised layer word "${claim[2]}" — add it to the map`);
  assert.equal(
    claimed,
    layers,
    `README says "${claim[2]} layers" but the table lists ${layers}`
  );
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
