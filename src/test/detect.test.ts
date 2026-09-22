/**
 * detect.test.ts — layer 4: the platform seam.
 *
 * Two things are worth testing about a seam this thin, and they're the two that
 * would actually hurt:
 *
 *  1. It picks the right class for the platform, and says something useful on a
 *     platform that has no class yet. A print command that throws a bare
 *     "unsupported platform" is a bug report; one that explains the macOS-first
 *     alpha and offers the PDF route is a product.
 *
 *  2. The interface is complete. If a backend module forgets `printWithDialog`,
 *     the failure should be a compile error — and these checks catch the case
 *     where someone wires a new platform up by hand and misses a method, which
 *     would otherwise only surface as a mystery error at 11pm on Windows.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detect, tryDetect } from '../platform/detect';
import { PrintBackend, PrintError } from '../platform/types';
import * as macos from '../platform/macos';
import * as lp from '../platform/lp';

const REQUIRED: (keyof PrintBackend)[] = [
  'platformName',
  'available',
  'listPrinters',
  'defaultPrinter',
  'print',
  'printWithDialog',
];

test('macOS gets a backend', () => {
  const backend = detect({ platform: 'darwin' });
  assert.equal(backend.platformName, 'macOS');
});

test('an unbuilt platform fails loudly and usefully', () => {
  for (const platform of ['win32', 'linux', 'freebsd'] as NodeJS.Platform[]) {
    assert.throws(
      () => detect({ platform }),
      (e: unknown) => {
        assert.ok(e instanceof PrintError, 'the error should be a PrintError');
        assert.match(
          (e as Error).message,
          /Save as PDF/,
          'the message must offer the route that does work on that platform'
        );
        return true;
      },
      `${platform} should throw a PrintError with a way forward`
    );
  }
});

test('tryDetect returns null instead of throwing, for activation-time probing', () => {
  assert.equal(tryDetect({ platform: 'win32' }), null);
  assert.notEqual(tryDetect({ platform: 'darwin' }), null);
});

test('the macOS backend implements the whole interface', () => {
  const backend = detect({ platform: 'darwin' });
  for (const key of REQUIRED) {
    assert.ok(key in backend, `backend is missing ${key}`);
    if (key !== 'platformName') {
      assert.equal(typeof backend[key], 'function', `${key} should be a function`);
    }
  }
});

test('the platform module exports every function the adapter expects', () => {
  // This is the "wired up by hand" trap: adding windows.ts and forgetting a
  // method is otherwise a runtime surprise on someone else's machine.
  const mod = macos as unknown as Record<string, unknown>;
  for (const key of ['available', 'listPrinters', 'defaultPrinter', 'print', 'printWithDialog']) {
    assert.equal(typeof mod[key], 'function', `macos.ts does not export ${key}`);
  }
});

test('the shared CUPS rail has the helpers both desktop platforms need', () => {
  const mod = lp as unknown as Record<string, unknown>;
  for (const key of ['cupsAvailable', 'listPrinters', 'defaultPrinter', 'capabilities', 'printPdf']) {
    assert.equal(typeof mod[key], 'function', `lp.ts does not export ${key}`);
  }
});

test('printer failures are translated into something a person can act on', () => {
  assert.match(
    lp.explainCupsFailure('lp: Forbidden'),
    /username and password/i,
    'an auth wall must be explained, not echoed'
  );
  assert.match(
    lp.explainCupsFailure('lp: Unable to locate printer "HP_SmartTank"'),
    /switched off|network/i
  );
  assert.equal(
    lp.explainCupsFailure('lp: something nobody has seen before'),
    '',
    'an unrecognised failure must fall through to the raw message rather than inventing an explanation'
  );
});

test('no other module decides the platform for itself', async () => {
  // The seam is only a seam if nothing above it branches on the OS. This reads
  // the source rather than the compiled output so it catches the intent, not an
  // inlined lookup.
  const fs = await import('node:fs');
  const path = await import('node:path');

  const root = path.resolve(__dirname, '../../src');
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'platform') {
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) {
        continue;
      }
      const text = fs.readFileSync(full, 'utf8');
      if (/process\.platform/.test(text)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    `these modules branch on process.platform directly: ${offenders.join(', ')} — ` +
      'the platform decision belongs in platform/detect.ts'
  );
});
