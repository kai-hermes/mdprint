/**
 * lifespan.test.ts — layer 13: a PDF that outlives its scratch directory.
 *
 * WHY THIS EXISTS. Two live bugs of the same shape, both reported by the user
 * on the same machine, both invisible to the whole suite:
 *
 *   The file "auth_bff_options_62d7e8f8.plan.pdf" couldn't be opened because
 *   there is no such file.
 *
 * The job PDF is written into a mkdtemp scratch directory, and the dialog door
 * hands that path to Preview — a program that reads the file on its own
 * schedule, seconds or minutes later, after the user has poked at settings.
 * But `runPrint` has a `finally` that deletes the scratch directory
 * unconditionally. So:
 *
 *   1. The dialog door handed the scratch path over, `finally` deleted the
 *      file under it, and the handoff failed. The comment claiming the PDF
 *      "is now owned by Preview" was aspirational — nothing implemented it.
 *   2. Worse for printing: `run()` waits for the CHILD PROCESS. `open -g -a
 *      Preview` exits as soon as the file has been handed off, so the parent
 *      walked straight into `finally` and deleted the PDF while the dialog was
 *      still on screen. A job sent to the dialog was deleted before the dialog
 *      read it — nothing printed at all.
 *   3. Separately, `savePdfAs()` used `path.dirname(pdfPath)` as the save
 *      dialog's DEFAULT directory, i.e. it offered to save the user's PDF
 *      *into the scratch folder that was about to be swept*. Accept the
 *      default and the file is gone moments after the dialog closes.
 *
 * The rule: ANY file we hand to a process that outlives us must survive that
 * process. A file whose lifetime is owned by another program belongs OUTSIDE
 * the directory that gets swept — not merely exempted from one `finally` by
 * hand, which is what the old comment assumed and what a later refactor undoes.
 *
 * THE TESTS ARE BEHAVIOURAL, NOT NAME-BASED, AND THAT MATTERS. The first draft
 * of this file asserted `handoffDir()` did not equal `workDir()`; mutation-
 * testing proved it worthless. Renaming `handoffDir()` and pointing it back
 * inside `workDir()` left the suite GREEN (5/5), because the assertion was
 * checking a function NAME. So the assertions below call the real functions and
 * compare what they RETURN — and the ones that can be checked against the real
 * filesystem do exactly that, with no stub in sight.
 *
 * Mutations this file is known to catch (each verified red):
 *   - deleting the `release()` call from the dialog door        -> 2 failures
 *   - pointing handoffDir() back inside workDir()               -> 2 failures
 *   - dropping the pending-marker write in release()            -> 1 failure
 *   - dropping the `.pending` exemption in sweepOldJobs()       -> 1 failure
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

/** Load a compiled module under a fake `vscode`, since only pdf.ts is needed. */
type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
const Module = require('node:module') as { _load: LoadFn };

interface PdfModule {
  workDir(): string;
  handoffDir(): string;
  release(pdfPath: string): Promise<string>;
  finishWith(pdfPath: string): Promise<void>;
  cleanup(dir: string): Promise<void>;
  sweepOldJobs(
    maxAgeMs?: number,
    root?: string,
    handoffMaxAgeMs?: number,
    handoffRoot?: string
  ): Promise<void>;
}

function loadPdf(): PdfModule {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return {};
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(process.cwd(), 'out/platform/pdf.js')) as PdfModule;
  } finally {
    Module._load = original;
  }
}

const pdf = loadPdf();

/** A directory of our own, so the real sweeps cannot touch the user's files. */
async function scratch(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lifespan-test-'));
}

/** A source slice between two markers, so line numbers can drift freely. */
function slice(from: string, marker: string, chars: number): string {
  const at = from.indexOf(marker);
  assert.ok(at > 0, `expected to find \`${marker}\``);
  return from.slice(at, at + chars);
}

const touch = (p: string) => fsp.writeFile(p, 'x', 'utf8');
const exists = async (p: string): Promise<boolean> => {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
};

test('a released PDF survives the cleanup that ends the run', async () => {
  // The defect, reproduced end to end against the real filesystem: build a
  // scratch directory the way htmlToPdf does, release the PDF, then delete the
  // scratch directory the way runPrint's `finally` does. The handed-over file
  // must still be there. This is the test that would have caught the user's
  // actual bug — no mocks, no source grepping.
  const dir = await scratch();
  try {
    const job = await fsp.mkdtemp(path.join(dir, 'job-'));
    const pdfPath = path.join(job, 'auth_bff_options_62d7e8f8.plan.pdf');
    await touch(pdfPath);

    const handedOver = await pdf.release(pdfPath);
    await pdf.cleanup(job); // what the `finally` does

    assert.ok(
      await exists(handedOver),
      'the released PDF must outlive the scratch directory it came from — ' +
        'this is the "couldn\'t be opened because there is no such file" bug'
    );
    assert.equal(
      await fsp.readFile(handedOver, 'utf8'),
      'x',
      'the released copy must be the same bytes, not merely a file at that path'
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(pdf.handoffDir(), { recursive: true, force: true });
  }
});

test('the checked-out area is never inside the swept area', () => {
  // BEHAVIOURAL, not name-based. The first draft of this file compared the
  // *identifiers* `handoffDir` and `workDir` and was defeated by renaming the
  // function while pointing it back inside workDir(). Compare the real returned
  // paths, prefix-wise, so it holds however the two are implemented.
  const swept = path.resolve(pdf.workDir());
  const checkedOut = path.resolve(pdf.handoffDir());

  assert.notEqual(
    swept,
    checkedOut,
    'a checked-out PDF cannot live in the directory that gets swept'
  );
  assert.ok(
    !checkedOut.startsWith(swept + path.sep) && !swept.startsWith(checkedOut + path.sep),
    `the checked-out area (${checkedOut}) must not sit inside the swept area ` +
      `(${swept}) — nested, the sweep would delete a file another program ` +
      'still has open, which is the reported bug at a later clock'
  );
});

test('a checked-out PDF is not swept away while its marker is fresh', async () => {
  // The reaper is the second half of the guarantee. A released file is only
  // safe if the sweep skips it, and the marker is what says so.
  //
  // THE FILE IS BACKDATED ON PURPOSE. The first draft of this test left the
  // copy at its natural mtime — which is milliseconds old — so the sweep's own
  // `st.mtimeMs < cutoff` check spared it whether the marker existed or not and
  // the test passed with the marker write deleted. Backdating is what makes the
  // MARKER the thing under test rather than incidental freshness: after a
  // reboot or a long session, a file handed to Preview an hour ago is not
  // fresh, and the marker is all that stands between it and the reaper.
  const dir = await scratch();
  try {
    const job = path.join(dir, 'job-x');
    await fsp.mkdir(job, { recursive: true });
    const pdfPath = path.join(job, 'report.pdf');
    await touch(pdfPath);
    const handedOver = await pdf.release(pdfPath);

    // One hour old, like a preview the user left open while they ate lunch.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fsp.utimes(handedOver, old, old);

    await pdf.sweepOldJobs(0, dir, 60 * 1000, pdf.handoffDir());

    assert.ok(
      await exists(handedOver),
      'a fresh .pending marker must exempt the file even when the file itself ' +
        'is older than the sweep cutoff — the marker is the ONLY signal we get ' +
        '(Preview reports nothing when it closes), so a sweep that relies on ' +
        'the file being recent deletes a PDF that is open on screen'
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(pdf.handoffDir(), { recursive: true, force: true });
  }
});

test('a long-abandoned checkout is eventually reclaimed', async () => {
  // The other side of the same coin: exempting a file forever would leak.
  // finishWith() is how a dialog we CAN observe says "done with this".
  const dir = await scratch();
  try {
    const job = path.join(dir, 'job-y');
    await fsp.mkdir(job, { recursive: true });
    const pdfPath = path.join(job, 'old.pdf');
    await touch(pdfPath);
    const handedOver = await pdf.release(pdfPath);

    await pdf.finishWith(handedOver);
    // Sweep with the handoff threshold at zero: an unmarked file is fair game.
    await pdf.sweepOldJobs(0, dir, 0, pdf.handoffDir());

    assert.ok(
      !(await exists(handedOver)),
      'an unmarked checked-out PDF must be reclaimed, or the handoff directory ' +
        'grows without bound'
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(pdf.handoffDir(), { recursive: true, force: true });
  }
});

test('the dialog door releases the PDF before opening it, and opens the released copy', () => {
  // Reachability of the fix itself, and the part the first draft of this fix
  // got backwards: release() must run BEFORE backend.printWithDialog() is
  // called, and printWithDialog must be given `handedOver`, not
  // `rendered.pdfPath`. Releasing after the handoff protects a copy that
  // Preview never opened — Preview is still holding the scratch path, and
  // `finally` deletes that out from under it. That is the literal bug this
  // file exists to catch, reproduced by a well-intentioned fix that released
  // too late.
  const source = read('src/extension.ts');
  const door = slice(source, 'if (withDialog) {', 1400);

  assert.match(
    door,
    /const handedOver = await release\(rendered\.pdfPath\)/,
    'the dialog door must release the PDF before handing it over — returning ' +
      'early from inside a try/finally does not save the file, because the ' +
      'finally still deletes the directory'
  );
  assert.match(
    door,
    /backend\.printWithDialog\(handedOver\)/,
    'Preview must be opened on the RELEASED path, not rendered.pdfPath — ' +
      'opening the scratch path and releasing afterwards protects a copy ' +
      'nothing has opened, while the file Preview is actually displaying is ' +
      'still deleted by the `finally`'
  );
  // Order: release() must come before the handoff, so the file `open -a
  // Preview` is given already survives the run.
  const releaseAt = door.indexOf('await release(rendered.pdfPath)');
  const handoffAt = door.indexOf('backend.printWithDialog(handedOver)');
  assert.ok(
    releaseAt > 0 && handoffAt > releaseAt,
    'release() must happen before printWithDialog() hands the file to Preview'
  );
  assert.match(
    door,
    /log\(`Released the PDF to/,
    'the surviving path must be logged — a user hunting for the file needs to ' +
      'be able to find it'
  );
});

test('the save dialog does not offer a directory that is about to be deleted', () => {
  // Bug 3, and the subtlest of the three: the default was correct-looking
  // (`the folder the PDF is in`) and catastrophic, because that folder is a
  // scratch directory with a lifetime of milliseconds.
  const source = read('src/save-pdf.ts');
  assert.doesNotMatch(
    source,
    /defaultUri:\s*vscode\.Uri\.file\(\s*path\.join\(\s*path\.dirname\(pdfPath\)/,
    'the save dialog must not DEFAULT to path.dirname(pdfPath) — accepting that ' +
      'default writes the user\'s PDF into the scratch directory, which is ' +
      'deleted when the run ends'
  );
  assert.match(
    source,
    /defaultUri: vscode\.Uri\.file\(path\.join\(defaultDir\(\), suggestedName/,
    'the save dialog must default to a real user directory'
  );
});
