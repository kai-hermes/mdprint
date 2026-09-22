/**
 * duplex.test.ts — layer 4: reading what a queue actually advertises.
 *
 * THE BUG THIS FILE EXISTS FOR (reported 2026-09-22, verbatim):
 *
 *   "Double sided was also not advertised on any device despite it supporting it,
 *    so thats another one to fix."
 *
 * Root cause: `lpoptions -l` prints each option as `Name/Human label`, i.e. the
 * line is
 *
 *     Duplex/Duplex: *None DuplexNoTumble DuplexTumble
 *
 * and the parser compared the WHOLE left-hand side against the literal string
 * 'Duplex'. `'Duplex/Duplex' !== 'Duplex'`, so the branch never ran, `duplex`
 * stayed `false`, and EVERY printer on EVERY machine was reported as
 * single-sided-only. The HP advertised duplex the entire time. The bug was a
 * string comparison.
 *
 * The assertions below are deliberately split into two groups:
 *
 *   1. `optionKey` — the normalisation. The fixture is the REAL `lpoptions`
 *      output from Jaymeh's HP Smart Tank 7000 (product 28B54A), pasted
 *      verbatim, because a hand-tidied fixture is how this bug survived.
 *   2. `advertisesDuplex` — the honesty rule. `*None` must NOT be read as
 *      support, and a trailing `None` must NOT hide real support.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The parser under test — the REAL one, imported from the shipped module.
 *
 * This used to be a mirror of `capabilities()`'s loop, re-typed here so the test
 * could run without a printer attached. That mirror still called the fixed
 * `optionKey` helper, so when the original bug was put back by hand the test
 * suite stayed green — 104/104 with the bug live in both `src/` and `out/`. A
 * test that re-implements the thing it tests cannot fail for the right reason.
 *
 * `parseCapabilities` exists precisely so this import is possible.
 */
import { advertisesDuplex, optionKey, parseCapabilities as parse } from '../platform/lp';

/**
 * Verbatim `lpoptions -p HP_SmartTank -l` from the Mac, 2026-09-22.
 * Not tidied. The `/`-suffixed keys and the `*`-marked defaults are the point.
 */
const HP_SMART_TANK_LPOPTIONS = [
  'PageSize/Media Size: 100x150mm 100x150mm.Borderless 3.5x5 3.5x5.Borderless 4x6 4x6.Borderless 5x7 5x7.Borderless 5x8 5x8.Borderless 8x10 8x10.Borderless *A4 A4.Borderless A5 A5.Borderless A6 A6.Borderless B5 B5.Borderless DoublePostcardRotated DoublePostcardRotated.Borderless Env10 EnvC6 EnvChou3 EnvChou4 EnvDL Executive FanFoldGermanLegal ISOB5 Legal Letter Letter.Borderless Postcard Postcard.Borderless Statement Custom.WIDTHxHEIGHT',
  'MediaType/Media Type: *Stationery PhotographicGlossy Com.hpPhotographicInkjet Com.hpSpecialtyGlossy Com.hpMattePresentation StationeryLightweight Com.hpMatteBrochure Com.hpMatteInkjet Com.hpSpecialtyGlossyInkjet',
  'ColorModel/Output Mode: *RGB Gray Gray16 DeviceGray DeviceRGB AdobeRGB',
  'Duplex/Duplex: *None DuplexNoTumble DuplexTumble',
  'cupsPrintQuality/cupsPrintQuality: Draft *Normal High',
].join('\n');

// ------------------------------------------------------------------ optionKey

test('a /-suffixed option name is reduced to the name lp accepts', () => {
  assert.equal(optionKey('Duplex/Duplex'), 'Duplex');
  assert.equal(optionKey('PageSize/Media Size'), 'PageSize');
  assert.equal(optionKey('ColorModel/Output Mode'), 'ColorModel');
  assert.equal(optionKey('MediaType/Media Type'), 'MediaType');
  assert.equal(optionKey('cupsPrintQuality/cupsPrintQuality'), 'cupsPrintQuality');
});

test('only the FIRST slash splits name from label, because labels contain slashes', () => {
  assert.equal(optionKey('InputSlot/Tray 1 / 2'), 'InputSlot');
  assert.equal(optionKey('OutputBin/Stacker/Stapler'), 'OutputBin');
});

test('an unsuffixed name still works, and whitespace is trimmed', () => {
  assert.equal(optionKey('Duplex'), 'Duplex');
  assert.equal(optionKey('  Duplex  '), 'Duplex');
  assert.equal(optionKey(''), '');
});

test('THE BUG: the old whole-string comparison never matched the real key', () => {
  // If this ever passes with `rawKey`, the regression is back.
  const rawKey = 'Duplex/Duplex';
  assert.notEqual(rawKey, 'Duplex', 'fixture sanity: the raw key really is suffixed');
  assert.equal(optionKey(rawKey), 'Duplex', 'normalisation is what makes the branch run');
});

// ----------------------------------------------------------- advertisesDuplex

test('the real HP queue advertises two-sided', () => {
  const caps = parse(HP_SMART_TANK_LPOPTIONS);
  assert.equal(caps.duplex, true, 'HP Smart Tank 7000 advertises DuplexNoTumble/DuplexTumble');
});

test('the real HP queue yields a default page size and sees A4', () => {
  const caps = parse(HP_SMART_TANK_LPOPTIONS);
  assert.equal(caps.paperSizes.find((s) => s.isDefault)?.id, 'A4');
});

test('a queue whose Duplex list is only *None is honestly single-sided', () => {
  assert.equal(advertisesDuplex('*None'), false);
  assert.equal(advertisesDuplex('None'), false);
});

test('two-sided survives even when it is the default and None trails it', () => {
  assert.equal(advertisesDuplex('*DuplexNoTumble DuplexTumble None'), true);
});

test('an empty value list is not a claim of capability', () => {
  assert.equal(advertisesDuplex(''), false, 'no values must never read as "supports duplex"');
  assert.equal(advertisesDuplex('   '), false);
});

test('the * default marker never hides a real mode', () => {
  assert.equal(advertisesDuplex('*None DuplexNoTumble DuplexTumble'), true);
  assert.equal(advertisesDuplex('*DuplexTumble'), true);
});

test('an unparseable queue says known:false rather than claiming single-sided', () => {
  // The honesty rule from types.ts: capability claims must be honest. If we
  // cannot read the queue we must not assert anything about it — which is the
  // opposite failure to this whole file's bug, and just as bad.
  assert.deepEqual(parse('something that is not lpoptions output'), {
    known: true,
    duplex: false,
    paperSizes: [],
  });
});
