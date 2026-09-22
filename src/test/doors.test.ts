/**
 * doors.test.ts — every door in the backend must be wired to a command.
 *
 * WHY THIS EXISTS. mdprint shipped a bug that no test could see: the macOS
 * backend implemented `printWithDialog`, the interface required it, `detect.ts`
 * forwarded it, and `detect.test.ts` asserted it was present — but NO COMMAND
 * EVER CALLED IT. "Print with options" ran a QuickPick chain and printed
 * immediately instead. Every test passed and the feature did not exist for the
 * user, because "is it implemented?" and "can the user reach it?" are different
 * questions and only the first one was being asked.
 *
 * The lesson generalises: a capability nothing calls is dead code with a
 * passing test suite draped over it. This checks reachability from the
 * manifest, which is the only place a door actually becomes real.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(__dirname, '../..');

function manifest(): {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
  };
} {
  return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
}

function extensionSource(): string {
  return fs.readFileSync(path.join(repo, 'src/extension.ts'), 'utf8');
}

test('the dialog door is reachable, not just implemented', () => {
  const source = extensionSource();

  assert.match(
    source,
    /backend\.printWithDialog\(/,
    'extension.ts must actually CALL printWithDialog — implementing it is not the same ' +
      'as printing with a dialog. This is the exact bug that shipped.'
  );

  const ids = manifest().contributes.commands.map((c) => c.command);
  assert.ok(
    ids.includes('mdprint.printWithDialog'),
    'the dialog door must be a declared command, or no user can reach it'
  );
});

test('every command id in the manifest is registered in code', () => {
  const source = extensionSource();
  for (const { command } of manifest().contributes.commands) {
    assert.match(
      source,
      new RegExp(`register\\(['"]${command.replace(/\./g, '\\.')}['"]`),
      `${command} is declared in package.json but never registered — it would appear in ` +
        'the palette and do nothing'
    );
  }
});

test('every registered command is declared in the manifest', () => {
  const declared = new Set(manifest().contributes.commands.map((c) => c.command));
  for (const m of extensionSource().matchAll(/register\(['"]([^'"]+)['"]/g)) {
    assert.ok(
      declared.has(m[1]),
      `${m[1]} is registered in code but not declared in package.json — pressing it would ` +
        'fail with "command not found"'
    );
  }
});

test('a command that prints never falls back into the dialog door', () => {
  // One pipeline, no fallback: the two doors are chosen by the user, and the
  // one-click path must not reopen itself as a dialog when lp fails.
  const source = extensionSource();

  const printFn = source.slice(
    source.indexOf('async function printCommand'),
    source.indexOf('async function pickDestination')
  );
  assert.ok(printFn.length > 0, 'printCommand should be findable');

  const catchBlock = printFn.slice(printFn.indexOf('} catch (e) {'));
  assert.ok(catchBlock.length > 0, 'printCommand should have a catch block');
  assert.ok(
    !/printWithDialog/.test(catchBlock),
    'the failure path must not fall over into the dialog — that is a fallback, and it ' +
      'gives two divergent behaviours for one command'
  );
});

test('both doors render through the one shared render step', () => {
  const source = extensionSource();
  const printFn = source.slice(
    source.indexOf('async function printCommand'),
    source.indexOf('async function pickDestination')
  );

  const calls = printFn.match(/await renderDoc\(/g) ?? [];
  assert.equal(
    calls.length,
    1,
    'printCommand should call renderDoc exactly once, above the door split — both doors ' +
      'must print the same artifact'
  );
});

test('titles match what the doors actually do', () => {
  const byId = new Map(manifest().contributes.commands.map((c) => [c.command, c.title]));

  // The old title said "options" while the code ran a picker, which is how the
  // user ended up expecting a dialog and getting a sheet. Non-dialog commands
  // must not use the word.
  assert.ok(
    !/option/i.test(byId.get('mdprint.printWithDialog') ?? ''),
    'the dialog command must not be called "options" — it hands over to the OS dialog'
  );
  assert.match(byId.get('mdprint.printWithDialog') ?? '', /dialog/i);
  assert.match(byId.get('mdprint.customise') ?? '', /template/i);
});

test('the dialog door is offered in every surface the print door is', () => {
  const menus = manifest().contributes.menus;
  for (const where of ['explorer/context', 'editor/title/context', 'commandPalette']) {
    const cmds = (menus[where] ?? []).map((m) => m.command);
    assert.ok(
      cmds.includes('mdprint.printWithDialog'),
      `${where} offers Print but not Print with dialog — the doors must be offered together`
    );
  }
});

test('the template door is only offered where a document is being edited', () => {
  const menus = manifest().contributes.menus;
  for (const where of ['explorer/context', 'editor/title/context']) {
    const m = (menus[where] ?? []).find((x) => x.command === 'mdprint.customise');
    assert.ok(m, `${where} should offer the template command`);
    assert.equal(m.when, 'resourceExtname == .md', `${where} must scope it to markdown files`);
  }
});
