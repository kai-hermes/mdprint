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
import { chooseDestination } from './destination-choice';
import { Destination } from './destination-rules';
import { chooseDuplex } from './duplex-choice';
import { detect, tryDetect } from './platform/detect';
import { cleanup, handoffDir, htmlToPdf, release, sweepOldJobs, workDir } from './platform/pdf';
import { PrintError, Printer, PrintSource } from './platform/types';
import { Progress, silentProgress, Stage, withProgress } from './progress';
import { buildHtml } from './renderer';
import { announceSaved, savePdfAs } from './save-pdf';
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

      // THE FILE MUST OUTLIVE US. Handing over `rendered.pdfPath` and then
      // letting the `finally` below run is what produced
      //   "The file … couldn't be opened because there is no such file."
      // in the user's Preview. `open -g -a Preview` returns the moment the
      // handoff is made, so the scratch dir was deleted while Preview was
      // still opening the file — and a print job sent to the dialog was
      // deleted before the dialog had read it at all. Moving the PDF
      // somewhere that isn't swept is the fix; see release() for why it is a
      // copy and not an exemption flag.
      const handedOver = await release(rendered.pdfPath);
      log(`Released the PDF to ${handedOver} — it outlives this run by design.`);

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

    // ---- where does this go? printer, or the filesystem ------------------
    //
    // Asked BEFORE any printer is resolved, which is the whole reason the
    // "Save as PDF" row is reachable at all. Choosing the destination after
    // picking a printer would hide the row on exactly the machines that need
    // it: with one printer (or a remembered default) `pickPrinterOrSingle`
    // returns early and no list is ever shown, and with zero printers it
    // throws before a list could exist. See destination-rules.ts.
    progress.report('asking where to send it');
    const list = await backend.listPrinters();
    const suggested = lastPrinter || (await backend.defaultPrinter());

    const destination = await pickDestination(list, suggested);

    // Backing out is not a failure. Nothing was rendered, so nothing to clean.
    if (!destination) {
      log('Cancelled at the destination step — nothing was printed.');
      return;
    }

    if (destination.kind === 'pdf') {
      progress.report('asking where to save it');
      const outcome = await savePdfAs(rendered.pdfPath, rendered.name, rendered.dirty, log);
      if (outcome) {
        await announceSaved(outcome);
      }
      // cleanup() in the `finally` runs either way: unlike the dialog door, a
      // saved file is a COPY the user owns, so the scratch PDF is now garbage
      // and deleting it cannot pull the file out from under them.
      return;
    }

    // ---- the one-click door: straight to a queue ------------------------
    const printer = destination.printer;

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
 * Resolve the destination for the one-click path.
 *
 * THE RULE THAT CHANGED (this is the whole feature): the picker used to be
 * skipped whenever the answer was already known — one printer, or a remembered
 * default — and it *threw* when there were no printers at all. Both shortcuts
 * assumed the only possible answer was a printer.
 *
 * Now there are two kinds of answer, so "unambiguous" no longer exists and the
 * list is always shown. A machine with one printer still gets asked, because
 * "Save as PDF" has to be reachable there too — and a machine with NO printers
 * gets asked, because that is precisely where a PDF is the only way to get
 * anything out at all.
 *
 * The remembered default is not lost by this: it's passed as the placeholder's
 * subject, so the printer you use every day is still the top row in front of
 * you. Being asked is the price of the extra destination, and it is one
 * keystroke — Enter picks the first row, which is the remembered printer.
 */
async function pickDestination(
  list: Printer[],
  suggested: string
): Promise<Destination | undefined> {
  // `suggested` first, then the rest in OS order: the printer you printed to
  // last time is row one, so the muscle memory of "Enter, Enter" still works.
  const ordered = suggested
    ? [
        ...list.filter((p) => p.name === suggested),
        ...list.filter((p) => p.name !== suggested),
      ]
    : list;

  const placeholder =
    list.length === 0
      ? 'No printers set up \u2014 save as PDF instead'
      : suggested
        ? `Choose a destination (${suggested} last used)`
        : 'Choose a destination';

  return chooseDestination(ordered, placeholder);
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
      const picked = await chooseDestination(await backend.listPrinters(), 'Choose the default printer');
      // Picking "Save as PDF" here means the user has no printer they want to
      // default to. That is a real answer, and it is NOT a reason to write the
      // string "pdf" into `defaultPrinter` — leave the setting alone.
      if (!picked || picked.kind !== 'printer') {
        return;
      }
      await vscode.workspace
        .getConfiguration('mdprint')
        .update('defaultPrinter', picked.printer, vscode.ConfigurationTarget.Global);
      lastPrinter = picked.printer;
      void vscode.window.showInformationMessage(
        `mdprint will print to ${picked.printer} by default.`
      );
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
  //
  // The SAME `savePdfAs` the destination picker uses. Deliberately not a second
  // implementation: this command and the picker row are the same act reached two
  // ways, and two copies would drift — the inline version that used to live here
  // silently overwrote an existing file, which `savePdfAs` refuses to do.
  register('mdprint.savePdf', async (uri) => {
    let rendered: Awaited<ReturnType<typeof renderDoc>> | undefined;
    try {
      rendered = await renderDoc(uri);
      const outcome = await savePdfAs(rendered.pdfPath, rendered.name, rendered.dirty, log);
      if (outcome) {
        await announceSaved(outcome);
      }
    } catch (e) {
      reportFailure(e);
    } finally {
      if (rendered) {
        await cleanup(rendered.dir);
      }
    }
  });

  log(`mdprint ready. Scratch directory: ${workDir()}`);
  log(`Checked-out PDFs live in: ${handoffDir()}`);

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
