/**
 * extension.ts — the commands, and the one pipeline behind them.
 *
 *     .md  ->  styled HTML  ->  PDF (offscreen WebKit)  ->  lp  ->  printer
 *
 * That is the whole program, and every command below is a different way of
 * entering it. There is exactly ONE pipeline: "Print" doesn't have a shortcut
 * path and "Print with options" doesn't have a separate one, they just fill in
 * the same PrintJob differently. Nothing here falls back to anything.
 *
 * The user experience this is built for: you are mid-edit on a document, you
 * decide you want it on paper, you right-click and press a thing. Nothing is
 * saved, nothing opens, no file picker, no browser. A second later a sheet
 * comes out. Every design choice in here exists to keep that true.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveDoc } from './document';
import { askOptions } from './options';
import { livePhonebook } from './pick-helpers';
import { detect, tryDetect } from './platform/detect';
import { cleanup, htmlToPdf, sweepOldJobs, workDir } from './platform/pdf';
import { PrintError, PrintSource } from './platform/types';
import { choosePrinter } from './printer';
import { buildHtml } from './renderer';
import { jobFor, settingsFor } from './settings';

let output: vscode.OutputChannel;

/** Per-session printer memory: last one used, so repeat prints don't re-ask. */
let lastPrinter = '';

function log(line: string): void {
  output.appendLine(line);
}

/**
 * The render step, shared by every print path. Returns the PDF path and the
 * scratch directory the caller is responsible for cleaning up.
 */
async function renderDoc(
  uri: vscode.Uri | undefined
): Promise<{ pdfPath: string; dir: string; name: string; dirty: boolean; source: PrintSource }> {
  const doc = await resolveDoc(uri);

  log(
    `Rendering ${doc.fileName}${doc.dirty ? ' (unsaved changes)' : ''} on ${os.platform()}`
  );

  const html = buildHtml(doc.text, doc.fileName);
  const pdfPath = await htmlToPdf(html, doc.label, log);

  return {
    pdfPath,
    dir: path.dirname(pdfPath),
    name: doc.fileName,
    dirty: doc.dirty,
    source: { kind: 'pdf', path: pdfPath },
  };
}

/**
 * Print, with or without a dialog in front of it.
 *
 * `withOptions` is the ONLY difference between the two commands. It is passed
 * in rather than decided here so that neither path can sense the other and
 * "helpfully" fall over into it.
 */
async function printCommand(uri: vscode.Uri | undefined, withOptions: boolean): Promise<void> {
  const backend = detect();
  const pick = livePhonebook(backend);

  let rendered: Awaited<ReturnType<typeof renderDoc>> | undefined;
  try {
    rendered = await renderDoc(uri);

    const list = await backend.listPrinters();
    const suggested = lastPrinter || (await backend.defaultPrinter());

    let printer: string;
    let job;

    if (withOptions) {
      const answer = await askOptions(pick, rendered.source, suggested || undefined);
      if (!answer) {
        return; // Backed out — a legitimate answer, not a failure.
      }
      printer = answer.printer;
      job = answer.job;
    } else {
      printer = await pickPrinterOrSingle(list, suggested);
      job = jobFor(rendered.source, printer);
    }

    log(
      `Printing to ${printer}` +
        (job.duplex ? ` (${job.duplex})` : ' (printer default sides)') +
        (job.copies && job.copies !== 1 ? ` x${job.copies}` : '')
    );

    const summary = await backend.print(rendered.pdfPath, printer, job);
    lastPrinter = printer;

    const remembered = settingsFor(printer);
    const bits = [summary];
    if (remembered.duplex || remembered.copies) {
      bits.push('using your saved settings for this printer');
    }
    if (rendered.dirty) {
      bits.push('printed your unsaved edits');
    }

    void vscode.window.showInformationMessage(bits.join(' \u00b7 '), 'Show output').then((a) => {
      if (a === 'Show output') {
        output.show();
      }
    });
  } catch (e) {
    reportFailure(e);
  } finally {
    if (rendered) {
      await cleanup(rendered.dir);
    }
  }
}

/**
 * Resolve the printer for the one-click path.
 *
 * Split out so the "ask, don't guess" order lives in printer.ts while the
 * list-vs-single shortcut stays visible here.
 */
async function pickPrinterOrSingle(
  list: { name: string; capabilities: { duplex: boolean } }[],
  suggested: string
): Promise<string> {
  if (list.length === 0) {
    throw new PrintError(
      "This machine doesn't have any printers set up. Add one in your system print " +
        'settings, then try again.'
    );
  }

  if (suggested) {
    const match = list.find((p) => p.name === suggested || p.name.startsWith(suggested + '-'));
    if (match) {
      return match.name;
    }
  }

  if (list.length === 1) {
    return list[0].name;
  }

  const backend = detect();
  const chosen = await choosePrinter(backend, 'Which printer?');
  if (!chosen) {
    throw new PrintError('No printer chosen, so nothing was printed.');
  }
  return chosen;
}

/**
 * Every failure ends up here, and every message is written to be actionable.
 *
 * The fail-loud rule from SPEC §10: never a silent stall. "This printer wants a
 * username and password — add it in your system print settings" is a message;
 * "print failed" is not.
 */
function reportFailure(e: unknown): void {
  const message =
    e instanceof PrintError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);

  // Backing out of a picker isn't a failure and shouldn't be dressed as one.
  if (message === 'cancelled' || message.toLowerCase().includes('no printer chosen')) {
    return;
  }

  log(`ERROR: ${message}`);
  void vscode.window.showErrorMessage(`mdprint: ${message}`, 'Show output').then((a) => {
    if (a === 'Show output') {
      output.show();
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('mdprint');
  context.subscriptions.push(output);

  // Tidy up scratch files from earlier sessions, but never block activation on it.
  void sweepOldJobs().catch(() => undefined);

  const register = (id: string, handler: (uri?: vscode.Uri) => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('mdprint.print', (uri) => printCommand(uri, false));

  register('mdprint.printWithOptions', (uri) => printCommand(uri, true));

  register('mdprint.choosePrinter', async () => {
    try {
      const backend = detect();
      const picked = await choosePrinter(backend, 'Choose the default printer');
      if (!picked) {
        return;
      }
      await vscode.workspace
        .getConfiguration('mdprint')
        .update('defaultPrinter', picked, vscode.ConfigurationTarget.Global);
      lastPrinter = picked;
      void vscode.window.showInformationMessage(`mdprint will print to ${picked} by default.`);
    } catch (e) {
      reportFailure(e);
    }
  });

  // "Save as PDF" — the honest answer on a machine that can't print yet, and
  // genuinely useful on one that can.
  register('mdprint.savePdf', async (uri) => {
    let rendered: Awaited<ReturnType<typeof renderDoc>> | undefined;
    try {
      rendered = await renderDoc(uri);

      const target = await vscode.window.showSaveDialog({
        title: 'Save as PDF',
        defaultUri: vscode.Uri.file(
          path.join(
            path.dirname(rendered.pdfPath),
            rendered.name.replace(/\.[^.]*$/, '') + '.pdf'
          )
        ),
        filters: { PDF: ['pdf'] },
      });

      if (!target) {
        return;
      }

      const fs = await import('node:fs/promises');
      await fs.copyFile(rendered.pdfPath, target.fsPath);
      void vscode.window
        .showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open')
        .then((a) => {
          if (a === 'Open') {
            void vscode.env.openExternal(target);
          }
        });
    } catch (e) {
      reportFailure(e);
    } finally {
      if (rendered) {
        await cleanup(rendered.dir);
      }
    }
  });

  log(`mdprint ready. Scratch directory: ${workDir()}`);

  const backend = tryDetect();
  if (!backend) {
    log(
      `No print backend for ${os.platform()} yet — "Save as PDF" works, printing doesn't.`
    );
  }
}

export function deactivate(): void {
  // Nothing to tear down: every child process is spawned with a timeout and no
  // watchers or servers are held open.
}
