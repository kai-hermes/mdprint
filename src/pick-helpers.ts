/**
 * pick-helpers.ts — one small seam so the dialog code can be driven by tests.
 *
 * Ask-the-user logic is where extensions usually become untestable: everything
 * is welded to `vscode.window.showQuickPick` and the only way to check it is to
 * click. This interface is the fix. In production `Phonebook` is backed by the
 * real QuickPick and the real backend; in tests it's backed by plain arrays, so
 * the printer-resolution order and the duplex rules get asserted instead of
 * eyeballed.
 */

import * as vscode from 'vscode';

import { Printer } from './platform/types';

export interface Phonebook {
  printers(): Promise<Printer[]>;
  choose(list: Printer[], suggested?: string): Promise<string | undefined>;
}

/**
 * The real one: lists queues through the backend and prompts with a QuickPick.
 * Anything typed into the box that isn't a known queue is accepted as-is, so a
 * printer added between the listing and the click still works.
 */
export function livePhonebook(backend: {
  listPrinters(): Promise<Printer[]>;
}): Phonebook {
  return {
    printers: () => backend.listPrinters(),
    choose: async (list, suggested) => {
      const items: (vscode.QuickPickItem & { name: string })[] = list.map((p) => ({
        name: p.name,
        label: p.name,
        description: [p.kind, p.capabilities.duplex ? 'two-sided' : '']
          .filter(Boolean)
          .join(' \u00b7 '),
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: 'mdprint',
        placeHolder: suggested ? `Printer (last used: ${suggested})` : 'Choose a printer',
        matchOnDescription: true,
      });
      return picked?.name;
    },
  };
}
