/**
 * destination-choice.ts — the editor half of "where does this PDF go?".
 *
 * Everything decided here is decided in `destination-rules.ts`, which is pure
 * and therefore testable. This file only draws the QuickPick and shells out.
 */

import * as vscode from 'vscode';

import {
  Destination,
  PDF_ROW,
  PrinterRow,
  destinationRows,
  pdfIsTheOnlyOption,
  resolveDestination,
} from './destination-rules';
import { Printer } from './platform/types';

/**
 * Ask where the PDF should go: a printer, or the filesystem.
 *
 * `list === []` is NOT an error here, and that is a deliberate change. The old
 * picker warned "you don't have any printers set up" and gave up — but the user
 * has just been offered "Save as PDF" in exactly that situation, so refusing to
 * open the list would make the row unreachable on the machines that need it
 * most. No printers means "Save as PDF" is the only working answer, and the
 * picker says so in its placeholder instead of blocking.
 */
export async function chooseDestination(
  list: Printer[],
  placeholder = 'Choose a printer, or save as PDF'
): Promise<Destination | undefined> {
  const rows: (vscode.QuickPickItem & { row: PrinterRow | 'pdf' })[] = [
    ...destinationRows(list).map((r) => ({
      row: r as PrinterRow | 'pdf',
      label: r.label,
      description: r.description,
      detail: r.detail,
    })),
    {
      row: 'pdf',
      label: PDF_ROW.label,
      description: PDF_ROW.description,
      detail: PDF_ROW.detail,
    },
  ];

  const picked = await vscode.window.showQuickPick(rows, {
    placeHolder: pdfIsTheOnlyOption(list)
      ? 'No printers set up \u2014 save as PDF instead'
      : placeholder,
    title: 'mdprint',
    matchOnDescription: true,
    // The list is short and the rows are the point, so no live filtering: it
    // would let a stray keystroke hide the printer you were aiming at.
    matchOnDetail: true,
  });

  if (!picked) {
    return undefined;
  }
  if (picked.row === 'pdf') {
    return { kind: 'pdf' };
  }
  return resolveDestination(picked.label);
}
