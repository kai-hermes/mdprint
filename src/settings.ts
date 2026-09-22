/**
 * settings.ts — remembered print settings, and why they're "per printer, global".
 *
 * The user's call, and it's right: a printer is a device attached to the
 * machine, not a property of a document or a folder. So a choice made at the
 * printer — duplex, copies — is remembered *for that printer*, across every
 * project and window on this machine.
 *
 * THE RULE: a saved setting is a DEFAULT, NEVER A LOCK.
 * Remembering "you print two-sided on the office laser" must never mean you
 * can't do one sheet single-sided without editing config by hand. Every path
 * that reads a saved setting offers a way to not use it:
 *
 *   - the one-click command uses the saved settings, and says so in the toast,
 *   - "Print with options…" always asks, starting from the saved values,
 *   - changing the answer there updates what's remembered.
 *
 * With nothing saved, mdprint passes NO flags at all and lets the printer do
 * whatever it's configured to do — which is the least surprising thing a print
 * button can possibly do.
 */

import * as vscode from 'vscode';

import { Duplex, PrintJob, PrintSource } from './platform/types';

export interface SavedSettings {
  duplex?: Duplex;
  copies?: number;
}

const SECTION = 'mdprint';

/** The whole per-printer map, read straight from workspace configuration. */
export function allSettings(): Record<string, SavedSettings> {
  const map = vscode.workspace
    .getConfiguration(SECTION)
    .get<Record<string, SavedSettings>>('printerSettings');
  return map ?? {};
}

/** What's remembered for one queue. Empty object when nothing is. */
export function settingsFor(printer: string): SavedSettings {
  if (!printer) {
    return {};
  }
  return allSettings()[printer] ?? {};
}

/**
 * Remember settings for a printer.
 *
 * Written with the `Global` target because the printer is a machine-level fact:
 * the same setting has to apply whether the user is in one window or another.
 */
export async function rememberSettings(
  printer: string,
  settings: SavedSettings
): Promise<void> {
  if (!printer) {
    return;
  }
  const map = { ...allSettings() };

  // Empty means "forget", so a printer with nothing chosen doesn't accumulate
  // an empty husk in settings that reads as configured but isn't.
  const cleaned: SavedSettings = {};
  if (settings.duplex !== undefined) {
    cleaned.duplex = settings.duplex;
  }
  if (settings.copies !== undefined) {
    cleaned.copies = settings.copies;
  }

  if (Object.keys(cleaned).length === 0) {
    delete map[printer];
  } else {
    map[printer] = cleaned;
  }

  await vscode.workspace
    .getConfiguration(SECTION)
    .update('printerSettings', map, vscode.ConfigurationTarget.Global);
}

/** The printer the extension should use when the document doesn't name one. */
export function configuredDefaultPrinter(): string {
  return vscode.workspace.getConfiguration(SECTION).get<string>('defaultPrinter') ?? '';
}

export async function setDefaultPrinter(printer: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('defaultPrinter', printer, vscode.ConfigurationTarget.Global);
}

/**
 * Build a PrintJob from a source plus remembered settings.
 *
 * Note what is NOT here: no default duplex, no default copies. Both stay
 * `undefined` unless the user actually chose a value, and `undefined` is what
 * makes the CUPS rail emit no flag. See lp.ts `buildFlags`.
 */
export function jobFor(source: PrintSource, printer: string): PrintJob {
  const saved = settingsFor(printer);
  const job: PrintJob = { source };
  if (saved.duplex !== undefined) {
    job.duplex = saved.duplex;
  }
  if (saved.copies !== undefined) {
    job.copies = saved.copies;
  }
  return job;
}

/** Duplex options for the picker, only offered when the queue says it can. */
export const DUPLEX_LABELS: { label: string; value: Duplex; description: string }[] = [
  {
    label: 'One-sided',
    value: 'one-sided',
    description: 'Single-sided',
  },
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
];

export function duplexLabel(value: Duplex | undefined): string {
  if (value === undefined) {
    return "the printer's own default";
  }
  return DUPLEX_LABELS.find((d) => d.value === value)?.label ?? value;
}
