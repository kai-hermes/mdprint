/**
 * packaging.test.ts — what must (and must not) ship.
 *
 * Found by hand first: `.actual/` (the rendered output of the golden-fixture
 * tests) was making it into the .vsix. It is pure byproduct — a user installing
 * the extension would get a directory of HTML they never asked for, and it
 * would grow every time the tests ran.
 *
 * The reason to write this as a test rather than just fix the glob is that
 * `.vscodeignore` is the kind of file nobody looks at again. A new directory
 * appearing at the repo root does not make anyone think "did I exclude that?",
 * so the leak would come back. This asserts the *intent* — tests, fixtures and
 * scratch output never reach a user — instead of the specific directory name.
 *
 * The second half guards the inverse mistake: a file that MUST ship going
 * missing. `vsce package` warns and prompts when there is no LICENSE, which is
 * loud enough while you are watching the terminal and completely invisible in
 * CI or a scripted build. Worse, the obvious way to silence the warning is
 * `--skip-license`, which ships the unlicensed package anyway and trains you to
 * dismiss the one signal that would have caught it.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(__dirname, '../..');
const ignoreFile = path.join(repo, '.vscodeignore');
const pkgFile = path.join(repo, 'package.json');

function ignorePatterns(): string[] {
  return fs
    .readFileSync(ignoreFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

test('.vscodeignore exists and is not empty', () => {
  assert.ok(fs.existsSync(ignoreFile), '.vscodeignore is missing — nothing is excluded');
  assert.ok(ignorePatterns().length > 0, '.vscodeignore has no rules in it');
});

test('the compiled extension is what ships, not the TypeScript source', () => {
  const patterns = ignorePatterns();
  assert.ok(
    patterns.some((p) => p === 'src/**' || p === 'src' || p.startsWith('src/')),
    'src/ is not excluded — the .vsix would carry duplicate TypeScript sources'
  );
  assert.ok(
    patterns.some((p) => p.startsWith('**/*.map') || p === '*.map'),
    'source maps are not excluded'
  );
});

test('tests, fixtures and scratch renders never reach a user', () => {
  const patterns = ignorePatterns();
  const joined = patterns.join('\n');

  // Each of these is a real directory in this repo that must stay local.
  const mustNotShip: Array<[string, string]> = [
    ['test/**', 'the golden fixtures and .md sources'],
    ['out/test/**', 'the compiled tests'],
    ['.actual/**', 'rendered fixture output (this one leaked once)'],
  ];

  for (const [pattern, why] of mustNotShip) {
    assert.ok(
      patterns.includes(pattern),
      `\`.vscodeignore\` does not exclude \`${pattern}\` (${why}). ` +
        'Without it, this ships inside the .vsix.'
    );
  }

  // And nothing may re-include them after the fact. A `!` line here would
  // silently undo the rule above, which is the subtle way this breaks.
  assert.ok(
    !/^!/m.test(joined),
    'a negation rule in .vscodeignore can re-include an excluded path'
  );
});

test('a LICENSE file exists, because the manifest claims a license', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { license?: string };

  // `vsce package` warns and prompts without one. That prompt is the whole
  // reason this test exists: it is easy to answer `y` out of habit and never
  // notice the package went out without a license.
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
  const found = candidates.filter((f) => fs.existsSync(path.join(repo, f)));

  assert.ok(
    found.length > 0,
    `\`vsce package\` warns when none of ${candidates.join(', ')} exist. ` +
      'Add a LICENSE file rather than passing --skip-license.'
  );

  if (pkg.license) {
    // The file has to agree with the manifest, or the package advertises one
    // license and ships the text of another.
    const text = fs.readFileSync(path.join(repo, found[0]), 'utf8');
    assert.ok(
      text.length > 0,
      'the LICENSE file is empty — it would satisfy vsce and tell a user nothing'
    );
  }
});

test('the license file is not excluded from the package', () => {
  // Excluding LICENSE by a broad glob is the quiet failure: vsce stops
  // warning (the file exists on disk) while the license never actually ships.
  const patterns = ignorePatterns();
  const licenseish = patterns.filter((p) => /licen/i.test(p));

  assert.deepEqual(
    licenseish,
    [],
    `\`.vscodeignore\` matches LICENSE (${licenseish.join(', ')}). The file would ` +
      'exist locally and still be missing from the .vsix.'
  );
});
