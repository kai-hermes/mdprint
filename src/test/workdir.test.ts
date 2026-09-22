/**
 * workdir.test.ts — the scratch directory must exist before anyone writes in it.
 *
 * This test exists because of a real, reported failure. On a FRESH INSTALL the
 * very first print died with:
 *
 *     ERROR: ENOENT: no such file or directory,
 *     mkdtemp '/var/folders/.../T/mdprint/job-jNS7tf'
 *
 * The cause was an ordering bug, not a missing call: `htmlToPdf` called
 * `mkdtemp` inside the scratch ROOT before anything had created that root.
 * `ensureShim` did create it — but `htmlToPdf` asked for a job directory
 * *first*, so on a machine where nothing had been built yet the parent was
 * simply absent. `sweepOldJobs` ran at activation and hit the same missing
 * directory, but swallowed the error, which is why this looked like nothing
 * happened until the first print.
 *
 * Every test here is about the ORDER of operations on a cold filesystem, since
 * that is the only condition the old suite never reproduced.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { ensureWorkDir, sweepOldJobs, workDir } from '../platform/pdf';

/** Point the scratch root somewhere disposable, and remember the real one. */
async function withIsolatedWorkDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdprint-test-'));
  return fn(root);
}

test('workDir lives under the OS temp directory', () => {
  // Not a style point: a scratch dir outside temp is one a user has to clean
  // up, and we rely on the OS reclaiming it after a crash.
  assert.equal(path.dirname(workDir()), os.tmpdir());
  assert.equal(path.basename(workDir()), 'mdprint');
});

test('ensureWorkDir creates the root that mkdtemp needs as a parent', async () => {
  await withIsolatedWorkDir(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
    // Precondition: the thing must genuinely be gone, or the test proves nothing.
    await assert.rejects(fs.stat(root), 'expected the isolated root to be absent');

    await ensureWorkDir(root);

    const st = await fs.stat(root);
    assert.ok(st.isDirectory(), 'ensureWorkDir must leave a real directory behind');
  });
});

test('ensureWorkDir is safe to call when the directory already exists', async () => {
  await withIsolatedWorkDir(async (root) => {
    await ensureWorkDir(root);
    // The second call is the common case -- every print after the first.
    await ensureWorkDir(root);
    const st = await fs.stat(root);
    assert.ok(st.isDirectory());
  });
});

test('mkdtemp succeeds immediately after ensureWorkDir on a cold root', async () => {
  // The exact reported sequence: fresh root, then ask for a job directory --
  // with no shim build in between to create the parent as a side effect.
  await withIsolatedWorkDir(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
    await ensureWorkDir(root);

    const job = await fs.mkdtemp(path.join(root, 'job-'));
    const st = await fs.stat(job);
    assert.ok(st.isDirectory(), 'a job directory must be creatable right after setup');
  });
});

test('sweepOldJobs survives a missing root instead of throwing', async () => {
  await withIsolatedWorkDir(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
    // Must resolve, not reject: this runs at activation, and a throw there
    // would break extension startup for everyone on a fresh machine.
    await sweepOldJobs(0, root);
  });
});

test('sweepOldJobs deletes stale job dirs and keeps fresh ones', async () => {
  await withIsolatedWorkDir(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
    await ensureWorkDir(root);

    const stale = await fs.mkdtemp(path.join(root, 'job-'));
    const fresh = await fs.mkdtemp(path.join(root, 'job-'));
    const notOurs = path.join(root, 'shim');
    await fs.mkdir(notOurs, { recursive: true });

    // Age the stale one by two days; leave `fresh` alone.
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await fs.utimes(stale, old / 1000, old / 1000);

    await sweepOldJobs(24 * 60 * 60 * 1000, root);

    await assert.rejects(fs.stat(stale), 'the stale job directory should be gone');
    assert.ok(await fs.stat(fresh), 'a fresh job directory must be kept');
    assert.ok(
      await fs.stat(notOurs),
      'sweeping must never touch anything that is not a job- directory'
    );
  });
});
