/**
 * shell-template.ts — the pure half of structural-shell customisation.
 *
 * `template-css.ts` lets a consumer restyle everything mdprint renders, but it
 * cannot change the DOM: no cover page, no table of contents, no moving the
 * header/footer into different markup. This is that other axis — a shell is
 * the arrangement of a handful of named regions (`{{mdprint:content}}`,
 * `{{mdprint:footer}}`, …), not a stylesheet.
 *
 * Deliberately free of `vscode`, for the same reason `template-css.ts` is: it
 * is what makes this half of the contract provable without a real editor. See
 * `shell.ts` for the thin, `vscode`-touching shell around this.
 *
 * PRECEDENCE IS REPLACE, NOT STACK. `template-css.ts`'s CSS layers concatenate
 * because the cascade already knows how to let a later rule win over an
 * earlier one. A shell is a whole competing arrangement of markup —
 * concatenating two of them has no sensible meaning, so the narrowest one
 * PRESENT AND VALID wins outright, and every wider layer is simply unused:
 *
 *   live buffer  >  mdprint.shell  >  <document>.mdprint.shell.html  >  mdprint.shellFile  >  built-in
 *   narrowest ────────────────────────────────────────────────────────────────────▶  widest
 *
 * A present-but-invalid layer (missing `{{mdprint:content}}`) does not stop
 * there: it's refused, logged, and resolution falls through to the next-widest
 * layer — the same fail-safe instinct as `template-css.ts`'s `stripPageSize`,
 * adapted to "discard the whole candidate" instead of "strip one clause",
 * because there is no sensible partial version of a shell missing its content
 * region.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const SHELL_SUFFIX = '.mdprint.shell.html';

/** Every token a shell may use, and what it resolves to at render time. */
export type ShellToken = 'title' | 'filename' | 'date' | 'header' | 'content' | 'footer' | 'toc';

/**
 * The built-in shell. Chosen so that substituting its tokens reproduces
 * mdprint's historical `buildHtml()` output byte-for-byte: it references only
 * `header`, `content` and `footer` — never `toc` — so the default render path
 * never generates heading ids or a table of contents, and no existing golden
 * fixture moves.
 */
export const DEFAULT_SHELL = `<main>
{{mdprint:header}}{{mdprint:content}}
</main>
{{mdprint:footer}}`;

export interface ShellInputs {
  filePath?: string;
  fileName: string;
  /** `mdprint.shellFile` — a workspace-wide shell. */
  workspaceFile?: string;
  /** `mdprint.shell` — inline HTML from settings. */
  inline?: string;
  /** The live unsaved override, already looked up by the shell. */
  live?: string;
}

export interface ResolvedShell {
  /** The winning shell body — never a raw, unvalidated candidate. */
  html: string;
  /** Which layer won, for the log line — `'built-in'` if nothing else validated. */
  source: string;
  /** Labels of candidates that were present but refused for lacking `{{mdprint:content}}`. */
  refused: string[];
}

/** Where a shell lives: beside the document, same stem, `.mdprint.shell.html`. */
export function siblingShellPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath).replace(/\.[^.]*$/, '');
  return path.join(dir, stem + SHELL_SUFFIX);
}

/** A shell must keep somewhere to put the rendered markdown, or it is refused. */
export function validateShell(html: string): boolean {
  return html.includes('{{mdprint:content}}');
}

/**
 * Substitute every `{{mdprint:x}}` token present in `tokens` — one pass, no
 * recursion: a token's VALUE is never re-scanned for further tokens, so a
 * document whose title happens to contain the literal text
 * `{{mdprint:content}}` cannot smuggle in a second substitution.
 *
 * A token in the shell with no entry in `tokens` (a typo, or a name from a
 * future version) is left verbatim — the loudest possible failure, visible on
 * the rendered page itself, rather than silently vanishing — and reported in
 * `unknown` for a caller that wants to log it.
 */
export function applyTokens(
  shell: string,
  tokens: Partial<Record<ShellToken, string>>
): { html: string; unknown: string[] } {
  const unknown = new Set<string>();

  const html = shell.replace(/\{\{mdprint:([a-zA-Z0-9_-]+)\}\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(tokens, name)) {
      return tokens[name as ShellToken] ?? '';
    }
    unknown.add(match);
    return match;
  });

  return { html, unknown: [...unknown] };
}

/**
 * Resolve the shell for one document: the first candidate, narrowest first,
 * that is both present and valid. An absent layer is skipped in silence, same
 * as `template-css.ts` — that is the normal case. A present-but-invalid one is
 * reported through `warn` and skipped in favour of the next-widest layer,
 * because that is a real problem the author would otherwise never see: their
 * shell would silently not apply.
 */
export async function resolveShell(
  inputs: ShellInputs,
  warn: (line: string) => void
): Promise<ResolvedShell> {
  const refused: string[] = [];

  const consider = (label: string, html: string | undefined): ResolvedShell | undefined => {
    if (!html || !html.trim()) {
      return undefined;
    }
    if (!validateShell(html)) {
      refused.push(label);
      return undefined;
    }
    return { html, source: label, refused };
  };

  // 1. the live, unsaved override for the item in front of you
  const live = consider('live (unsaved)', inputs.live);
  if (live) {
    return finish(live, warn);
  }

  // 2. settings, for quick experiments
  const inline = consider('setting (mdprint.shell)', inputs.inline);
  if (inline) {
    return finish(inline, warn);
  }

  // 3. this item's own shell, sitting beside the markdown
  const sibling = siblingShellPath(inputs.filePath);
  if (sibling) {
    let exists = false;
    try {
      exists = (await fs.stat(sibling)).isFile();
    } catch {
      exists = false;
    }
    if (exists) {
      let text: string | undefined;
      try {
        text = await fs.readFile(sibling, 'utf8');
      } catch (e) {
        warn(
          `shell: found ${sibling} but couldn't read it ` +
            `(${e instanceof Error ? e.message : String(e)}) — using the built-in structure.`
        );
      }
      if (text !== undefined) {
        const item = consider(`${path.basename(sibling)} (this item)`, text);
        if (item) {
          return finish(item, warn);
        }
      }
    }
  }

  // 4. workspace-wide house shell
  if (inputs.workspaceFile) {
    let text: string | undefined;
    try {
      text = await fs.readFile(inputs.workspaceFile, 'utf8');
    } catch (e) {
      warn(
        `shell: mdprint.shellFile points at ${inputs.workspaceFile} and it couldn't be ` +
          `read (${e instanceof Error ? e.message : String(e)}) — carrying on without it.`
      );
      text = undefined;
    }
    if (text !== undefined) {
      const workspace = consider(`workspace file (${path.basename(inputs.workspaceFile)})`, text);
      if (workspace) {
        return finish(workspace, warn);
      }
    }
  }

  return finish({ html: DEFAULT_SHELL, source: 'built-in', refused }, warn);
}

function finish(resolved: ResolvedShell, warn: (line: string) => void): ResolvedShell {
  if (resolved.refused.length > 0) {
    warn(
      `shell: ignored ${resolved.refused.join(', ')} — a shell must contain {{mdprint:content}} or ` +
        `mdprint has nowhere to put the document. Falling through to ${resolved.source}.`
    );
  }
  return resolved;
}
