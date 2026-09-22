/**
 * runner.ts — the minimal harness the tests share.
 *
 * `node:test` and `node:assert` are built in, so the suite runs with plain
 * `node --test out/test/` on any machine that can build the extension. No test
 * framework to install, no config to keep in sync, nothing to break on a Node
 * upgrade.
 *
 * The one thing it must do that a bare assert can't: show a READABLE DIFF when
 * a golden fixture doesn't match. A renderer test that just says "false" costs
 * half an hour; one that shows the three lines that changed costs a minute.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const FIXTURE_DIR = path.resolve(__dirname, '../../test/fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

export function fixtureNames(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

/**
 * Line-by-line diff, trimmed to a readable window around the first difference.
 *
 * The whole point is that a person reads this output and immediately knows what
 * changed, so it prints the first few differing lines with context and then
 * stops rather than dumping two whole documents.
 */
export function diffLines(expected: string, actual: string, context = 3): string {
  const e = expected.split('\n');
  const a = actual.split('\n');

  let first = -1;
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    return '(no line differences)';
  }

  const start = Math.max(0, first - context);
  const end = Math.min(Math.max(e.length, a.length), first + context + 1);
  const out: string[] = [];

  out.push(`first difference at line ${first + 1}`);
  out.push('');
  for (let i = start; i < end; i++) {
    const marker = i === first ? '>>' : '  ';
    const left = e[i] === undefined ? '(absent)' : e[i];
    const right = a[i] === undefined ? '(absent)' : a[i];
    if (left === right) {
      out.push(`${marker} ${pad(i + 1)}  ${left}`);
    } else {
      out.push(`${marker} ${pad(i + 1)} -${left}`);
      out.push(`${marker} ${pad(i + 1)} +${right}`);
    }
  }
  out.push('');
  out.push(`expected ${e.length} lines, got ${a.length}`);
  return out.join('\n');
}

function pad(n: number): string {
  return String(n).padStart(4, ' ');
}

/** Collapse whitespace, for assertions that care about content not layout. */
export function squash(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

/** Write out what we actually produced, so a failure can be inspected by eye. */
export function writeActual(name: string, content: string): string {
  const dir = path.resolve(__dirname, '../../.actual');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Verify that every tag the renderer opened is also closed, in order.
 *
 * A renderer bug that produces unbalanced HTML shows up on paper as content
 * vanishing or a page running long, but it's invisible in a diff-heavy test.
 * This catches it directly, on all fixtures, for free.
 */
export function unbalancedTags(html: string): string[] {
  const VOID = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const problems: string[] = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosing = m[3] === '/';

    if (VOID.has(tag) || selfClosing) {
      continue;
    }
    if (!closing) {
      stack.push(tag);
    } else {
      const open = stack.pop();
      if (open !== tag) {
        problems.push(`</${tag}> closed <${open ?? 'nothing'}>`);
      }
    }
  }

  for (const leftover of stack) {
    problems.push(`<${leftover}> never closed`);
  }
  return problems;
}
