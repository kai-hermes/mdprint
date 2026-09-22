/**
 * detect.ts — pick a backend, or say honestly that there isn't one.
 *
 * The whole platform story is this file plus the classes beside it. Nothing
 * above the seam knows what OS it's on, so adding Windows is: write
 * `windows.ts` implementing PrintBackend, add one line to MACOS/LINUX/etc below.
 * No edits to the printer picker, the document handling, or the commands.
 */

import * as macos from './macos';
import { PrintBackend, PrintError } from './types';

/**
 * Backends in preference order, with the platforms each claims.
 *
 * macOS is first because it's the alpha and the only platform with the
 * HTML->PDF converter built. Linux is wired for listing and printing but has no
 * converter yet, so it reports itself unavailable until one exists — better an
 * honest "not yet" than a print button that does nothing.
 */
interface BackendEntry {
  platforms: NodeJS.Platform[];
  create: () => PrintBackend;
  /** Set once this backend can render HTML->PDF on its own. */
  canRender: boolean;
}

const BACKENDS: BackendEntry[] = [
  {
    platforms: ['darwin'],
    create: () => adapt(macos, 'macOS'),
    canRender: true,
  },
];

export interface DetectOptions {
  /** Override for tests: pretend we're on this platform. */
  platform?: NodeJS.Platform;
}

/**
 * The backend for this machine.
 *
 * Throws a PrintError explaining exactly what's missing when there isn't one —
 * a click that silently does nothing is worse than a click that says why.
 */
export function detect(options: DetectOptions = {}): PrintBackend {
  const platform = options.platform ?? process.platform;
  const entry = BACKENDS.find((b) => b.platforms.includes(platform));

  if (!entry) {
    throw new PrintError(
      `mdprint can't print on this system yet (it's built for macOS first; ` +
        `${platform} support is a matter of adding one class). ` +
        `"Save as PDF" still works everywhere — use that and print from your usual app.`
    );
  }
  if (!entry.canRender) {
    throw new PrintError(
      `mdprint can't build the PDF on this system yet — the part that turns a page ` +
        `into paper is only written for macOS so far. "Save as PDF" still works.`
    );
  }

  return entry.create();
}

/** Wrap a module of free functions into the interface, so each OS file stays flat. */
function adapt(
  mod: {
    platformName: string;
    available: () => Promise<boolean>;
    listPrinters: () => Promise<never[] | import('./types').Printer[]>;
    defaultPrinter: () => Promise<string>;
    print: (pdf: string, printer: string, job: import('./types').PrintJob) => Promise<string>;
    printWithDialog: (pdf: string) => Promise<string>;
  },
  label: string
): PrintBackend {
  return {
    platformName: mod.platformName || label,
    available: () => mod.available(),
    listPrinters: () => mod.listPrinters() as Promise<import('./types').Printer[]>,
    defaultPrinter: () => mod.defaultPrinter(),
    print: (pdf, printer, job) => mod.print(pdf, printer, job),
    printWithDialog: (pdf) => mod.printWithDialog(pdf),
  };
}

/** Convenience: try to detect, and return null rather than throwing. */
export function tryDetect(options: DetectOptions = {}): PrintBackend | null {
  try {
    return detect(options);
  } catch {
    return null;
  }
}
