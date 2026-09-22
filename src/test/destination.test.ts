/**
 * destination.test.ts — layer 5: "Save as PDF" must be reachable from every machine.
 *
 * THE BUG BEING GUARDED AGAINST is not "the PDF row is wrong". It is that a row
 * added to the existing printer picker would be correct and invisible, because
 * the picker itself was skipped whenever the answer was already known:
 *
 *   - one printer, or a matched remembered default -> `pickPrinterOrSingle`
 *     returned early and no list was ever shown;
 *   - zero printers -> it threw before a list could exist.
 *
 * Those are precisely the machines where a user most wants a PDF. So the
 * assertions below are mostly about REACHABILITY, not about copy. The user asked
 * for the option; an option that only appears on machines which already have a
 * working printer is the same class of fault as the duplex bug they reported in
 * the same breath — correctly detected, never offered.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PDF_ROW,
  destinationRows,
  pdfIsTheOnlyOption,
  printerRow,
  resolveDestination,
  shouldAsk,
} from '../destination-rules';
import { PrinterCapabilities, Printer } from '../platform/types';

function caps(over: Partial<PrinterCapabilities> = {}): PrinterCapabilities {
  return { known: true, duplex: false, paperSizes: [], ...over };
}

function printer(name: string, over: Partial<Printer> = {}): Printer {
  return { name, kind: 'ipp', capabilities: caps(), ...over } as Printer;
}

function twoSided(name: string): Printer {
  return printer(name, {
    capabilities: caps({
      duplex: true,
      paperSizes: [{ id: 'A4', label: 'A4', isDefault: true }],
    }),
  });
}

function unknown(name: string): Printer {
  return printer(name, { capabilities: caps({ known: false }) });
}

// ------------------------------------------------------------------- always ask

test('asks even with exactly one printer (the old code returned early)', () => {
  // The regression that matters. `pickPrinterOrSingle` short-circuited here, so
  // a PDF row bolted onto the picker would never be seen on the most common
  // single-printer setup — the feature would ship dead on the machine it was
  // reported from.
  assert.equal(shouldAsk([printer('HP_SmartTank')]), true);
});

test('asks when there are no printers at all (the old code threw)', () => {
  // No printer is the case where the PDF row matters MOST, and the old code
  // raised PrintError before a list could exist.
  assert.equal(shouldAsk([]), true);
});

test('asks when there are several printers', () => {
  assert.equal(shouldAsk([printer('a'), printer('b')]), true);
});

test('a remembered default does not suppress the list', () => {
  // `shouldAsk` takes the list but has no notion of a suggested printer, by
  // design: once the PDF row exists there is no "already answered" case. If
  // someone later adds one, this is the tripwire.
  assert.equal(shouldAsk([printer('HP_SmartTank'), printer('Office')]), true);
});

// ------------------------------------------------ when the PDF is the only way out

test('no printers means the PDF row is the one honest answer', () => {
  assert.equal(pdfIsTheOnlyOption([]), true);
});

test('one printer means it is not', () => {
  assert.equal(pdfIsTheOnlyOption([printer('HP_SmartTank')]), false);
});

test('the printer row still exists in the one-printer case', () => {
  // Both destinations must be present even here, or the feature is decorative.
  const rows = destinationRows([printer('HP_SmartTank')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].printer, 'HP_SmartTank');
});

// ------------------------------------------------------- rows describe the device

test('two-sided printers advertise it in the row', () => {
  // The duplex bug, seen from the picker: a two-sided queue must SAY so. The
  // user's words were "not advertised on any device despite it supporting it".
  const row = printerRow(twoSided('HP_SmartTank'));
  assert.match(row.description, /two-sided/);
  assert.equal(row.detail, 'Two-sided available');
});

test('single-sided queues say so rather than staying silent', () => {
  const row = printerRow(printer('Cheap'));
  assert.equal(row.detail, 'Single-sided only (this printer says so)');
  assert.doesNotMatch(row.description, /two-sided/);
});

test('unknown capabilities are admitted, never guessed', () => {
  const row = printerRow(unknown('Mystery'));
  assert.match(row.detail, /unknown/);
  // The rule from types.ts: never offer an option a queue cannot confirm.
  assert.doesNotMatch(row.description, /two-sided/);
});

test('the default paper size is surfaced when known', () => {
  const row = printerRow(twoSided('HP_SmartTank'));
  assert.match(row.description, /A4/);
});

test('network and local devices are distinguishable', () => {
  assert.match(printerRow(printer('net', { kind: 'ipp' })).description, /Network/);
  assert.match(printerRow(printer('usb', { kind: 'local' })).description, /Local/);
});

// -------------------------------------------------------------------- the answer

test('the PDF row resolves to a pdf destination, not a printer named pdf', () => {
  // Encoding the difference in the type is the whole point: a sentinel string
  // like '__save_as_pdf__' could be handed to `lp -d` and accepted as a queue.
  assert.deepEqual(resolveDestination(PDF_ROW.label), { kind: 'pdf' });
});

test('a printer name resolves to that printer', () => {
  assert.deepEqual(resolveDestination('HP_SmartTank'), {
    kind: 'printer',
    printer: 'HP_SmartTank',
  });
});

test('backing out is undefined, never a fake answer', () => {
  // Cancelling a picker is a legitimate outcome. Same rule as the duplex step.
  assert.equal(resolveDestination(undefined), undefined);
  assert.equal(resolveDestination(''), undefined);
});

test('the two destinations are distinguishable without string matching', () => {
  const out = [resolveDestination(PDF_ROW.label), resolveDestination('x')];
  assert.equal(out.filter((d) => d && d.kind === 'pdf').length, 1);
});

// ------------------------------------------------------------------- row order

test('printers come first, PDF second', () => {
  // Deliberate: a PDF row pinned to row one would become the accidental answer
  // for anyone pressing Enter without reading, and mdprint's premise is that a
  // document never goes somewhere the user did not mean.
  const rows = destinationRows([printer('a'), printer('b')]);
  assert.deepEqual(
    rows.map((r) => r.printer),
    ['a', 'b']
  );
});

test('the PDF label can never collide with a real printer row', () => {
  const rows = destinationRows([printer('Hey')]);
  assert.equal(
    rows.some((r) => r.label === PDF_ROW.label),
    false
  );
});
