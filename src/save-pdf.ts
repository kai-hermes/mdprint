/**
 * save-pdf.ts — "Save as PDF…", the destination that needs no printer.
 *
 * WHY THIS EXISTS
 *
 * The user's ask (2026-09-22): "As part of the list where you pick the printer,
 * we should also have an option to save as pdf."
 *
 * The PDF already exists by the time this is reachable — the whole pipeline
 * renders markdown to a PDF before it decides where that PDF goes. So this is
 * not a second renderer and not a second pipeline: it is the same PDF, sent to
 * the filesystem instead of a queue. One pipeline, two destinations.
 *
 * THE TRAP, AND WHY THE DEFAULT FILENAME ISN'T THE DOCUMENT NAME
 *
 * `showSaveDialog` returns a `file://` URI for the file the user *will* create.
 * Copying the scratch PDF over that path looks obviously correct and quietly
 * corrupts data: the user is being asked to pick a name for a file that does
 * not exist yet, so if they pick a path that DOES exist, `copyFile` overwrites
 * it with no warning. Picking an existing file in a save dialog is a normal
 * thing to do (re-saving over last week's export), so the polite thing is to
 * answer "yes, replace it" — which is what this does, explicitly, after asking.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

/** What became of a "Save as PDF" request. `undefined` means the user backed out. */
export interface SaveOutcome {
  /** Absolute path the PDF now lives at. */
  path: string;
  /** True when an existing file at that path was replaced. */
  replaced: boolean;
  /** True when the editor had unsaved changes, so the PDF is newer than disk. */
  dirty: boolean;
}

/**
 * Where the save dialog should offer to put the PDF.
 *
 * The user's Documents directory, falling back to home, then to a plain name
 * (which lets the OS choose). Deliberately never the directory the scratch PDF
 * came from: that folder is deleted when the run ends.
 */
function defaultDir(): string {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  try {
    if (fsSync.statSync(docs).isDirectory()) {
      return docs;
    }
  } catch {
    // No Documents folder (some Linux setups) — home is still a real place.
  }
  return home;
}

/**
 * The name to put in the save dialog, before the user edits it.
 *
 * Derived from the source document, so "notes.md" offers "notes.pdf" rather
 * than the scratch job name (which is a UUID and useless to a human). The
 * directory is left to the OS — `showSaveDialog` without a `defaultUri` opens
 * wherever the user last saved, which is what they expect.
 */
export function suggestedName(fileName: string): string {
  const base = fileName.replace(/\.(md|markdown|mdx|txt)$/i, '');
  return `${base || 'document'}.pdf`;
}

/**
 * Ask where to put the PDF, then put it there.
 *
 * Deliberately NOT `vscode.env.openExternal` or a "reveal in Finder" flourish
 * afterwards: the save dialog is over, the user knows where they put it, and a
 * second window stealing focus is the sort of thing this extension exists to
 * avoid. The confirmation is one line of text with a "Show in Finder" escape
 * hatch for when they don't.
 */
export async function savePdfAs(
  pdfPath: string,
  fileName: string,
  dirty: boolean,
  log: (line: string) => void
): Promise<SaveOutcome | undefined> {
  const target = await vscode.window.showSaveDialog({
    title: 'Save as PDF',
    saveLabel: 'Save PDF',
    filters: { PDF: ['pdf'] },
    // NOT path.dirname(pdfPath). The PDF lives in a mkdtemp SCRATCH directory
    // with a job-UUID name, and `runPrint`'s `finally` deletes that directory
    // the moment the run ends — which is right after this dialog is answered.
    // Offering a scratch path meant the save dialog could hand back a
    // destination inside a folder that was about to be deleted:
    //   "The file … couldn't be opened because there is no such file."
    // The user's own document folder is the honest default — it is where a
    // person looks for a PDF they just saved, and it is not swept.
    defaultUri: vscode.Uri.file(path.join(defaultDir(), suggestedName(fileName))),
  });

  // Backing out is a legitimate answer, not a failure. Same rule as every other
  // picker in the extension.
  if (!target) {
    return undefined;
  }

  const dest = target.fsPath;

  // A chosen path that already exists is a normal re-save, but replacing a file
  // silently is not — especially for a document, where the old copy may be the
  // only one. Ask once, plainly, and let the user back out.
  let replaced = false;
  try {
    await fs.access(dest);
    replaced = true;
  } catch {
    replaced = false;
  }

  if (replaced) {
    const replaceIt = 'Replace';
    const keepBoth = 'Choose another name';
    const answer = await vscode.window.showWarningMessage(
      `${path.basename(dest)} already exists. Replace it?`,
      { modal: true },
      replaceIt,
      keepBoth
    );

    if (answer === keepBoth) {
      return savePdfAs(pdfPath, fileName, dirty, log);
    }
    if (answer !== replaceIt) {
      return undefined;
    }
  }

  await fs.copyFile(pdfPath, dest);
  log(`Saved ${dest}${dirty ? ' (with unsaved edits)' : ''}`);

  return { path: dest, replaced, dirty };
}

/**
 * Say what happened, with the one follow-up a person actually wants.
 *
 * Fail-loud applies here too: if the copy throws, the caller's `reportFailure`
 * turns it into a sentence. This function never reports success it can't back.
 */
export async function announceSaved(outcome: SaveOutcome): Promise<void> {
  const name = path.basename(outcome.path);
  const bits = [`Saved ${name}`];
  if (outcome.replaced) {
    bits.push('replaced the existing file');
  }
  if (outcome.dirty) {
    bits.push('includes your unsaved edits');
  }

  const reveal = 'Show in folder';
  const answer = await vscode.window.showInformationMessage(bits.join(' \u00b7 '), reveal);
  if (answer === reveal) {
    // `revealFileInOS` exists in VS Code 1.85 / Cursor; `showItemInFolder` is
    // the older name kept for other forks. Falling back keeps one code path
    // working everywhere rather than branching on a version we can't see.
    const env = vscode.env as unknown as {
      revealFileInOS?: (uri: vscode.Uri) => Promise<void>;
    };
    if (typeof env.revealFileInOS === 'function') {
      await env.revealFileInOS(vscode.Uri.file(outcome.path));
    } else {
      await vscode.commands.executeCommand('revealFileInFolder', vscode.Uri.file(outcome.path));
    }
  }
}
