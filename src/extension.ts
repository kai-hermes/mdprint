/**
 * extension.ts — the commands, and the one pipeline behind them.
 *
 *     .md  ->  styled HTML  ->  PDF (offscreen WebKit)  ->  printer
 *
 * That is the whole program, and every command below is a different way of
 * entering it. There is exactly ONE pipeline: no command has a shortcut path
 * through it. What differs is only where the finished PDF is handed off —
 * straight to a queue, or into the OS's own print dialog.
 *
 * THE TWO DOORS (not a fallback chain — the user picks):
 *
 *   Print              -> lp with your remembered settings. No dialog.
 *   Print with dialog  -> the PDF lands in Preview with ⌘P waiting. The user
 *                         drives; mdprint has no opinion. This is where
 *                         stapling, trays, folding, N-up, page ranges live —
 *                         per-model options mdprint refuses to model.
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
import { chooseDuplex } from './duplex-choice';
import { detect, tryDetect } from './platform/detect';
import { cleanup, htmlToPdf, sweepOldJobs, workDir } from './platform/pdf';
import { PrintError, PrintSource } from './platform/types';
import { choosePrinter } from './printer';
import { Progress, silentProgress, Stage, withProgress } from './progress';
import { buildHtml } from './renderer';
import { jobFor, rememberSettings, settingsFor } from './settings';
import { openLiveTheme, resolveTheme, themeKeyFor } from './theme';

let output: vscode.OutputChannel;

/** Per-session printer memory: last one used, so repeat prints don't re-ask. */
let lastPrinter = '';

function log(line: string): void {
  output.appendLine(line);
}

/**
 * The render step, shared by every print path. Returns the PDF path and the
 * scratch directory the caller is responsible for cleaning up.
 *
 * `progress` is threaded through rather than created here so that the window
 * opens the instant the command fires -- see progress.ts for why that matters.
 */
async function renderDoc(
  uri: vscode.Uri | undefined,
  progress: Progress = silentProgress()
): Promise<{ pdfPath: string; dir: string; name: string; dirty: boolean; source: PrintSource }> {
  progress.report('collecting what you see in the editor');
  const doc = await resolveDoc(uri);

  log(
    `Rendering ${doc.fileName}${doc.dirty ? ' (unsaved changes)' : ''} on ${os.platform()}`
  );

  // Per-item template: built-in stylesheet, then any override stacked on top.
  progress.report('applying the template');
  const theme = await resolveTheme(doc.filePath, doc.fileName, log);

  const html = buildHtml(doc.text, doc.fileName, { css: theme.css });
  const pdfPath = await htmlToPdf(html, doc.label, log, (stage) =>
    progress.report(stage as Stage)
  );

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
 * `withDialog` is the ONLY difference between the two commands. It is passed
 * in rather than decided here so that neither path can sense the other and
 * "helpfully" fall over into it.
 *
 * THE DIALOG DOOR IS NOT A PICKER. This is the bug this function shipped with:
 * "print with options" used to run a QuickPick chain (printer / sides / copies)
 * and then print immediately — which is not a dialog, has no preview, and gave
 * the user no way to reach the options mdprint deliberately doesn't model.
 *
 * What the door actually has to do is hand the finished PDF to the OS and stop.
 * On macOS that is Preview, where ⌘P opens the real macOS print dialog with the
 * page in front of you, every driver-supplied option, and a preview pane. A
 * QuickPick cannot show a preview; the OS dialog exists precisely so we don't
 * have to build one.
 */
async function printCommand(uri: vscode.Uri | undefined, withDialog: boolean): Promise<void> {
  // The progress window is opened HERE, at the very top, before the first await.
  // Reported bug (2026-09-22): "while connecting and running the script, there's
  // no progress being displayed in there to suggest something is happening."
  // The user's ask was explicit about the window's lifetime too -- it should live
  // "until the dialog pops up or the print window asking you which printer to
  // use" -- so this wrapper spans the render, the printer choice and the handoff,
  // and closes only once the OS is holding the PDF.
  return withProgress(
    withDialog ? 'mdprint: preparing to print' : 'mdprint: printing',
    (progress) => runPrint(uri, withDialog, progress)
  );
}

/**
 * The body of a print. Split from `printCommand` so the progress wrapper stays a
 * single readable line and this reads as the pipeline it is.
 */
async function runPrint(
  uri: vscode.Uri | undefined,
  withDialog: boolean,
  progress: Progress
): Promise<void> {
  const backend = detect();

  let rendered: Awaited<ReturnType<typeof renderDoc>> | undefined;
  try {
    rendered = await renderDoc(uri, progress);

    // Checked between stages, never mid-stage: a half-rendered PDF is worth
    // nothing, so the earliest honest place to stop is here.
    if (progress.cancelled()) {
      log('Cancelled by the user \u2014 nothing was printed.');
      return;
    }

    // ---- the dialog door: render, hand off, get out of the way -----------
    if (withDialog) {
      progress.report('handing the PDF to the print dialog');
      const summary = await backend.printWithDialog(rendered.pdfPath);
      log(summary);

      void vscode.window.showInformationMessage(
        rendered.dirty
          ? `${summary} (with your unsaved edits)`
          : summary
      );
      // NOTE: no cleanup() here. The PDF is now owned by Preview — deleting the
      // scratch directory would pull the file out from under a dialog the user
      // hasn't finished with. sweepOldJobs() reaps it on a later activation.
      return;
    }

    // ---- the one-click door: straight to a queue ------------------------
    progress.report('asking the printer');
    const list = await backend.listPrinters();
    const suggested = lastPrinter || (await backend.defaultPrinter());

    const printer = await pickPrinterOrSingle(list, suggested);

    // ADVERTISING THE CAPABILITY (bug reported 2026-09-22: "Double sided was
    // also not advertised on any device despite it supporting it"). The parser
    // fix in lp.ts makes `capabilities.duplex` true for queues that really do
    // two-sided; this is the step that actually SHOWS it. Detecting a
    // capability is not advertising it — see duplex-choice.ts.
    progress.report('checking what this printer can do');
    const queued = list.find((p) => p.name === printer);

    let job = jobFor(rendered.source, printer);

    // Only worth asking when there's a real choice to make. A queue that
    // advertises single-sided only, with nothing saved, has one honest answer
    // and `chooseDuplex` says so without a prompt.
    if (queued) {
      const saved = settingsFor(printer);
      const answer = await chooseDuplex(queued, saved);

      if (answer === undefined) {
        log('Cancelled at the duplex step — nothing was printed.');
        return;
      }

      // Stamp the answer onto BOTH the job and the saved settings, so the
      // choice applies now and becomes the default next time. `undefined`
      // means "leave it to the printer", which must survive as absent.
      job = { ...job };
      if (answer.value === undefined) {
        delete job.duplex;
      } else {
        job.duplex = answer.value;
      }

      await rememberSettings(printer, { ...saved, duplex: answer.value });

      log(
        `Sides: ${answer.value ?? 'printer default'}` +
          (queued.capabilities.known
            ? queued.capabilities.duplex
              ? ' (two-sided advertised by this queue)'
              : ' (this queue advertises single-sided only)'
            : ' (capabilities unknown for this queue)')
      );
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

  register('mdprint.printWithDialog', (uri) => printCommand(uri, true));

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

  // "Customise the template for this item" — the per-item door.
  //
  // A template is part of a document's identity, so the durable form is a file
  // beside the markdown. This command is the fast loop: open a live stylesheet
  // that stacks on top of the built-in one, print to see it, save it beside the
  // document to keep it.
  register('mdprint.customise', async (uri) => {
    try {
      const doc = await resolveDoc(uri);
      const key = themeKeyFor(doc.filePath, doc.fileName);
      await openLiveTheme(key, doc.fileName, doc.filePath, log);
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
