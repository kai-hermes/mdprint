/**
 * options.ts — the deliberate second door.
 *
 * "Print" does the simple thing with your remembered settings. This command
 * ASKS: which printer, how many copies, one- or two-sided — then remembers the
 * answers. It is a door the user walks through on purpose.
 *
 * What it is not: a fallback the one-click path can drop into. If "Print"
 * fails, it says so; it does not quietly reopen itself as a dialog. (See the
 * house rules in SPEC §10 — one pipeline, no fallback.)
 *
 * And what it deliberately still does not offer: stapling, trays, media type,
 * folding. Those are per-model names from the printer's own PPD, and building
 * an options UI for them is how this project would stop being small. Past this
 * list, the answer is the OS dialog, which has that UI already and can talk to
 * the driver properly.
 */

import * as vscode from 'vscode';

import { Phonebook } from './pick-helpers';
import { Printer, PrintJob, PrintSource } from './platform/types';
import { DUPLEX_LABELS, SavedSettings, jobFor, rememberSettings, settingsFor } from './settings';

export interface OptionsResult {
  printer: string;
  job: PrintJob;
}

/**
 * Walk the user through printer, duplex, copies. Returns undefined if they back
 * out at any step.
 */
export async function askOptions(
  pick: Phonebook,
  source: PrintSource,
  suggestedPrinter?: string
): Promise<OptionsResult | undefined> {
  const list = await pick.printers();

  if (list.length === 0) {
    void vscode.window.showWarningMessage(
      "This machine doesn't have any printers set up yet. Add one in your system " +
        'print settings, then try again.'
    );
    return undefined;
  }

  const printerName = await pick.choose(list, suggestedPrinter);
  if (!printerName) {
    return undefined;
  }

  const printer = list.find((p) => p.name === printerName) ?? list[0];
  const saved = settingsFor(printer.name);

  const duplex = await askDuplex(printer, saved);
  if (duplex === null) {
    return undefined;
  }

  const copies = await askCopies(saved);
  if (copies === null) {
    return undefined;
  }

  const settings: SavedSettings = {};
  if (duplex !== undefined) {
    settings.duplex = duplex;
  }
  if (copies !== undefined) {
    settings.copies = copies;
  }
  await rememberSettings(printer.name, settings);

  const job = jobFor(source, printer.name);
  if (duplex !== undefined) {
    job.duplex = duplex;
  }
  if (copies !== undefined) {
    job.copies = copies;
  }

  return { printer: printer.name, job };
}

/**
 * Ask about duplex.
 *
 * Returns `undefined` for "leave the printer alone" (a legitimate, and the
 * default, answer), `null` for "user cancelled", or a Duplex value.
 *
 * The "leave alone" choice is listed FIRST and labelled with what it means. If
 * the queue doesn't advertise duplex at all, the two-sided entries are simply
 * not shown — offering a two-sided option on a single-sided printer produces a
 * rejected job, and a rejected job is a wasted trip.
 */
async function askDuplex(
  printer: Printer,
  saved: SavedSettings
): Promise<import('./platform/types').Duplex | undefined | null> {
  const supportsDuplex = printer.capabilities.duplex;

  const items: (vscode.QuickPickItem & { value: import('./platform/types').Duplex | undefined })[] = [
    {
      label: 'As the printer is set up',
      description: "don't change it",
      detail: 'Prints single- or two-sided exactly as this printer is configured',
      value: undefined,
    },
  ];

  if (supportsDuplex) {
    for (const d of DUPLEX_LABELS) {
      items.push({
        label: d.label,
        description: d.value === saved.duplex ? 'remembered for this printer' : '',
        detail: d.description,
        value: d.value,
      });
    }
  } else if (printer.capabilities.known) {
    items.push({
      label: 'Two-sided',
      description: 'unavailable',
      detail: "This printer doesn't advertise two-sided printing",
      value: undefined,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'mdprint \u00b7 how many sides?',
    placeHolder: `Printing to ${printer.name}`,
  });

  if (!picked) {
    return null;
  }
  return picked.value;
}

/** Ask about copies. undefined = default (one), null = cancelled. */
async function askCopies(saved: SavedSettings): Promise<number | undefined | null> {
  const items: (vscode.QuickPickItem & { value: number | undefined })[] = [
    {
      label: 'One copy',
      description: !saved.copies || saved.copies === 1 ? 'default' : '',
      value: undefined,
    },
  ];
  for (const n of [2, 3, 4, 5, 10]) {
    items.push({
      label: `${n} copies`,
      description: saved.copies === n ? 'remembered for this printer' : '',
      value: n,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'mdprint \u00b7 how many copies?',
    placeHolder: 'Remembered for this printer',
  });

  if (!picked) {
    return null;
  }
  return picked.value;
}
