/**
 * lp.ts — the shared CUPS rail (macOS + Linux).
 *
 * macOS and Linux both print through CUPS: same `lp`, same `lpstat`, same
 * `lpoptions`, same `/usr/bin` names. That shared machinery lives here so the
 * two backends stay thin and neither can drift from the other. What's left in
 * the per-OS classes is only the genuinely OS-specific bit — how you hand a PDF
 * to the print *dialog*, which is Cocoa on one side and GTK on the other.
 *
 * Option flags are built here, in one place, because they are the part of this
 * seam that must never surprise anyone: see `buildFlags` — the "no flag means
 * leave the printer alone" rule lives and dies there.
 */

import { capture, probe, run } from './exec';
import { Printer, PrintError, PrintJob } from './types';

/** The ip command CUPS ships. Present on every Mac; `cups-client` on Linux. */
export const LP = '/usr/bin/lp';
export const LPSTAT = '/usr/bin/lpstat';
export const LPOPTIONS = '/usr/bin/lpoptions';
export const LPR = '/usr/bin/lpr';

/** Is the CUPS client toolchain actually here? */
export async function cupsAvailable(): Promise<boolean> {
  return probe(LPSTAT, ['-p']);
}

/**
 * Every queue CUPS knows about, with the honest capabilities of each.
 *
 * `lpstat -p` lists queues as `printer NAME is idle.` / `... disabled` /
 * `... now printing`. All three are real queues — a disabled one can still be
 * chosen (and CUPS will hold the job), so they're all listed and the kind string
 * reflects the state rather than hiding the queue.
 */
export async function listPrinters(): Promise<Printer[]> {
  let out: string;
  try {
    out = await capture(LPSTAT, ['-p']);
  } catch {
    return [];
  }

  const printers: Printer[] = [];
  for (const line of out.split('\n')) {
    const m = /^printer\s+(\S+)\s+is\s+(.+?)\.?\s*$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const name = m[1];
    const state = m[2];
    const kind = state.includes('printing')
      ? 'printing'
      : state.includes('disabled')
        ? 'disabled'
        : 'idle';
    printers.push({ name, kind, capabilities: await capabilities(name) });
  }
  return printers;
}

/**
 * The queue CUPS would use with no `-d` flag.
 *
 * `lpoptions -d` prints the default as `printer-info` or a bare name depending
 * on the distro, so this accepts either shape and never throws — an empty
 * string means "we don't know", which the caller shows as such.
 */
export async function defaultPrinter(): Promise<string> {
  try {
    const out = await capture(LPOPTIONS, ['-d']);
    const m = /printer=(\S+)/.exec(out) ?? /^(\S+)$/m.exec(out.trim());
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * Ask the queue itself what it supports, via `lpoptions -l`.
 *
 * mdprint never guesses at capabilities from a model name. Either the queue
 * advertises the option or we treat it as unavailable — a made-up "yes" here
 * turns into a rejected job and a wasted trip to the printer.
 */
export async function capabilities(printer: string): Promise<{
  known: boolean;
  duplex: boolean;
  paperSizes: { id: string; label: string; isDefault: boolean }[];
}> {
  let out: string;
  try {
    out = await capture(LPOPTIONS, ['-p', printer, '-l']);
  } catch {
    return { known: false, duplex: false, paperSizes: [] };
  }

  return parseCapabilities(out);
}

/**
 * Turn `lpoptions -l` output into capabilities.
 *
 * Split out from `capabilities()` — which shells out — so the parsing can be
 * tested against REAL recorded output without a printer attached. The obvious
 * alternative, having the test re-implement this loop, is how the duplex bug
 * survived its own test suite: a mirror of the parser keeps calling the fixed
 * helper and passes no matter what the shipped code does. See duplex.test.ts.
 */
export function parseCapabilities(out: string): {
  known: boolean;
  duplex: boolean;
  paperSizes: { id: string; label: string; isDefault: boolean }[];
} {
  let duplex = false;
  const paperSizes: { id: string; label: string; isDefault: boolean }[] = [];

  for (const raw of out.split('\n')) {
    if (!raw.trim()) {
      continue;
    }
    const colon = raw.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const key = optionKey(raw.slice(0, colon));
    const values = raw.slice(colon + 1).trim();

    // `Duplex/Duplex: *None DuplexNoTumble DuplexTumble` — the * marks the default.
    if (key === 'Duplex') {
      duplex = advertisesDuplex(values);
      continue;
    }

    if (key === 'PageSize') {
      for (const token of values.split(/\s+/)) {
        const isDefault = token.startsWith('*');
        const id = isDefault ? token.slice(1) : token;
        if (id) {
          paperSizes.push({ id, label: id, isDefault });
        }
      }
    }
  }

  return { known: true, duplex, paperSizes };
}

/**
 * The option name from the left of an `lpoptions -l` line.
 *
 * CUPS prints these as `Name/Human readable label`, e.g.
 *
 *     Duplex/Duplex: *None DuplexNoTumble DuplexTumble
 *     PageSize/Media Size: 3.5x5 4x6 *A4 A5
 *     ColorModel/Output Mode: *RGB Gray
 *
 * so the bit before the first `/` is the name you can actually pass as `-o`.
 * Comparing the whole key against `'Duplex'` never matched, which silently
 * reported EVERY printer as unable to print two-sided — the printer advertised
 * it the whole time, and the failure was a string comparison.
 *
 * Only the first `/` splits the two halves: labels legitimately contain slashes.
 */
export function optionKey(left: string): string {
  const slash = left.indexOf('/');
  return (slash < 0 ? left : left.slice(0, slash)).trim();
}

/**
 * Does a `Duplex` value list offer anything other than off?
 *
 * `*None` (or a bare `None`) means the queue only does single-sided, so we must
 * not offer two-sided anything. Anything else in the list is a real duplex mode
 * — including the case where the DEFAULT is two-sided and `None` trails it.
 */
export function advertisesDuplex(values: string): boolean {
  return values
    .split(/\s+/)
    .map((tok) => tok.replace(/^\*/, '').trim())
    .some((tok) => tok !== '' && tok !== 'None');
}

/**
 * Build the option flags for a job.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────────────────
 * If the caller didn't ask for something, NO FLAG IS EMITTED. Not a default, not
 * a guess, nothing. An omitted duplex means "use whatever this printer is set to
 * do", which is exactly what a person pressing Cmd-P with no dialog would get.
 * Emitting `sides=one-sided` "for safety" would quietly override a two-sided
 * office printer and waste a ream.
 *
 * Exported so the tests can pin the argv without spawning a printer.
 */
export function buildFlags(job: PrintJob): string[] {
  const flags: string[] = [];

  if (job.duplex !== undefined) {
    flags.push('-o', `sides=${job.duplex}`);
  }
  if (job.copies !== undefined && job.copies !== 1) {
    flags.push('-n', String(job.copies));
  }
  if (job.range !== undefined && job.range.trim() !== '') {
    flags.push('-o', `page-ranges=${job.range.trim()}`);
  }

  return flags;
}

/**
 * Send a PDF to a queue. Returns the human line that goes in the notification;
 * the job id comes from CUPS itself, so it's real rather than invented.
 */
export async function printPdf(pdfPath: string, printer: string, job: PrintJob): Promise<string> {
  const args = ['-d', printer, ...buildFlags(job), pdfPath];
  const out = await capture(LP, args);
  const m = /request id is (\S+)/.exec(out);
  const id = m ? m[1] : '';
  const sides = job.duplex ? `, ${job.duplex.replace(/-/g, ' ')}` : '';
  return `Sent to ${printer}${id ? ` (job ${id})` : ''}${sides}.`;
}

/** Cancel a job — used by the "hold first, then release" verification path. */
export async function cancelJob(id: string): Promise<void> {
  await run('/usr/bin/cancel', [id]);
}

/**
 * The honest printer-error explainer. CUPS says "Waiting for authentication"
 * when a queue was added without stored credentials, which is meaningless to a
 * person standing at a printer. Translate the failures we've actually seen.
 */
export function explainCupsFailure(text: string): string {
  if (/auth|forbidden|401|403|client-error-forbidden/i.test(text)) {
    return (
      'This printer is asking for a username and password. Add the credentials ' +
      'in your system print settings, then try again.'
    );
  }
  if (/unable to locate printer|no route to host|connection refused|host is down/i.test(text)) {
    return 'That printer is switched off or not on this network.';
  }
  if (/No such file|invalid destination/i.test(text)) {
    return "That printer isn't set up on this machine any more — pick another one.";
  }
  return '';
}

/** Wrap a CUPS throw with the friendlier explanation when we have one. */
export async function withExplanation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const better = explainCupsFailure(raw);
    throw better ? new PrintError(better) : (e as Error);
  }
}
