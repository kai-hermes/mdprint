/**
 * shim.test.ts — the converter's contract.
 *
 * The Swift converter can't be executed in this test suite (it needs macOS, a
 * window server, and WebKit, and running it would print paper on someone's
 * machine). So what's tested here is the part that CAN rot silently: the
 * embedded source and the build command.
 *
 * That matters more than it sounds. `shim-source.ts` is GENERATED from
 * `shim.swift` by `npm run embed-shim`. If someone edits the Swift and forgets
 * to re-embed, the extension keeps shipping the old converter and the only
 * symptom is a wrong sheet of paper — the worst possible feedback loop. This
 * test makes that failure loud and immediate.
 *
 * The build flag list is asserted too, because a missing `-framework PDFKit`
 * doesn't fail at build time in this repo — it fails on a user's first print.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { PDF_SHIM_FILENAME, PDF_SHIM_SOURCE } from '../platform/shim-source';

const SHIM_FILE = path.resolve(__dirname, '../../src/platform/shim.swift');

test('the embedded converter is non-trivial and looks like Swift', () => {
  assert.ok(PDF_SHIM_SOURCE.length > 5000, 'embedded shim is suspiciously short');
  assert.ok(PDF_SHIM_SOURCE.includes('import WebKit'), 'shim does not import WebKit');
  assert.ok(PDF_SHIM_SOURCE.includes('import PDFKit'), 'shim does not import PDFKit');
  assert.ok(
    PDF_SHIM_SOURCE.includes('createPDF'),
    'shim does not call createPDF, so it is not rendering anything'
  );
});

test('the embedded copy is in sync with the editable source', () => {
  if (!fs.existsSync(SHIM_FILE)) {
    // The .swift is the editable original and must stay in the repo.
    assert.fail(`${SHIM_FILE} is missing — that is the file people edit.`);
  }
  const onDisk = fs.readFileSync(SHIM_FILE, 'utf8').trimEnd();
  // The embedded constant is a template literal that opens with a newline so the
  // generated file reads nicely; trim it so the comparison is about content.
  const embedded = PDF_SHIM_SOURCE.replace(/^\n/, '').trimEnd();

  assert.equal(
    embedded,
    onDisk,
    'src/platform/shim.swift and src/platform/shim-source.ts have drifted apart. ' +
      'Run `npm run embed-shim` to re-embed the Swift into the TypeScript constant.'
  );
});

test('the filename the extension writes is the one the shim expects', () => {
  assert.equal(PDF_SHIM_FILENAME, 'mdprint-pdf.swift');
  assert.ok(PDF_SHIM_FILENAME.endsWith('.swift'), 'swiftc needs the right extension');
});

test('the shim does its own pagination and does not trust createPDF to slice', () => {
  // The load-bearing discovery: createPDF does not paginate, so the shim has to
  // measure blocks and rasterise page by page. If someone "simplifies" this
  // away, long documents silently lose everything after page one.
  assert.ok(
    PDF_SHIM_SOURCE.includes('measureBlocks'),
    'the block measurement pass is gone — multi-page output will break'
  );
  assert.ok(
    PDF_SHIM_SOURCE.includes('translateY'),
    'the per-page translate is gone — pages will all render the same content'
  );
  assert.ok(
    /PDFDocument/.test(PDF_SHIM_SOURCE),
    'PDFKit is no longer used to merge pages'
  );
});

test('the shim guards against an empty render rather than printing a blank sheet', () => {
  // A silent blank page is the one failure mode this tool must never have.
  assert.ok(
    /nearly empty PDF|data\.count < \d+/.test(PDF_SHIM_SOURCE),
    'the shim no longer rejects a nearly-empty render'
  );
});

test('the swifc build command links every framework the shim imports', () => {
  const pdfTs = fs.readFileSync(
    path.resolve(__dirname, '../../src/platform/pdf.ts'),
    'utf8'
  );
  for (const framework of ['WebKit', 'AppKit', 'PDFKit']) {
    assert.ok(
      new RegExp(`'${framework}'`).test(pdfTs),
      `the swiftc invocation does not link ${framework}`
    );
  }
});
