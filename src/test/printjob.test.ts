/**
 * printjob.test.ts — layer 3: PrintJob -> argv, and the rules that protect paper.
 *
 * The most expensive possible bug in this program is a flag mdprint emits
 * WITHOUT BEING ASKED. `-o sides=one-sided` on a two-sided office printer turns
 * a 40-page document into 40 sheets, and nobody notices until the ream is gone.
 *
 * So the central assertion here is a negative one: a PrintJob that doesn't
 * mention sides produces NO `sides` flag, and a plain job produces the shortest
 * argv it possibly can. Everything else in this file is either that rule's edge
 * cases or the printer-resolution order.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFlags } from '../platform/lp';
import { Duplex, PrintJob } from '../platform/types';

const PDF: PrintJob['source'] = { kind: 'pdf', path: '/tmp/x.pdf' };

test('a job with no choices emits no option flags at all', () => {
  const job: PrintJob = { source: PDF };
  assert.deepEqual(
    buildFlags(job),
    [],
    'a job the user did not configure must not carry a single -o flag'
  );
});

test('duplex is absent unless explicitly chosen — the paper-wasting rule', () => {
  const flags = buildFlags({ source: PDF });
  assert.ok(!flags.includes('sides=one-sided'), 'mdprint must never assume one-sided');
  assert.ok(!flags.some((f) => f.includes('sides=')), 'no sides flag should exist by default');
});

test('all three duplex values survive as honest CUPS strings', () => {
  const cases: Duplex[] = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'];
  for (const duplex of cases) {
    const flags = buildFlags({ source: PDF, duplex });
    assert.deepEqual(flags, ['-o', `sides=${duplex}`], `${duplex} did not round-trip`);
  }
});

test('copies: one copy is the absence of a flag, not -n 1', () => {
  assert.deepEqual(buildFlags({ source: PDF, copies: 1 }), [], 'copies:1 should emit nothing');
  assert.deepEqual(buildFlags({ source: PDF, copies: 3 }), ['-n', '3']);
});

test('range is trimmed and skipped when empty', () => {
  assert.deepEqual(buildFlags({ source: PDF, range: '1-3,7' }), ['-o', 'page-ranges=1-3,7']);
  assert.deepEqual(buildFlags({ source: PDF, range: '  1-3  ' }), ['-o', 'page-ranges=1-3']);
  assert.deepEqual(buildFlags({ source: PDF, range: '' }), []);
  assert.deepEqual(buildFlags({ source: PDF, range: '   ' }), []);
});

test('flags compose in a stable order', () => {
  const flags = buildFlags({
    source: PDF,
    duplex: 'two-sided-long-edge',
    copies: 2,
    range: '2-4',
  });
  assert.deepEqual(flags, [
    '-o', 'sides=two-sided-long-edge',
    '-n', '2',
    '-o', 'page-ranges=2-4',
  ]);
});

test('a document title can never become a command', () => {
  // Arguments are passed as an array with no shell, so this is really a test
  // that nobody ever "helpfully" concatenates the argv into a string.
  const nasty = '/tmp/a b; rm -rf ~ $(whoami) `id`.pdf';
  const flags = buildFlags({ source: { kind: 'pdf', path: nasty }, range: '1' });
  assert.deepEqual(flags, ['-o', 'page-ranges=1']);
});

// ------------------------------------------------------------ printer resolution

/**
 * The ordering rule from printer.ts, re-stated as a test: a session choice wins,
 * then the configured default, then the OS default — and a short name matches
 * its suffixed registration (`HP_SmartTank` -> `HP_SmartTank-7`), because that
 * is how CUPS actually names things.
 */
function resolve(
  names: string[],
  opts: { session?: string; configured?: string; os?: string }
): string | undefined {
  if (opts.session) {
    const m = names.find((n) => n === opts.session || n.startsWith(opts.session + '-'));
    if (m) {
      return m;
    }
  }
  if (opts.configured) {
    const m = names.find((n) => n === opts.configured || n.startsWith(opts.configured + '-'));
    if (m) {
      return m;
    }
  }
  if (opts.os) {
    const m = names.find((n) => n === opts.os || n.startsWith(opts.os + '-'));
    if (m) {
      return m;
    }
  }
  return names.length === 1 ? names[0] : undefined;
}

test('a session choice outranks any saved default', () => {
  const names = ['HP_SmartTank-7', 'OfficeLaser'];
  assert.equal(
    resolve(names, { session: 'OfficeLaser', configured: 'HP_SmartTank-7', os: 'HP_SmartTank-7' }),
    'OfficeLaser'
  );
});

test('a short queue name resolves to its suffixed registration', () => {
  assert.equal(resolve(['HP_SmartTank-7', 'Other'], { configured: 'HP_SmartTank' }), 'HP_SmartTank-7');
});

test('an exact name is never mangled into a suffix', () => {
  assert.equal(resolve(['HP_SmartTank', 'HP_SmartTank-7'], { configured: 'HP_SmartTank' }), 'HP_SmartTank');
});

test('with two printers and no default, the answer is "ask", not a guess', () => {
  assert.equal(resolve(['A', 'B'], {}), undefined, 'mdprint must ask rather than pick one');
});

test('with one printer, no question is worth asking', () => {
  assert.equal(resolve(['OnlyOne'], {}), 'OnlyOne');
});
