/**
 * template-css.ts — the pure half of per-item template customisation.
 *
 * Deliberately free of `vscode`. Everything here is a string in, string out (or
 * a filesystem read), which is the only reason the template contract can be
 * tested at all: `vscode` is not a real module outside the editor, so any file
 * that imports it is unreachable from the test suite.
 *
 * That is not a test convenience, it is the same rule the renderer and the
 * stylesheet already follow — layout logic lives where it can be proven, and
 * the editor API stays in the thin shell that talks to it.
 *
 * PRECEDENCE, richest last (later wins):
 *
 *   1. the built-in print stylesheet      (css.ts — always there)
 *   2. `mdprint.themeFile`                (a workspace-wide house style)
 *   3. `<document>.mdprint.css`           (this item, on disk, shared with git)
 *   4. `mdprint.theme` in settings        (quick experiments)
 *   5. the live unsaved override          (supplied by the shell, see theme.ts)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PRINT_CSS } from './css';

export const THEME_SUFFIX = '.mdprint.css';

export interface ResolvedTemplate {
  /** Everything to inject, ordered so later rules win. */
  css: string;
  /** Built-in first, then each layer that applied — for the log line. */
  sources: string[];
  /** `@page size:` values a theme tried to set and had stripped. */
  refused: string[];
}

export interface TemplateInputs {
  filePath?: string;
  fileName: string;
  /** `mdprint.themeFile` — a workspace-wide stylesheet. */
  workspaceFile?: string;
  /** `mdprint.theme` — inline CSS from settings. */
  inline?: string;
  /** The live unsaved override, already looked up by the shell. */
  live?: string;
}

/** Where a template lives: beside the document, same stem, `.mdprint.css`. */
export function siblingTemplatePath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath).replace(/\.[^.]*$/, '');
  return path.join(dir, stem + THEME_SUFFIX);
}

/**
 * Strip `@page` blocks that set `size`, and say what was removed.
 *
 * A theme may restyle anything EXCEPT the paper. The size is the document's
 * decision — one template must not be able to pull Letter out of a tray of A4,
 * and the shim lays the document out against geometry read from the document's
 * own `@page` block. A shared template that quietly changed the sheet would be
 * discovered as wrong-sized paper, not as a bad file, so this refuses out loud.
 *
 * Margins in the same block ARE kept: those are a layout preference, the shim
 * honours them, and narrow margins for one item is a reasonable thing to want.
 */
export function stripPageSize(css: string): { css: string; refused: string[] } {
  const refused: string[] = [];

  const out = css.replace(/@page\s*\{[^}]*\}/g, (block) => {
    if (!/size\s*:/.test(block)) {
      return block;
    }
    const value = /size\s*:\s*([^;}]+)/.exec(block)?.[1]?.trim() ?? '?';
    refused.push(value);
    const kept = block.replace(/size\s*:[^;}]*;?/g, '').trim();
    return kept === '@page {}' ? '' : kept;
  });

  return { css: out, refused };
}

/**
 * Resolve the stylesheet for one document.
 *
 * An absent layer is skipped in silence — that is the overwhelmingly normal
 * case and deserves no noise. A layer that EXISTS but cannot be read is
 * reported through `warn`, because that is a real problem the user would
 * otherwise never see: their template would silently not apply.
 */
export async function resolveTemplate(
  inputs: TemplateInputs,
  warn: (line: string) => void
): Promise<ResolvedTemplate> {
  const parts: string[] = [PRINT_CSS];
  const sources: string[] = ['built-in'];
  const refused: string[] = [];

  const add = (label: string, css: string | undefined): void => {
    if (!css || !css.trim()) {
      return;
    }
    const clean = stripPageSize(css);
    refused.push(...clean.refused);
    if (!clean.css.trim()) {
      return;
    }
    parts.push(clean.css);
    sources.push(label);
  };

  // 2. workspace-wide house style
  if (inputs.workspaceFile) {
    try {
      add(`workspace file (${path.basename(inputs.workspaceFile)})`, await fs.readFile(inputs.workspaceFile, 'utf8'));
    } catch (e) {
      warn(
        `template: mdprint.themeFile points at ${inputs.workspaceFile} and it couldn't be ` +
          `read (${e instanceof Error ? e.message : String(e)}) — carrying on without it.`
      );
    }
  }

  // 3. this item's own template, sitting beside the markdown
  const sibling = siblingTemplatePath(inputs.filePath);
  if (sibling) {
    let exists = false;
    try {
      exists = (await fs.stat(sibling)).isFile();
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        add(`${path.basename(sibling)} (this item)`, await fs.readFile(sibling, 'utf8'));
      } catch (e) {
        warn(
          `template: found ${sibling} but couldn't read it ` +
            `(${e instanceof Error ? e.message : String(e)}) — printing with the default look.`
        );
      }
    }
  }

  // 4. settings, for quick experiments
  add('setting (mdprint.theme)', inputs.inline);

  // 5. the live, unsaved override for the item in front of you
  add('live (unsaved)', inputs.live);

  if (refused.length > 0) {
    warn(
      `template: ignored @page size (${refused.join(', ')}) — the paper size belongs to the ` +
        'document, not the template. Change it in the document instead.'
    );
  }

  return { css: parts.join('\n\n/* ---- next template layer ---- */\n\n'), sources, refused };
}
