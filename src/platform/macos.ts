/**
 * macos.ts — the alpha platform.
 *
 * Everything CUPS-shaped is inherited from lp.ts; what's left here is the two
 * things that are genuinely macOS:
 *
 *  1. Resolving a queue's *full* name. CUPS shows `HP_SmartTank` but the queue
 *     is registered as `HP_SmartTank-7` (`lpstat -l` knows; `lpstat -p` doesn't).
 *     Printing to the short name still works, but the job id in the notification
 *     is nicer when it matches what the user sees in the queue. Resolution is
 *     best-effort and falls back to the name as given.
 *
 *  2. THE DIALOG DOOR. `open -a Preview` on the PDF. That is the whole trick:
 *     Preview can print anything the printer supports — stapling, trays, paper
 *     type, folding — because it asks the driver. mdprint stops at the edge of
 *     what it models, and this is the documented door for everything past it.
 */

import { capture } from './exec';
import * as lp from './lp';
import { Printer, PrintJob } from './types';

/**
 * Hand a PDF to macOS's own print dialog by opening it in Preview.
 *
 * `-g` opens it hidden behind the current app rather than stealing focus with a
 * bouncing dock icon, and `-a Preview` pins it to Preview specifically so it
 * can't land in some app the user set as their PDF default.
 */
export async function printWithDialog(pdfPath: string): Promise<string> {
  await capture('/usr/bin/open', ['-g', '-a', 'Preview', pdfPath]);
  return 'Opened in Preview — press \u2318P there for the full macOS print dialog.';
}

/**
 * Map a short queue name onto the full CUPS destination name.
 *
 * `lpstat -l -p` describes each queue as `printer NAME ...` plus an indented
 * `Formats: ... Interface: ...` block, so the *full* name is the one lpstat
 * reports when you ask for it directly. We try the exact name first (a correct
 * name must never be mangled), then look for a single `name-<n>` match, and give
 * up quietly otherwise — printing to a short alias works fine.
 */
export async function resolveQueue(printer: string): Promise<string> {
  try {
    const exact = await capture(lp.LPSTAT, ['-p', printer]);
    if (exact.includes(`printer ${printer} `) || exact.includes(`printer ${printer}\n`)) {
      // Already resolvable — but a suffix queue may still exist and be the real
      // one, so keep looking before accepting it.
    }
  } catch {
    // Ask the long list below.
  }

  try {
    const all = await capture(lp.LPSTAT, ['-p']);
    const names: string[] = [];
    for (const line of all.split('\n')) {
      const m = /^printer\s+(\S+)\s+is\s+/.exec(line.trim());
      if (m) {
        names.push(m[1]);
      }
    }
    if (names.includes(printer)) {
      return printer;
    }
    const suffixed = names.filter((n) => n === printer || n.startsWith(printer + '-'));
    if (suffixed.length > 0) {
      // Highest suffix is the most recent registration of that device.
      return suffixed.sort().at(-1) ?? printer;
    }
  } catch {
    // Nothing to resolve against.
  }

  return printer;
}

export const platformName = 'macOS';

export async function available(): Promise<boolean> {
  return lp.cupsAvailable();
}

export async function listPrinters(): Promise<Printer[]> {
  return lp.listPrinters();
}

export async function defaultPrinter(): Promise<string> {
  return lp.defaultPrinter();
}

export async function print(
  pdfPath: string,
  printer: string,
  job: PrintJob
): Promise<string> {
  const queue = await resolveQueue(printer);
  return lp.withExplanation(() => lp.printPdf(pdfPath, queue, job));
}

/** The bytes that will be compiled into the HTML->PDF converter on first run. */
export { PDF_SHIM_SOURCE, PDF_SHIM_FILENAME } from './shim-source';
