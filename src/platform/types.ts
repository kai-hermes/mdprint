/**
 * types.ts — the printer seam.
 *
 * This is the port of the POC's PrintPlatform interface, and it is the seam the
 * whole architecture hangs off: the extension above it talks to a `PrintBackend`
 * and never to an OS. Adding a platform means adding a class in this folder and
 * one line in `detect.ts` — no edits above the seam, no conditionals leaking
 * upward, no `if (process.platform === ...)` anywhere else in the codebase.
 *
 * ── THE RULE THAT KEEPS THIS SMALL ────────────────────────────────────────────
 * mdprint is NOT a print driver, and it must never become one.
 *
 *   A flag every OS already exposes  -> a field on PrintJob.
 *   A per-model name from a PPD      -> the OS print dialog. Forever.
 *
 * "Two-sided" is a field: every OS has a word for it. "Staple top-left, tray 3,
 * 120gsm" is not: those are model-specific names that only exist in the printer's
 * own PPD, and the moment you're parsing a PPD to build an options UI, you have
 * lost. That is what the dialog door in `printWithDialog` is for.
 */

/** Everything mdprint is willing to decide about a sheet. Deliberately tiny. */
export interface PrintJob {
  /**
   * Duplex. Three honest strings, matching the names CUPS uses.
   *
   * `undefined` means LEAVE THE PRINTER'S DEFAULT ALONE — no `sides` flag is
   * passed at all. This is not the same as 'one-sided', and the distinction
   * matters: overriding a printer that is configured two-sided by default
   * without being asked would silently burn paper, and the whole point of this
   * tool is that it never wastes a sheet.
   */
  duplex?: Duplex;
  /** Default 1. */
  copies?: number;
  /** e.g. '1-3,7' — a CUPS page range string. Undefined means all pages. */
  range?: string;
  /** What to print, when there's no file on disk (an unsaved buffer). */
  source: PrintSource;
}

export type Duplex = 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge';

export type PrintSource =
  | { kind: 'pdf'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin'; data: Buffer; label: string };

/** One page size the queue will accept, in the queue's own vocabulary. */
export interface PaperSize {
  id: string;
  label: string;
  /** True for the queue's configured default. */
  isDefault: boolean;
}

export interface PrinterCapabilities {
  /** False for any backend whose OS won't tell us — capability claims must be honest. */
  known: boolean;
  /** True if the queue accepts *any* two-sided mode. Absence means: don't offer it. */
  duplex: boolean;
  paperSizes: PaperSize[];
}

export interface Printer {
  /** Queue name — the string every OS asks for. */
  name: string;
  /** Where it came from: 'local', 'network', 'shared', or 'default'. */
  kind: string;
  capabilities: PrinterCapabilities;
}

/**
 * A print failure that a human can act on.
 *
 * Every message from here ends up in a notification, so it obeys the fail-loud
 * rule: say what is wrong AND what to do about it. Never "print failed".
 */
export class PrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintError';
  }
}

export interface PrintBackend {
  /** Human name for the notification, e.g. 'macOS'. */
  readonly platformName: string;

  /** True if this backend can actually print on the current machine. */
  available(): Promise<boolean>;

  /** Every queue this OS knows about. Never throws for "none found" — returns []. */
  listPrinters(): Promise<Printer[]>;

  /** Queue name to use when the document and settings name nothing. '' if unknown. */
  defaultPrinter(): Promise<string>;

  /** Send it to paper. Resolves with a short human line for the notification. */
  print(pdfPath: string, printer: string, job: PrintJob): Promise<string>;

  /**
   * THE DIALOG DOOR. Hand the PDF to the OS's own print dialog and stop.
   *
   * This is a first-class, user-chosen door — never a fallback the one-click
   * path can drop into. When something wants a per-model option mdprint
   * deliberately doesn't model, this is where the user goes on purpose.
   */
  printWithDialog(pdfPath: string): Promise<string>;
}
