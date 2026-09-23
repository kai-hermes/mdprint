/**
 * renderer.ts — markdown -> print-ready, self-contained HTML.
 *
 * A direct port of the POC's markdown renderer. The POC's *logic* survived real
 * paper, so this is a translation, not a redesign: same frontmatter handling,
 * same inline pass order, same block dispatch, same escape parking.
 *
 * It is deliberately NOT a markdown library. The goal is not markdown fidelity
 * (plenty of better renderers exist) — it is print layout. This renders the
 * subset that appears in real documents and hands the result to a stylesheet
 * that was paid for in paper.
 */

import { PRINT_CSS } from './css';
import { DEFAULT_SHELL, applyTokens } from './shell-template';

// ---------------------------------------------------------------- frontmatter

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

/**
 * Strip a leading `---` YAML block. Only flat `key: value` pairs are read —
 * that covers `title:`, which is all the renderer needs. Anything nested is
 * left in the body rather than guessed at.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const meta: Record<string, string> = {};
  let body = text;

  if (text.startsWith('---')) {
    const parts = text.split('---');
    // parts[0] is the empty string before the opening fence.
    if (parts.length >= 3) {
      const raw = parts[1];
      body = parts.slice(2).join('---').replace(/^\n/, '');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (line.includes(':') && !trimmed.startsWith('#')) {
          const idx = line.indexOf(':');
          const key = line.slice(0, idx).trim().toLowerCase();
          let value = line.slice(idx + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          if (key) {
            meta[key] = value;
          }
        }
      }
    }
  }

  return { meta, body };
}

// ---------------------------------------------------------------- inline pass

type InlineRule = [RegExp, string];

/**
 * Order matters, and it is inherited deliberately. Triple-emphasis has to be
 * matched before double, and double before single, or `***bold italic***`
 * renders as nested junk. Links come last because their text may itself
 * contain code.
 */
const INLINE: InlineRule[] = [
  [/`([^`]+)`/g, '<code>$1</code>'],
  [/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>'],
  [/\*\*(.+?)\*\*/g, '<strong>$1</strong>'],
  [/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>'],
  [/~~(.+?)~~/g, '<del>$1</del>'],
  [/==(.+?)==/g, '<mark>$1</mark>'],
  [/<(https?:\/\/[^>\s]+)>/g, '<a href="$1">$1</a>'],
  // Images before links: both use [text](url), and an image's leading `!`
  // would otherwise be left dangling in front of a rendered <a> link.
  [/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1">'],
  [/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>'],
];

/** Backslash-escaped characters, parked so the inline pass never sees them. */
const ESCAPED = /\x00(\d+)\x00/g;
const UNESCAPE: Record<string, string> = {
  '0': '&amp;',
  '1': '&lt;',
  '2': '&gt;',
  '3': '&quot;',
  '4': '&#x27;',
  '5': '*',
  '6': '_',
};
/** Characters a backslash protects. &<>"' are escaped for HTML; *_ are markdown. */
const ESCAPE_CHARS = ['&', '<', '>', '"', "'", '*', '_'];

function escapeHtml(text: string, quote: boolean): string {
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote) {
    out = out.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }
  return out;
}

/**
 * Escape, apply inline markdown, then restore backslash escapes.
 *
 * The parking trick is the POC's and it earns its keep: without it, `\*not
 * italic\*` gets eaten by the emphasis rule before anything can protect it.
 *
 * The parking uses a sentinel that the inline patterns cannot match, and the
 * restore happens AFTER escaping — so `\*` comes back as a literal asterisk in
 * the output and not as markdown. Two subtleties, both paid for by a failing
 * test: the underscore has to be parked too (`\_` otherwise survives the
 * emphasis rules but gets caught by any future one), and the sentinel must be
 * built from characters no inline rule touches.
 */
export function inline(text: string): string {
  for (let i = 0; i < ESCAPE_CHARS.length; i++) {
    text = text.split('\\' + ESCAPE_CHARS[i]).join(`\x00${i}\x00`);
  }

  text = escapeHtml(text, false);

  for (const [pattern, replacement] of INLINE) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }

  return text.replace(ESCAPED, (m, group: string) => UNESCAPE[group] ?? m);
}

// ---------------------------------------------------------------- table block

function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) {
    l = l.slice(1);
  }
  if (l.endsWith('|')) {
    l = l.slice(0, -1);
  }
  return l.split('|').map((c) => c.trim());
}

function renderTable(rows: string[]): string {
  const header = tableCells(rows[0]);
  // rows[1] is the `| --- |` separator and is intentionally skipped.
  const body = rows.slice(2).map(tableCells);

  const out = ['<table>', '<thead><tr>'];
  out.push(...header.map((c) => `<th>${inline(c)}</th>`));
  out.push('</tr></thead>', '<tbody>');
  for (const row of body) {
    // Ragged rows are padded so a short row can't shift the columns, and extra
    // cells are dropped for the same reason. A table whose rows disagree on
    // width lays out unpredictably on paper, which is the whole thing we're
    // trying to avoid.
    const padded = row.slice(0, header.length);
    while (padded.length < header.length) {
      padded.push('');
    }
    out.push('<tr>' + padded.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
  }
  out.push('</tbody>', '</table>');
  return out.join('\n');
}

// ---------------------------------------------------------------- block pass

const BLOCK_STARTER = /^\s*(#{1,6}\s|```|>|\||([-*+]|\d+\.)\s|([-*_])\s*(\3\s*){2,}$)/;
const FENCE_OPEN = /^\s*```(\w*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HRULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;

export function renderBlocks(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let i = 0;
  /**
   * Open list nesting. One entry per indent level, so a list inside a list
   * comes out as a list inside a list.
   *
   * Flattening them is tempting and wrong for a print tool: nested bullets are
   * how a document shows structure, and a flattened list reads as one long
   * run of peers on paper. The POC flattened; that is the one place this port
   * deliberately improves on it.
   */
  const listStack: { indent: number; tag: 'ul' | 'ol' }[] = [];

  const closeLists = (toIndent = -1): void => {
    while (listStack.length > 0 && listStack[listStack.length - 1].indent > toIndent) {
      const top = listStack.pop();
      out.push(`</li>`);
      out.push(`</${top!.tag}>`);
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    // ---- fenced code
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      closeLists();
      const lang = fence[1];
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      const cls = lang ? ` class="language-${lang}"` : '';
      out.push(`<pre><code${cls}>` + escapeHtml(buf.join('\n'), false) + '</code></pre>');
      i += 1;
      continue;
    }

    // ---- table
    if (stripped.startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      closeLists();
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }

    // ---- heading
    const heading = HEADING.exec(stripped);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // ---- horizontal rule
    if (HRULE.test(line)) {
      closeLists();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // ---- blockquote (consecutive > lines collapse into one quote)
    if (stripped.startsWith('>')) {
      closeLists();
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const inner = buf.filter((l) => l.trim()).map(inline).join('<br>');
      out.push(`<blockquote><p>${inner}</p></blockquote>`);
      continue;
    }

    // ---- list item
    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1].replace(/\t/g, '    ').length;
      const marker = item[2];
      const content = item[3];
      const want: 'ul' | 'ol' = /^\d/.test(marker[0]) ? 'ol' : 'ul';

      // Deeper: open a new level inside the previous <li>.
      if (listStack.length > 0 && indent > listStack[listStack.length - 1].indent) {
        out.push(`<${want}>`);
        listStack.push({ indent, tag: want });
      }
      // Same level, different marker type: close and reopen at this level.
      else if (
        listStack.length > 0 &&
        indent === listStack[listStack.length - 1].indent &&
        listStack[listStack.length - 1].tag !== want
      ) {
        const top = listStack.pop()!;
        out.push('</li>');
        out.push(`</${top.tag}>`);
        out.push(`<${want}>`);
        listStack.push({ indent, tag: want });
      }
      // Shallower, or the first item: unwind to the right level.
      else {
        closeLists(indent);
        if (listStack.length === 0 || indent > listStack[listStack.length - 1].indent) {
          out.push(`<${want}>`);
          listStack.push({ indent, tag: want });
        } else {
          // Same level: close the previous sibling and continue in this list.
          out.push('</li>');
        }
      }

      const task = TASK_ITEM.exec(content);
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        out.push(`<li class="${done ? 'task done' : 'task'}">${inline(task[2])}`);
      } else {
        out.push(`<li>${inline(content)}`);
      }
      i += 1;
      continue;
    }

    // ---- blank
    if (!stripped) {
      closeLists();
      i += 1;
      continue;
    }

    // ---- paragraph (absorb continuation lines)
    closeLists();
    const buf = [stripped];
    i += 1;
    while (i < lines.length && lines[i].trim() && !BLOCK_STARTER.test(lines[i])) {
      buf.push(lines[i].trim());
      i += 1;
    }
    out.push('<p>' + inline(buf.join(' ')) + '</p>');
  }

  closeLists();
  return out.join('\n');
}

// ---------------------------------------------------------------- table of contents

export interface Heading {
  level: number;
  text: string;
  slug: string;
}

function slugify(text: string, used: Set<string>): string {
  const plain = text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

  let slug = plain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = 'section';
  }

  if (!used.has(slug)) {
    used.add(slug);
    return slug;
  }
  let n = 2;
  while (used.has(`${slug}-${n}`)) {
    n += 1;
  }
  const unique = `${slug}-${n}`;
  used.add(unique);
  return unique;
}

/**
 * Add `id`s to h1-h3 headings and return them in document order, for a
 * table-of-contents shell to link to.
 *
 * Only ever called when a shell actually contains `{{mdprint:toc}}` (see
 * `buildHtml`) — the default render path never touches heading markup, which
 * is what keeps every golden fixture byte-identical when no shell is in play.
 * h4-h6 are left alone: that depth reads as noise on a printed contents page.
 */
export function addHeadingIds(html: string): { html: string; headings: Heading[] } {
  const used = new Set<string>();
  const headings: Heading[] = [];

  const out = html.replace(/<h([1-3])>(.*?)<\/h\1>/g, (_m, lvl: string, inner: string) => {
    const level = Number(lvl);
    const slug = slugify(inner, used);
    headings.push({ level, text: inner, slug });
    return `<h${level} id="${slug}">${inner}</h${level}>`;
  });

  return { html: out, headings };
}

/**
 * A nested `<ul class="mdprint-toc">` from a flat, document-ordered heading
 * list. `stack` holds one entry per currently open `<ul>`, valued at the
 * heading level that list holds items for — deeper levels are pushed/popped
 * as headings get nested or return to a shallower level, exactly like
 * `renderBlocks`'s list-indent stack.
 */
export function renderToc(headings: Heading[]): string {
  if (headings.length === 0) {
    return '';
  }

  const out: string[] = [];
  const stack: number[] = [];

  for (const h of headings) {
    if (stack.length === 0) {
      out.push('<ul class="mdprint-toc">');
      stack.push(h.level);
    } else if (h.level > stack[stack.length - 1]) {
      out.push('<ul>');
      stack.push(h.level);
    } else {
      while (stack.length > 1 && stack[stack.length - 1] > h.level) {
        out.push('</li>', '</ul>');
        stack.pop();
      }
      out.push('</li>');
    }
    out.push(`<li><a href="#${h.slug}">${h.text}</a>`);
  }

  while (stack.length > 0) {
    out.push('</li>', '</ul>');
    stack.pop();
  }

  return out.join('\n');
}

// ---------------------------------------------------------------- assemble

/** `my-notes_v2.md` -> `my notes v2` — the title fallback when there's no frontmatter. */
export function titleFromFilename(srcName: string): string {
  const base = srcName.replace(/\.[^.]*$/, '');
  return base.replace(/-/g, ' ').replace(/_/g, ' ');
}

function formatDate(d: Date): string {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const day = String(d.getDate()).padStart(2, '0');
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export interface RenderOptions {
  /** Injected so the golden fixtures can pin the date. */
  now?: Date;
  /** Override the stylesheet. Tests use this to prove it is actually wired in. */
  css?: string;
  /**
   * Override the structural shell — a pre-resolved, pre-validated shell body
   * from `shell-template.ts`'s `resolveShell()`. Not re-validated here, same
   * trust boundary as `css` above. Defaults to `DEFAULT_SHELL`, which is
   * built so that substituting its tokens reproduces this function's own
   * historical output byte-for-byte — see the note above the assembly below.
   */
  shell?: string;
}

export function buildHtml(mdText: string, srcName: string, options: RenderOptions = {}): string {
  const css = options.css ?? PRINT_CSS;
  const when = formatDate(options.now ?? new Date());

  const { meta, body } = splitFrontmatter(mdText);
  const title = meta['title'] || titleFromFilename(srcName);

  // Lead paragraph carries the .preamble styling — everything before the first
  // heading reads as a standfirst rather than body text.
  let content = renderBlocks(body);
  content = content.replace(/^<p>/, '<p class="preamble">');

  /**
   * Don't print the title twice.
   *
   * The document already starts with its own `<h1>` when the author wrote one
   * (`# Template Proof`), and the page title is also emitted below from the
   * frontmatter. Both firing put the same heading on the paper twice — visible
   * on a real sheet, invisible in every test that only checked the title was
   * *present*.
   *
   * So: only synthesise an `<h1>` when the document didn't open with a
   * top-level heading of its own. A `##` or a paragraph first still gets the
   * generated title, because there is nothing to duplicate.
   */
  const opensWithH1 = /^\s*<h1[ >]/.test(content);
  const titleHeading = opensWithH1 ? '' : `<h1>${escapeHtml(title, true)}</h1>\n`;

  // .pf-page is left empty here — only the Swift shim, at capture time, knows
  // which page number a given sheet is and how many there are in total (see
  // shim.swift's positionFooterJs). On screen (the live template-customise
  // preview) it just renders as a harmless empty span. positionFooterJs finds
  // this by class name alone (`.page-footer`, then `.pf-page` inside it), so a
  // shell is free to reposition this block anywhere in the document.
  const footer =
    '<div class="page-footer">' +
    `<span>${escapeHtml(title, true)}</span>` +
    '<span class="pf-page"></span>' +
    `<span class="pf-right">${escapeHtml(srcName, true)} &middot; ${escapeHtml(when, true)}</span>` +
    '</div>';

  // The structural shell. `wantsToc` gates the ONLY place `content` can differ
  // from what this function has always produced: heading ids/TOC generation
  // never runs unless a shell explicitly asks for `{{mdprint:toc}}`.
  const shellTemplate = options.shell ?? DEFAULT_SHELL;
  const wantsToc = shellTemplate.includes('{{mdprint:toc}}');
  let toc = '';
  if (wantsToc) {
    const withIds = addHeadingIds(content);
    content = withIds.html;
    toc = renderToc(withIds.headings);
  }

  // Byte-identical to this function's historical output when `options.shell`
  // is unset: DEFAULT_SHELL only references {{mdprint:header}}, {{content}}
  // and {{footer}}, so substituting it reproduces exactly
  // `<main>\n${titleHeading}${content}\n</main>\n${footer}` — the same
  // segment this function always emitted, splicing into the unchanged outer
  // skeleton below.
  const { html: bodyHtml } = applyTokens(shellTemplate, {
    title: escapeHtml(title, true),
    filename: escapeHtml(srcName, true),
    date: escapeHtml(when, true),
    header: titleHeading,
    content,
    footer,
    toc,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title, true)}</title>
<style>
${css}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
