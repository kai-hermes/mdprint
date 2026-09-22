/**
 * document.ts — "which markdown document did the user mean?"
 *
 * Two entry points have to agree on this: a right-click in the Explorer names a
 * file, and the Command Palette doesn't name anything at all. Both end up here.
 *
 * THE UNSAVED-BUFFER RULE: if the document is open in an editor, we render what
 * is ON SCREEN, not what is on disk. The whole point is that you shouldn't have
 * to save a file to print it, and printing a stale disk copy of something you're
 * halfway through editing is a worse bug than not printing at all.
 *
 * So the priority is: the active editor's text if it's markdown, else the file
 * on disk. The only time we read from disk is when no editor has it open.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { PrintError } from './platform/types';

export interface Doc {
  /** The text to render — from the buffer when it's open, from disk otherwise. */
  text: string;
  /** File name, for the title fallback and the page footer. */
  fileName: string;
  /** Absolute path, or undefined for an unsaved scratch buffer. */
  filePath?: string;
  /** True when we're rendering unsaved edits. */
  dirty: boolean;
  /** Uri to open as the failure target, when there is one. */
  uri?: vscode.Uri;
  /** Name for temp files — unique enough to avoid collisions. */
  label: string;
}

function isMarkdown(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' || /\.(md|markdown|mdown|mkd)$/i.test(doc.fileName);
}

function fromEditor(editor: vscode.TextEditor): Doc {
  const doc = editor.document;
  const name = path.basename(doc.fileName) || 'untitled.md';
  return {
    text: doc.getText(),
    fileName: name,
    filePath: doc.isUntitled ? undefined : doc.fileName,
    dirty: doc.isDirty,
    uri: doc.uri,
    label: doc.isUntitled ? 'untitled' : path.parse(name).name,
  };
}

/**
 * Work out which document to print.
 *
 * `uri` is whatever the right-click supplied (undefined from the palette).
 * Throws a PrintError with an actionable sentence when there's nothing to print.
 */
export async function resolveDoc(uri?: vscode.Uri): Promise<Doc> {
  // An Explorer right-click names a file. Prefer a live editor for that same
  // file so unsaved edits are honoured.
  if (uri) {
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString()
    );
    if (open) {
      return fromEditor({ document: open } as vscode.TextEditor);
    }

    let text: string;
    try {
      text = await fs.readFile(uri.fsPath, 'utf8');
    } catch (e) {
      throw new PrintError(
        `Couldn't read ${path.basename(uri.fsPath)} — ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const name = path.basename(uri.fsPath);
    return {
      text,
      fileName: name,
      filePath: uri.fsPath,
      dirty: false,
      uri,
      label: path.parse(name).name,
    };
  }

  // No uri: the Command Palette. Use the active editor if it's markdown.
  const editor = vscode.window.activeTextEditor;
  if (editor && isMarkdown(editor.document)) {
    return fromEditor(editor);
  }

  throw new PrintError(
    'Open a markdown file first, or right-click one in the Explorer — mdprint prints ' +
      'the document you are looking at, so it needs to know which one that is.'
  );
}
