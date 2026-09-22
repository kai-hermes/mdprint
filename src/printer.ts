/**
 * printer.ts — choosing a printer, and never guessing one.
 *
 * Two rules, both learned the annoying way:
 *
 *  1. NEVER PRINT WITHOUT KNOWING WHERE. If the answer is ambiguous we ask. A
 *     document silently appearing on the wrong printer in the wrong room is
 *     worse than one more click.
 *
 *  2. Only offer what the queue actually advertises. If a printer doesn't claim
 *     duplex, the two-sided choices are not shown — capability claims come from
 *     `lpoptions -l`, never from a model name.
 */

import * as vscode from 'vscode';

import { Printer } from './platform/types';
import { configuredDefaultPrinter, setDefaultPrinter } from './settings';

/** Cache, because a printer list calls out to the OS and rarely changes. */
let cached: { at: number; printers: Printer[] } | undefined;
const CACHE_MS = 30_000;

export async function printers(
  backend: { listPrinters: () => Promise<Printer[]> },
  force = false
): Promise<Printer[]> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.printers;
  }
  const list = await backend.listPrinters();
  cached = { at: Date.now(), printers: list };
  return list;
}

export function invalidatePrinterCache(): void {
  cached = undefined;
}

function describe(p: Printer): string {
  const bits: string[] = [p.kind];
  if (p.capabilities.known) {
    if (p.capabilities.duplex) {
      bits.push('two-sided available');
    }
    const def = p.capabilities.paperSizes.find((s) => s.isDefault);
    if (def) {
      bits.push(def.label);
    }
  }
  return bits.join(' \u00b7 ');
}

/**
 * Which printer to use, asking only when we genuinely don't know.
 *
 * Order: an explicit choice already made this session -> a configured default ->
 * the OS default if there's exactly one plausible candidate -> ask.
 */
export async function pickPrinter(
  backend: { listPrinters: () => Promise<Printer[]>; defaultPrinter: () => Promise<string> },
  sessionChoice?: string
): Promise<string> {
  const list = await printers(backend);

  if (list.length === 0) {
    throw new Error(
      "This machine doesn't have any printers set up. Add one in your system print " +
        'settings, then try again.'
    );
  }

  if (sessionChoice && list.some((p) => p.name === sessionChoice || p.name.startsWith(sessionChoice + '-'))) {
    return sessionChoice;
  }

  const configured = configuredDefaultPrinter();
  if (configured) {
    const match = list.find((p) => p.name === configured || p.name.startsWith(configured + '-'));
    if (match) {
      return match.name;
    }
  }

  const osDefault = await backend.defaultPrinter();
  if (osDefault) {
    const match = list.find((p) => p.name === osDefault || p.name.startsWith(osDefault + '-'));
    if (match) {
      return match.name;
    }
  }

  // Genuinely ambiguous, or nothing set up as default: ask, don't guess.
  if (list.length === 1) {
    return list[0].name;
  }

  const chosen = await choosePrinter(backend, 'Which printer?');
  if (!chosen) {
    throw new Error('cancelled');
  }
  return chosen;
}

/**
 * The picker. Returns undefined if the user backs out — callers treat that as
 * "do nothing", not as an error, because backing out is a legitimate answer.
 */
export async function choosePrinter(
  backend: { listPrinters: () => Promise<Printer[]> },
  placeholder = 'Choose a printer'
): Promise<string | undefined> {
  const list = await printers(backend, true);

  if (list.length === 0) {
    void vscode.window.showWarningMessage(
      "This machine doesn't have any printers set up yet — add one in your system " +
        'print settings and try again.'
    );
    return undefined;
  }

  const items: (vscode.QuickPickItem & { name: string })[] = list.map((p) => ({
    name: p.name,
    label: p.name,
    description: describe(p),
    detail: p.capabilities.known
      ? p.capabilities.duplex
        ? 'Two-sided available'
        : 'Single-sided only (this printer says so)'
      : 'Capabilities unknown — mdprint will not offer options this queue cannot confirm',
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    title: 'mdprint',
    matchOnDescription: true,
  });

  return picked?.name;
}

/**
 * Remember the pick as this machine's default.
 *
 * Offered after a manual choice, never forced: someone who picks a printer for
 * one sheet in a hurry does not want that to silently become the permanent
 * answer for every document.
 */
export async function offerAsDefault(printer: string): Promise<void> {
  const makeIt = 'Use this from now on';
  const answer = await vscode.window.showInformationMessage(
    `Printing to ${printer}.`,
    makeIt
  );
  if (answer === makeIt) {
    await setDefaultPrinter(printer);
    invalidatePrinterCache();
    void vscode.window.showInformationMessage(`mdprint will use ${printer} by default.`);
  }
}
