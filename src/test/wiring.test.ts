/**
 * wiring.test.ts — layer 6: the "Save as PDF" row must actually SAVE.
 *
 * WHY THIS EXISTS. destination.test.ts proves the RULES are right: the list is
 * always shown, the PDF row resolves to `{kind:'pdf'}` and not to a queue named
 * "Save as PDF…". None of that proves the extension DOES anything with that
 * answer. This project has already shipped one bug of exactly that shape — the
 * dialog door was implemented, interface-complete, detect-forwarded, unit
 * tested, and called by nothing — so "the rule is correct" and "the row reaches
 * the filesystem" are treated as different questions here.
 *
 * The mutation that motivated this file: gutting the body of the
 * `destination.kind === 'pdf'` branch left the whole suite green (133/133),
 * because nothing asserted the branch did its job. Sabotaging `savePdfAs(...)`
 * compiles cleanly — it is a void call — so no type check catches it either.
 *
 * These are source-level assertions, in the same spirit as doors.test.ts: they
 * check REACHABILITY, which is a property of the wiring, not of the pure rules.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(__dirname, '../..');

function extensionSource(): string {
  return fs.readFileSync(path.join(repo, 'src/extension.ts'), 'utf8');
}

/** The body of the `pdf` branch of the destination decision. */
function pdfBranch(): string {
  const source = extensionSource();
  const start = source.indexOf("if (destination.kind === 'pdf') {");
  assert.ok(start > 0, 'extension.ts must branch on the pdf destination');

  // Walk braces so the slice ends at the real end of the block rather than at
  // some later occurrence of `}`.
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in the pdf branch');
}

test('choosing the PDF row calls the save step', () => {
  // The core reachability assertion. Gutting this call is a void-return
  // sabotage that compiles clean, so only a test can hold it in place.
  assert.match(
    pdfBranch(),
    /await savePdfAs\(/,
    'the pdf destination must actually call savePdfAs — resolving to {kind:"pdf"} ' +
      'and then doing nothing is the dialog-door bug all over again'
  );
});

test('choosing the PDF row never reaches the printer door', () => {
  // The failure this guards: a PDF choice falling through to `destination.printer`
  // (undefined on the pdf variant), or worse, being handed to `lp -d` as a queue
  // name. The branch must return.
  const branch = pdfBranch();
  assert.match(branch, /return;/, 'the pdf branch must return, not fall through');
  assert.doesNotMatch(
    branch,
    /lp\.print|backend\.print\(|jobFor\(/,
    'the pdf destination must not send a job to a printer'
  );
});

test('a saved file is announced', () => {
  // Silently writing a file the user was never told about is the same class of
  // user-facing defect as a silent stall.
  assert.match(
    pdfBranch(),
    /announceSaved\(/,
    'the save must be announced — a file appearing on disk with no word to the ' +
      'user is not a completed action'
  );
});

test('cancelling the save is not treated as a failure', () => {
  // Backing out of a Save dialog is legitimate, exactly like cancelling the
  // printer or duplex pickers. The outcome must be checked, not assumed.
  assert.match(
    pdfBranch(),
    /if \(outcome\)/,
    'the save outcome must be tested before announcing — cancel returns undefined'
  );
});

test('the destination is chosen above the printer logic, not after it', () => {
  // Order is the feature. Asked after a printer was resolved, the PDF row would
  // be invisible on one-printer machines (early return) and unreachable on
  // zero-printer machines (throw). Both of those machines are the ones that
  // want a PDF most.
  const source = extensionSource();
  const pick = source.indexOf('await pickDestination(');
  const duplex = source.indexOf('await chooseDuplex(');
  const send = source.indexOf('await backend.print(');

  assert.ok(pick > 0, 'the destination must be picked');
  assert.ok(duplex > 0 && send > 0, 'the printer path must still exist');
  assert.ok(
    pick < duplex && pick < send,
    'the destination must be chosen BEFORE any printer-specific work, or the ' +
      'PDF row is hidden from the machines that need it'
  );
});

test('the printer list is fetched before the destination is offered', () => {
  // The list is both the rows and the source of the printed capability hints.
  // Fetching it lazily after the list was drawn would show rows with no
  // two-sided information — the duplex bug, reintroduced through ordering.
  const source = extensionSource();
  const list = source.indexOf('await backend.listPrinters()');
  const pick = source.indexOf('await pickDestination(');
  assert.ok(list > 0, 'the printer list must be fetched');
  assert.ok(
    list < pick,
    'listPrinters must run before pickDestination so the rows can advertise what ' +
      'each device can actually do'
  );
});
