/**
 * destination-rules.ts — the pure half of "where does this PDF go?".
 *
 * Split from the editor shell for the same reason as `duplex-rules.ts` /
 * `duplex-choice.ts`, `stage-plan.ts` / `progress.ts`, and `template-css.ts` /
 * `theme.ts`: `vscode` cannot be imported outside the editor, so anything
 * importable is untestable. The decision logic lives here; the QuickPick lives
 * in `destination-choice.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE BUG CLASS THIS FILE EXISTS FOR
 *
 * The user picked up on the two-sided bug and generalised it, which is the
 * right instinct:
 *
 *   "Double sided was also not advertised on any device despite it supporting
 *    it, so thats another one to fix."   (2026-09-22)
 *
 * That was two separate faults — the capability was never PARSED (a CUPS key
 * mismatch), and then it was never OFFERED (dead exports, an uncalled
 * function). A third variant is waiting, and it is the one this file is built
 * to avoid:
 *
 *     A CHOICE THAT IS OFFERED BUT UNREACHABLE IS THE SAME BUG.
 *
 * "Save as PDF" is trivially easy to get wrong in exactly that way. Add a row
 * to the printer QuickPick and it works perfectly on a machine with a printer
 * and a default already set... and is invisible on every other machine, because
 * the picker never opens:
 *
 *   - one printer, or a matched default -> `pickPrinterOrSingle` returns early,
 *     and the QuickPick is never shown;
 *   - zero printers -> it throws before any picker exists.
 *
 * Those are precisely the machines where a user most wants a PDF, so the naive
 * implementation fails hardest exactly where the feature matters most. Every
 * rule below is a consequence of that one observation.
 */

import { Printer } from './platform/types';

/**
 * A printer row and the PDF row are different kinds of answer, so they are
 * different types rather than a printer with a magic name.
 *
 * Encoding it in the type is what stops the PDF row being fed to `lp -d`, which
 * is the failure mode of doing this with a sentinel string like
 * `'__save_as_pdf__'`.
 */
export type Destination =
  | { kind: 'printer'; printer: string }
  | { kind: 'pdf' };

/** The QuickPick row for saving a PDF, with no printer involved. */
export const PDF_ROW = {
  label: '$(file-pdf) Save as PDF\u2026',
  description: 'Choose where to put the file',
  detail:
    "No printer involved. Writes the PDF you'd have printed, so you can check " +
    'the layout or send it on.',
} as const;

/** One row per printer, phrased the same way `choosePrinter` phrases them. */
export interface PrinterRow {
  printer: string;
  label: string;
  description: string;
  detail: string;
}

/**
 * Rows for every printer, in the picker's own wording, so the two surfaces
 * cannot drift apart.
 *
 * `capabilities.duplex` is deliberately surfaced here: the user reported that a
 * genuinely two-sided printer was advertised as single-sided, and the picker is
 * where that claim becomes visible.
 */
export function printerRow(p: Printer): PrinterRow {
  const bits: string[] = [p.kind === 'ipp' ? 'Network' : 'Local'];
  if (p.capabilities.known) {
    if (p.capabilities.duplex) {
      bits.push('two-sided available');
    }
    const def = p.capabilities.paperSizes.find((s) => s.isDefault);
    if (def) {
      bits.push(def.label);
    }
  }

  return {
    printer: p.name,
    label: p.name,
    description: bits.join(' \u00b7 '),
    detail: p.capabilities.known
      ? p.capabilities.duplex
        ? 'Two-sided available'
        : 'Single-sided only (this printer says so)'
      : 'Capabilities unknown \u2014 mdprint will not offer options this queue cannot confirm',
  };
}

/**
 * Should the user be shown a list at all?
 *
 * The rule that keeps "Save as PDF" reachable: **any time there is more than
 * one thing to choose from, ask** — and the PDF row counts as a choice.
 *
 * So the answer is unconditionally yes, in both directions, and this function
 * exists to make that explicit rather than leave it as a missing `if`:
 *
 *   - one printer / matched default -> the old code returned early and the
 *     picker never opened. With the PDF row in play, "the printer" is no longer
 *     the only honest answer, so the list must still appear.
 *   - zero printers -> the old code threw. The PDF row above the empty list
 *     still works, so this is the case where the list matters MOST.
 *
 * It takes the list anyway so callers read as a question about real state, and
 * so a future rule (e.g. "remember my answer and stop asking") has one place to
 * live instead of three call sites.
 */
export function shouldAsk(_list: Printer[]): boolean {
  return true;
}

/**
 * The order rows appear in.
 *
 * Printers first, because printing is what this extension is for; "Save as PDF"
 * last, as the alternative. A PDF row pinned to the top would become the
 * accidental default answer for anyone who hits Enter without reading, and
 * mdprint's whole premise is that a document never goes somewhere the user
 * didn't mean.
 */
export function destinationRows(list: Printer[]): PrinterRow[] {
  return list.map(printerRow);
}

/** True when there is nothing to print to, so the PDF row is the only way out. */
export function pdfIsTheOnlyOption(list: Printer[]): boolean {
  return list.length === 0;
}

/**
 * What to say when a printer was expected and "Save as PDF" was chosen instead.
 *
 * Returning `undefined` is the cancellation answer: backing out of a picker is
 * a legitimate outcome and must never be dressed up as a failure.
 */
export function resolveDestination(choice: string | undefined): Destination | undefined {
  if (!choice) {
    return undefined;
  }
  if (choice === PDF_ROW.label) {
    return { kind: 'pdf' };
  }
  return { kind: 'printer', printer: choice };
}
