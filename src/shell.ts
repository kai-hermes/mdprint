/**
 * shell.ts — the editor-facing shell for structural-shell customisation.
 *
 * Mirrors `theme.ts` exactly, one level over: the rules live in
 * `shell-template.ts` (`vscode`-free, testable); this is only the part that
 * genuinely needs the editor — the live, unsaved override buffer and the
 * settings lookup.
 *
 * A SEPARATE singleton from `theme.ts`'s `live`. A document can have both a
 * live CSS buffer (restyling) and a live shell buffer (restructuring) open at
 * once — they answer different questions and neither should evict the other.
 */

import * as vscode from 'vscode';

import {
  ResolvedShell,
  ShellInputs,
  SHELL_SUFFIX,
  DEFAULT_SHELL,
  resolveShell,
  siblingShellPath,
} from './shell-template';
import { themeKeyFor } from './theme';

export { SHELL_SUFFIX, DEFAULT_SHELL, siblingShellPath } from './shell-template';
export type { ResolvedShell } from './shell-template';

/**
 * The live, unsaved shell. One at a time, same reasoning as `theme.ts`'s
 * `live`: it belongs to the item in front of you.
 */
let liveShell: { key: string; uri: vscode.Uri; text: string } | undefined;

/** Is a live shell open for this item? */
export function hasLiveShell(key: string): boolean {
  return liveShell?.key === key;
}

function liveShellFor(key: string): string | undefined {
  return liveShell && liveShell.key === key ? liveShell.text : undefined;
}

/**
 * Open (or focus) the live shell for an item.
 *
 * Seeded from this item's own `.mdprint.shell.html` when it has one, else
 * `DEFAULT_SHELL` (commented) — restructuring starts from what the page
 * already looks like, not a blank buffer.
 */
export async function openLiveShell(
  key: string,
  fileName: string,
  filePath: string | undefined,
  log: (line: string) => void
): Promise<void> {
  if (liveShell?.key === key) {
    const already = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === liveShell!.uri.toString()
    );
    if (already) {
      await vscode.window.showTextDocument(already.document);
      return;
    }
  }

  const seed =
    `<!-- mdprint structural shell — ${fileName}\n` +
    `\n` +
    `     Named regions, substituted at print time. Keep {{mdprint:content}} or\n` +
    `     this shell is refused and mdprint falls back to the one below it.\n` +
    `     This buffer is NOT saved with the document — it is a live scratchpad.\n` +
    `     Print (or Print with dialog) uses it as it is, even unsaved.\n` +
    `\n` +
    `     To keep it, save it next to the markdown file as:\n` +
    `         ${fileName.replace(/\.[^.]*$/, '')}${SHELL_SUFFIX}\n` +
    `     and it becomes this item's structure everywhere, for good.\n` +
    `\n` +
    `     Tokens: {{mdprint:title}} {{mdprint:filename}} {{mdprint:date}}\n` +
    `             {{mdprint:header}} {{mdprint:content}} {{mdprint:footer}}\n` +
    `             {{mdprint:toc}} — a generated h1-h3 table of contents,\n` +
    `             only built when this token is actually present.\n` +
    `-->\n` +
    `${DEFAULT_SHELL}\n`;

  const source = await seedFor(filePath, seed);
  const doc = await vscode.workspace.openTextDocument({ content: source, language: 'html' });

  liveShell = { key, uri: doc.uri, text: doc.getText() };
  await vscode.window.showTextDocument(doc);

  const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
    if (liveShell && e.document.uri.toString() === liveShell.uri.toString()) {
      liveShell.text = e.document.getText();
    }
  });
  const onClose = vscode.workspace.onDidCloseTextDocument((d) => {
    if (liveShell && d.uri.toString() === liveShell.uri.toString()) {
      liveShell = undefined;
      onChange.dispose();
      onClose.dispose();
    }
  });

  log(`shell: live override open for ${fileName}${source === seed ? ' (new)' : ' (seeded from this item)'}`);
}

async function seedFor(filePath: string | undefined, seed: string): Promise<string> {
  const sibling = siblingShellPath(filePath);
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
 * The shell for one document, narrowest layer that validates.
 *
 * Reads the two settings itself rather than taking them as arguments, so no
 * caller can accidentally resolve a shell against the wrong scope — same rule
 * `resolveTheme` follows.
 */
export async function resolveShellForDoc(
  filePath: string | undefined,
  fileName: string,
  log: (line: string) => void
): Promise<ResolvedShell> {
  const cfg = vscode.workspace.getConfiguration('mdprint');

  const inputs: ShellInputs = {
    filePath,
    fileName,
    workspaceFile: cfg.get<string>('shellFile') || undefined,
    inline: cfg.get<string>('shell') || undefined,
    live: liveShellFor(themeKeyFor(filePath, fileName)),
  };

  const resolved = await resolveShell(inputs, log);
  log(`shell: ${resolved.source}`);
  return resolved;
}
