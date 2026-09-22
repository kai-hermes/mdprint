/**
 * theme.ts — the editor-facing shell for per-item template customisation.
 *
 * The rules themselves live in `template-css.ts`, which is `vscode`-free and
 * therefore testable. What is left here is the part that genuinely needs the
 * editor: the live, unsaved override buffer and the settings lookup.
 *
 * WHY A LIVE BUFFER AT ALL. A template is part of a document's identity, so the
 * durable form is a file beside the markdown — it survives a clone, a zip and a
 * different machine. But editing that file, saving, then printing to see the
 * result is a slow loop for something as fiddly as print layout. The live
 * override is the fast loop, keyed to the document you are looking at for the
 * same reason the renderer reads unsaved buffers: if you are mid-edit on the
 * template, you should see the edit, not the last saved copy.
 */

import * as vscode from 'vscode';

import { ResolvedTemplate, TemplateInputs, resolveTemplate, siblingTemplatePath, THEME_SUFFIX } from './template-css';

export { siblingTemplatePath, stripPageSize, THEME_SUFFIX } from './template-css';
export type { ResolvedTemplate } from './template-css';

/**
 * The live, unsaved template. One at a time — a template belongs to the item in
 * front of you, and keeping a map of them would leave stale buffers applying to
 * documents nobody is looking at.
 */
let live: { key: string; uri: vscode.Uri; text: string } | undefined;

/** Identify the item a live template belongs to: its path, or its buffer name. */
export function themeKeyFor(filePath: string | undefined, fileName: string): string {
  return filePath ?? `untitled:${fileName}`;
}

/** Is a live template open for this item? */
export function hasLiveTheme(key: string): boolean {
  return live?.key === key;
}

function liveThemeFor(key: string): string | undefined {
  return live && live.key === key ? live.text : undefined;
}

/**
 * Open (or focus) the live template for an item.
 *
 * Seeded from this item's own `.mdprint.css` when it has one, so "customise
 * this item" starts from what the item already looks like rather than from a
 * blank buffer. The blank case carries the contract in its header comment
 * instead of a wall of inherited rules the user did not write.
 */
export async function openLiveTheme(
  key: string,
  fileName: string,
  filePath: string | undefined,
  log: (line: string) => void
): Promise<void> {
  if (live?.key === key) {
    const already = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === live!.uri.toString()
    );
    if (already) {
      await vscode.window.showTextDocument(already.document);
      return;
    }
  }

  const seed =
    `/* mdprint template — ${fileName}\n` +
    ` *\n` +
    ` * Applied ON TOP of mdprint's built-in print stylesheet, so write only the\n` +
    ` * differences. This buffer is NOT saved with the document — it is a live\n` +
    ` * scratchpad. Print (or Print with dialog) uses it as it is, even unsaved.\n` +
    ` *\n` +
    ` * To keep it, save it next to the markdown file as:\n` +
    ` *     ${fileName.replace(/\.[^.]*$/, '')}${THEME_SUFFIX}\n` +
    ` * and it becomes this item's template everywhere, for good.\n` +
    ` *\n` +
    ` * Honoured: colours, fonts, sizes, spacing, page breaks, @page margin\n` +
    ` * Ignored: @page size — the paper belongs to the document, not the template\n` +
    ` */\n` +
    `\n` +
    `:root {\n` +
    `  /* --accent: #7a3ee0; */\n` +
    `}\n`;

  const source = await seedFor(filePath, seed);
  const doc = await vscode.workspace.openTextDocument({ content: source, language: 'css' });

  live = { key, uri: doc.uri, text: doc.getText() };
  await vscode.window.showTextDocument(doc);

  // Follow the buffer so a print uses what is on screen.
  const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
    if (live && e.document.uri.toString() === live.uri.toString()) {
      live.text = e.document.getText();
    }
  });
  const onClose = vscode.workspace.onDidCloseTextDocument((d) => {
    if (live && d.uri.toString() === live.uri.toString()) {
      live = undefined;
      onChange.dispose();
      onClose.dispose();
    }
  });

  log(`template: live override open for ${fileName}${source === seed ? ' (new)' : ' (seeded from this item)'}`);
}

async function seedFor(filePath: string | undefined, seed: string): Promise<string> {
  const sibling = siblingTemplatePath(filePath);
  if (!sibling) {
    return seed;
  }
  try {
    const text = await vscode.workspace.fs.readFile(vscode.Uri.file(sibling));
    return Buffer.from(text).toString('utf8');
  } catch {
    return seed;
  }
}

/**
 * The stylesheet for one document, with every layer in order.
 *
 * Reads the two settings itself rather than taking them as arguments, so no
 * caller can accidentally resolve a template against the wrong scope.
 */
export async function resolveTheme(
  filePath: string | undefined,
  fileName: string,
  log: (line: string) => void
): Promise<ResolvedTemplate> {
  const cfg = vscode.workspace.getConfiguration('mdprint');

  const inputs: TemplateInputs = {
    filePath,
    fileName,
    workspaceFile: cfg.get<string>('themeFile') || undefined,
    inline: cfg.get<string>('theme') || undefined,
    live: liveThemeFor(themeKeyFor(filePath, fileName)),
  };

  const resolved = await resolveTemplate(inputs, log);
  log(`template: ${resolved.sources.join(' + ')}`);
  return resolved;
}
