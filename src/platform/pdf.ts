/**
 * pdf.ts — HTML -> PDF on this machine.
 *
 * The extension has styled HTML in memory and needs a real PDF file to hand to
 * CUPS. On macOS that job belongs to the Swift shim (see `shim-source.ts` for
 * why it can't be TypeScript). This module is the part that:
 *
 *   - writes the HTML to a temp file,
 *   - compiles the shim ONCE, on first use, into the extension's storage,
 *   - runs it, and
 *   - turns any failure into a sentence a person can act on.
 *
 * Everything here is deliberately boring; the interesting decisions were all
 * made in the POC and are documented in the shim's own comments.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { probe, run } from './exec';
import { PDF_SHIM_FILENAME, PDF_SHIM_SOURCE } from './shim-source';
import { PrintError } from './types';

/**
 * A private scratch directory. One per extension install, cleaned by the OS.
 * Named with the extension so an abandoned file is identifiable.
 */
export function workDir(): string {
  return path.join(os.tmpdir(), 'mdprint');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Create the scratch root if it isn't there yet.
 *
 * MUST run before anything writes inside the root -- `fs.mkdtemp` will not
 * create its own parent. This was a real bug: the first print after a fresh
 * install died with `ENOENT ... mkdtemp '.../T/mdprint/job-XXXXXX'` because
 * `htmlToPdf` asked for a job directory before the root existed. `ensureShim`
 * happened to create the root as a side effect, but only ever ran *after* that
 * point, so the very first job had no parent to be created in.
 *
 * `root` is a parameter so tests can point it at a disposable directory. In
 * production it is always `workDir()`.
 */
export async function ensureWorkDir(root = workDir()): Promise<void> {
  await ensureDir(root);
}

/** Is the Swift compiler here? Checked once, then cached. */
let swiftcCache: boolean | undefined;

export async function swiftcAvailable(): Promise<boolean> {
  if (swiftcCache === undefined) {
    swiftcCache = await probe('/usr/bin/xcrun', ['--find', 'swiftc']);
    if (!swiftcCache) {
      swiftcCache = await probe('swiftc', ['--version']);
    }
  }
  return swiftcCache;
}

/** The compiled shim's path, and a hash so we can tell when a rebuild is needed. */
function shimPaths(): { source: string; binary: string; stamp: string } {
  const dir = path.join(workDir(), 'shim');
  return {
    source: path.join(dir, PDF_SHIM_FILENAME),
    binary: path.join(dir, 'mdprint-pdf'),
    stamp: path.join(dir, 'source.sha256'),
  };
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compile the converter, if it isn't already compiled from this exact source.
 *
 * Two details that cost real debugging time and must not be "cleaned up":
 *
 *  - We compare a hash of the SOURCE, not timestamps. A stale binary in
 *    `.build` once printed from old code and produced a baffling result, so the
 *    source hash is the only thing we trust to say "this binary is current".
 *
 *  - A failed compile deletes its output. A half-written binary that still
 *    executes is worse than no binary.
 */
export async function ensureShim(log: (line: string) => void): Promise<string> {
  const { source, binary, stamp } = shimPaths();
  await ensureDir(path.dirname(source));

  const wanted = hashOf(PDF_SHIM_SOURCE);

  try {
    const have = (await fs.readFile(stamp, 'utf8')).trim();
    const bin = await fs.stat(binary);
    if (have === wanted && bin.size > 0) {
      return binary;
    }
  } catch {
    // Not built yet, or built from something else. Fall through and build.
  }

  if (!(await swiftcAvailable())) {
    throw new PrintError(
      "mdprint needs Xcode's command line tools to build its PDF converter the first " +
        'time (it only takes a few seconds, and only happens once). Run ' +
        '`xcode-select --install` in Terminal, then try again.'
    );
  }

  await fs.writeFile(source, PDF_SHIM_SOURCE, 'utf8');
  log('Building the PDF converter (first run only, a few seconds)\u2026');

  // No -O: this is a tiny program whose runtime is dominated by WebKit and
  // PDFKit, and a fast cold build is worth more than a fast binary here.
  //
  // PDFKit must be linked explicitly: the pagination merge uses it, and without
  // the flag the compile fails with "no such module 'PDFKit'" instead of
  // producing a working binary.
  try {
    await run(
      'swiftc',
      [
        '-o', binary, source,
        '-framework', 'WebKit',
        '-framework', 'AppKit',
        '-framework', 'PDFKit',
      ],
      { timeoutMs: 180_000 }
    );
  } catch (e) {
    await fs.rm(binary, { force: true });
    throw new PrintError(
      "Couldn't build mdprint's PDF converter. " +
        (e instanceof Error ? e.message : String(e)) +
        ' — the raw source is in ' +
        source +
        ' if you want to try `swiftc` by hand.'
    );
  }

  await fs.writeFile(stamp, wanted, 'utf8');
  return binary;
}

/**
 * Render HTML to a PDF file. Returns the PDF's path.
 *
 * `log` is the extension's output channel, so the build and the page geometry
 * the shim reports are visible when someone wants to know why a sheet looks the
 * way it does. The shim prints `page: A4 margins t14 r15 b16 l15mm` on stderr,
 * which is the fastest way to diagnose a layout question without printing.
 */
export async function htmlToPdf(
  html: string,
  label: string,
  log: (line: string) => void
): Promise<string> {
  // The root must exist before mkdtemp, which will not create its own parent.
  // This is the fix for the fresh-install ENOENT -- see ensureWorkDir.
  await ensureWorkDir();

  const dir = await fs.mkdtemp(path.join(workDir(), 'job-'));
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
  const htmlPath = path.join(dir, `${safe}.html`);
  const pdfPath = path.join(dir, `${safe}.pdf`);

  await fs.writeFile(htmlPath, html, 'utf8');

  const binary = await ensureShim(log);

  // The shim is a GUI-framework program: it boots AppKit to borrow WebKit, so it
  // can take a moment on a cold filesystem. Give it room rather than declaring a
  // stall on a slow first run.
  await run(binary, [htmlPath, pdfPath], { timeoutMs: 60_000 });

  let size = 0;
  try {
    size = (await fs.stat(pdfPath)).size;
  } catch {
    throw new PrintError(
      "The PDF converter didn't produce a file. Nothing was printed \u2014 try again, " +
        'and if it keeps happening, the output pane has the details.'
    );
  }
  if (size === 0) {
    throw new PrintError('The PDF converter produced an empty file, so nothing was printed.');
  }

  log(`Rendered ${Math.round(size / 1024)} KB PDF`);
  return pdfPath;
}

/** Delete a job's scratch directory and everything in it. */
export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Delete scratch directories left behind by an earlier crash or kill. */
export async function sweepOldJobs(
  maxAgeMs = 24 * 60 * 60 * 1000,
  root = workDir()
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // No root yet is the normal state on a fresh install, not an error.
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries
      .filter((e) => e.startsWith('job-'))
      .map(async (e) => {
        const full = path.join(root, e);
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs < cutoff) {
            await fs.rm(full, { recursive: true, force: true });
          }
        } catch {
          // Gone already, or not ours to delete.
        }
      })
  );
}
