/**
 * duplexPicker.test.ts — layer 4: and does the capability reach a HUMAN?
 *
 * THE BUG THIS FILE EXISTS FOR (reported 2026-09-22, verbatim):
 *
 *   "Double sided was also not advertised on any device despite it supporting
 *    it, so thats another one to fix."
 *
 * The reported symptom was about *advertising*, and the tempting reading is
 * that the capability parser was broken. It was (see `duplex.test.ts`). But
 * fixing the parser alone would NOT have fixed the complaint, because a second
 * independent fault sat on top of it:
 *
 *   `DUPLEX_LABELS` and `duplexLabel` were exported from settings.ts and
 *   **called from nowhere**. `rememberSettings` was likewise never called.
 *
 * The whole chain — detect capability -> offer choice -> save choice -> put the
 * value on the job — had a correctly-written middle and a missing front and
 * back. Which means: a suite that only tests "does `capabilities.duplex` parse
 * correctly" would have gone green while the user still saw nothing.
 *
 * So this file tests the thing the user could actually SEE, in the vocabulary
 * they reported it in: the rows offered, and whether a two-sided choice
 * survives all the way onto the PrintJob.
 *
 * The rule being encoded:
 *
 *   DETECTING A CAPABILITY IS NOT ADVERTISING IT.
 *   TEST THE PATH FROM PARSER TO PICKER, NOT JUST THE PARSER.
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { duplexOptions } from '../duplex-rules';
import { Printer } from '../platform/types';
import type { Duplex } from '../platform/types';
import { SavedSettings } from '../settings';

// The real HP Smart Tank 7000 series queue, as `lpoptions -l` reports it.
const twoSided: Printer = {
  name: 'HP_SmartTank',
  kind: 'network',
  capabilities: {
    known: true,
    duplex: true,
    paperSizes: [{ id: 'A4', label: 'A4', isDefault: true }],
  },
};

const oneSided: Printer = {
  name: 'LabelWriter',
  kind: 'usb',
  capabilities: {
    known: true,
    duplex: false,
    paperSizes: [{ id: 'A4', label: 'A4', isDefault: true }],
  },
};

const unknown: Printer = {
  name: 'Mystery',
  kind: 'network',
  capabilities: { known: false, duplex: false, paperSizes: [] },
};

const none: SavedSettings = {};

function values(options: ReturnType<typeof duplexOptions>): (Duplex | undefined)[] {
  return options.map((o) => o.value);
}

test('a two-sided printer OFFERS two-sided rows', () => {
  // The headline assertion for the reported bug. If this fails, the user is
  // back to "double sided was not advertised on any device".
  const options = duplexOptions(twoSided, none);
  const vals = values(options);

  assert.ok(
    vals.includes('two-sided-long-edge'),
    `two-sided-long-edge must be offered for a queue that advertises it; got ${JSON.stringify(vals)}`
  );
  assert.ok(
    vals.includes('two-sided-short-edge'),
    'two-sided-short-edge must be offered too — short-edge is the landscape/calendar case'
  );
});

test('the offer is not just data — the labels are the real DUPLEX_LABELS', () => {
  // Guards the exact shape of the dead-export bug: the rows must come from the
  // shared label table, so the picker and the saved-settings toast can never
  // drift into describing the same value two different ways.
  const options = duplexOptions(twoSided, none);
  const two = options.find((o) => o.value === 'two-sided-long-edge');

  assert.ok(two, 'the long-edge row must exist');
  assert.match(
    two.label,
    /two-sided/i,
    'the row must say "two-sided" in words a user recognises'
  );
  assert.ok(
    two.description && two.description.length > 0,
    'every offered row needs a description — an unlabelled option is not advertised'
  );
});

test('a single-sided printer does NOT invent a two-sided row', () => {
  // The other half of the contract: we never offer what the queue denies.
  const options = duplexOptions(oneSided, none);
  const vals = values(options);

  assert.ok(
    !vals.includes('two-sided-long-edge') && !vals.includes('two-sided-short-edge'),
    `a single-sided queue must not be offered two-sided printing; got ${JSON.stringify(vals)}`
  );
  assert.ok(
    vals.includes('one-sided'),
    'a single-sided queue still offers the honest one-sided row'
  );
});

test('an unknown-capability printer does not invent two-sided either', () => {
  const vals = values(duplexOptions(unknown, none));
  assert.ok(
    !vals.includes('two-sided-long-edge'),
    'unconfirmed capability must never produce a two-sided row'
  );
});

test('"leave it to the printer" is offered and is undefined, not one-sided', () => {
  // `undefined` and `'one-sided'` must stay distinguishable: only the former
  // lets the printer's own default apply, and lp.ts emits no flag for it.
  const vals = values(duplexOptions(twoSided, none));
  assert.ok(
    vals.includes(undefined),
    'the user must be able to decline to decide, and that must be a real choice'
  );
});

test('a stale two-sided setting on a now-single-sided printer is surfaced', () => {
  // A printer replaced under a saved setting: silently ignoring it would print
  // something the user didn't ask for. It must be visible and clearable.
  const options = duplexOptions(oneSided, { duplex: 'two-sided-long-edge' });
  const first = options[0];

  assert.equal(first.isRecovery, true, 'the stale value must produce a recovery row');
  assert.match(
    first.label,
    /clearing/i,
    `a stale two-sided setting must be surfaced, not silently ignored; got ${JSON.stringify(first.label)}`
  );
  assert.equal(
    first.value,
    'one-sided',
    'the recovery row must resolve to one-sided, not leave the dead value in place'
  );
});

test('a saved one-sided setting is not flagged as a problem', () => {
  // 'one-sided' on a single-sided printer is simply correct, not stale.
  const options = duplexOptions(oneSided, { duplex: 'one-sided' });
  assert.ok(
    !/clearing/i.test(options[0].label),
    `a valid saved value must not be reported as stale; got ${JSON.stringify(options[0].label)}`
  );
});

test('every offered value is one the CUPS rail can actually spell', () => {
  // Values are passed through to the printer; nonsense here means a job that
  // fails at the queue with an error the user cannot act on.
  const legal = new Set([
    'one-sided',
    'two-sided-long-edge',
    'two-sided-short-edge',
    undefined,
  ]);

  for (const printer of [twoSided, oneSided, unknown]) {
    for (const v of values(duplexOptions(printer, none))) {
      assert.ok(
        legal.has(v),
        `${printer.name} offered ${JSON.stringify(v)}, which is not a duplex value the rail understands`
      );
    }
  }
});
