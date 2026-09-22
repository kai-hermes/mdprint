/**
 * duplex-choice.ts — the editor-shell half of offering two-sided printing.
 *
 * All the *rules* live in `duplex-rules.ts`, which is pure and therefore
 * testable. This file is only the part that cannot be: showing a QuickPick and
 * reading the answer back. Keeping the split where it is means the interesting
 * logic is covered by `duplexPicker.test.ts` without needing a running editor.
 *
 * See `duplex-rules.ts` for the bug that made this file necessary — in short,
 * Duplex was always detectable and never *advertised*, because the label table
 * existed and nothing rendered it.
 */

import * as vscode from 'vscode';

import {
  canDuplex,
  DuplexChoice,
  duplexOptions,
  needsPrompt,
} from './duplex-rules';
import { Printer } from './platform/types';
import { SavedSettings } from './settings';

export type { DuplexChoice, DuplexOption } from './duplex-rules';

/**
 * Ask which sides to print on.
 *
 * Two different "no" answers, and the caller must tell them apart:
 *   - returns `undefined`          -> the user backed out; print nothing.
 *   - returns `{ value: undefined }` -> the user chose "leave it to the
 *     printer"; print, and emit no `sides=` flag.
 */
export async function chooseDuplex(
  printer: Printer,
  saved: SavedSettings
): Promise<{ value: DuplexChoice } | undefined> {
  // No real decision available: say so in one line and move on, rather than
  // making the user dismiss a dialog that only ever had one answer.
  if (!needsPrompt(printer, saved)) {
    void vscode.window.showInformationMessage(
      `${printer.name} advertises single-sided printing only.`
    );
    return { value: 'one-sided' };
  }

  const items = duplexOptions(printer, saved).map((o) => ({
    label: o.label,
    description: o.description,
    value: o.value,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: canDuplex(printer)
      ? 'Print on one side or two?'
      : 'This printer only does one side — clear the saved setting?',
    title: `mdprint — ${printer.name}`,
    matchOnDescription: true,
  });

  if (!picked) {
    return undefined;
  }
  return { value: picked.value };
}
