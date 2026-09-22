/**
 * duplex-rules.ts — the pure half of offering two-sided printing.
 *
 * Split from `duplex-choice.ts` for the same reason `template-css.ts` was split
 * from `theme.ts`: the rules are worth testing, and `vscode` is not a real
 * module outside the editor, so anything importing it cannot be tested.
 *
 * THE BUG THIS FILE EXISTS FOR (reported 2026-09-22, verbatim):
 *
 *   "Double sided was also not advertised on any device despite it supporting
 *    it, so thats another one to fix."
 *
 * Two independent faults made that true:
 *
 *  1. `lpoptions -l` prints capability keys as `Duplex/Duplex: *None ...` —
 *     key, a slash, then a human label. The parser compared the whole key to
 *     `'Duplex'`, so it never matched and `capabilities.duplex` was false for
 *     every printer on earth. (Fixed in lp.ts; pinned by duplex.test.ts.)
 *
 *  2. `DUPLEX_LABELS` was exported and **called from nowhere**, and
 *     `rememberSettings` was never called either. So even with the parser
 *     fixed, no screen ever offered the choice, nothing was ever saved, and
 *     `jobFor` never produced a `duplex` value. (Pinned by this file plus
 *     duplexPicker.test.ts.)
 *
 * The lesson those two faults share, and the rule this file encodes:
 *
 *   DETECTING A CAPABILITY IS NOT ADVERTISING IT.
 *   A capability that is correctly detected but never OFFERED is, from the
 *   user's chair, indistinguishable from one that isn't there.
 *
 * It follows that the tests have to cover the path from parser to picker, not
 * just the parser. Everything below is therefore pure data-in/data-out.
 */

import { Printer } from './platform/types';
import type { Duplex } from './platform/types';
import { SavedSettings } from './settings';

/**
 * What the user gets when they'd rather not decide.
 *
 * Deliberately `undefined` and not a concrete value: "leave it alone" must stay
 * distinguishable from "explicitly one-sided". Only the former lets the
 * printer's own default apply, and `buildFlags` in lp.ts emits no flag for it.
 */
export type DuplexChoice = Duplex | undefined;

/**
 * One row of the offer, flattened to the two fields that carry meaning.
 *
 * Deliberately NOT a `vscode.QuickPickItem`: this type is what the tests assert
 * against, and it must stay constructible without an editor.
 */
export interface DuplexOption {
  label: string;
  description: string;
  value: DuplexChoice;
  /** True for the row that clears a saved value the queue can no longer honour. */
  isRecovery?: boolean;
}

/** Does this queue actually claim two-sided printing, and do we believe it? */
export function canDuplex(printer: Printer): boolean {
  return printer.capabilities.known && printer.capabilities.duplex;
}

/**
 * The rows offered for a printer.
 *
 * When the queue advertises duplex, the three real choices appear with a
 * "leave it to the printer" row last — the default stays reachable, but is not
 * where a hurried user lands by accident. When it does NOT advertise duplex we
 * never invent a two-sided row; if a duplex setting is nonetheless saved (the
 * printer was replaced, or it moved to another machine) we surface it as a
 * recovery row so the dead value is visible and clearable rather than silently
 * producing something the user didn't ask for.
 */
export function duplexOptions(printer: Printer, saved: SavedSettings): DuplexOption[] {
  if (!canDuplex(printer)) {
    const options: DuplexOption[] = [];

    // A saved two-sided value against a queue that can't do it: show it.
    if (saved.duplex && saved.duplex !== 'one-sided') {
      options.push({
        label: 'Clearing the saved two-sided setting',
        description: `${printer.name} doesn't advertise two-sided printing`,
        value: 'one-sided',
        isRecovery: true,
      });
    }

    options.push({
      label: 'One-sided',
      description: 'the only thing this printer advertises',
      value: 'one-sided',
    });
    options.push({
      label: 'Leave it to the printer',
      description: "use the printer's own default",
      value: undefined,
    });
    return options;
  }

  const options: DuplexOption[] = DUPLEX_ROWS.map((row) => ({
    label: row.label,
    description: row.description,
    value: row.value,
  }));

  options.push({
    label: 'Leave it to the printer',
    description: "use the printer's own default",
    value: undefined,
  });
  return options;
}

/**
 * Is there a genuine decision to make here?
 *
 * A single-sided queue with nothing saved has exactly one honest answer, and
 * prompting for it is a click tax that trains people to dismiss mdprint's
 * dialogs without reading them. The caller shows a statement instead.
 */
export function needsPrompt(printer: Printer, saved: SavedSettings): boolean {
  return canDuplex(printer) || Boolean(saved.duplex);
}

/**
 * The three real choices, in the order they're offered.
 *
 * These are the labels the user reads, and the values the rail receives. They
 * live together so the picker and the printed-settings toast can never drift
 * into describing the same value two different ways — which is exactly what
 * happened while `DUPLEX_LABELS` sat unused in settings.ts.
 */
export const DUPLEX_ROWS: { label: string; value: Duplex; description: string }[] = [
  {
    label: 'Two-sided (long edge)',
    value: 'two-sided-long-edge',
    description: 'Flip up the long side — the usual choice for portrait documents',
  },
  {
    label: 'Two-sided (short edge)',
    value: 'two-sided-short-edge',
    description: 'Flip up the short side — for landscape or calendar-style pages',
  },
  {
    label: 'One-sided',
    value: 'one-sided',
    description: 'Single-sided',
  },
];
