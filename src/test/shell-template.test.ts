/**
 * shell-template.test.ts — the structural-shell contract.
 *
 * Mirrors theme.test.ts's shape, for the axis CSS can't cover: DOM structure,
 * not appearance. Three things are worth pinning, and all three were chosen
 * because the failure mode is silent:
 *
 *  1. REPLACE, NOT STACK. Unlike CSS layers, only the narrowest present and
 *     valid shell applies — concatenating two competing documents makes no
 *     sense, so this is the opposite contract from template-css.ts and
 *     deserves its own proof.
 *  2. THE CONTENT GUARD. A shell missing {{mdprint:content}} has nowhere to
 *     put the document — refused, not silently broken, and resolution must
 *     fall through to the next-widest layer rather than giving up.
 *  3. UNKNOWN TOKENS SURVIVE. A typo'd token must stay visible in the output,
 *     not vanish — vanishing is the one failure mode nobody would notice.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_SHELL,
  applyTokens,
  resolveShell,
  siblingShellPath,
  validateShell,
} from '../shell-template';

const quiet = (): void => undefined;

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mdprint-shell-'));
}

test('siblingShellPath sits beside the document and replaces the extension', () => {
  assert.equal(siblingShellPath('/tmp/docs/report.md'), '/tmp/docs/report.mdprint.shell.html');
  assert.equal(siblingShellPath('/tmp/docs/a.b.md'), '/tmp/docs/a.b.mdprint.shell.html');
  assert.equal(siblingShellPath(undefined), undefined);
});

test('validateShell requires the content region', () => {
  assert.equal(validateShell('<main>{{mdprint:content}}</main>'), true);
  assert.equal(validateShell('<main>no content here</main>'), false);
});

test('an item with no shell anywhere resolves to the built-in one', async () => {
  const r = await resolveShell({ fileName: 'plain.md' }, quiet);
  assert.equal(r.html, DEFAULT_SHELL);
  assert.equal(r.source, 'built-in');
  assert.deepEqual(r.refused, []);
});

test('precedence is REPLACE, not stack — only the narrowest present layer applies', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  const house = path.join(dir, 'house.shell.html');
  await fs.writeFile(doc, '# hi\n');
  await fs.writeFile(path.join(dir, 'report.mdprint.shell.html'), '<div class="item">{{mdprint:content}}</div>');
  await fs.writeFile(house, '<div class="house">{{mdprint:content}}</div>');

  const r = await resolveShell(
    {
      filePath: doc,
      fileName: 'report.md',
      workspaceFile: house,
      inline: '<div class="setting">{{mdprint:content}}</div>',
    },
    quiet
  );

  assert.equal(r.source, 'setting (mdprint.shell)');
  assert.ok(r.html.includes('setting'), 'the innermost present layer must win');
  assert.ok(!r.html.includes('item'), 'a wider layer must not also appear — this is replace, not stack');
  assert.ok(!r.html.includes('house'), 'a wider layer must not also appear — this is replace, not stack');
});

test('the live buffer outranks everything, including the setting', async () => {
  const r = await resolveShell(
    {
      fileName: 'x.md',
      inline: '<div class="setting">{{mdprint:content}}</div>',
      live: '<div class="live">{{mdprint:content}}</div>',
    },
    quiet
  );

  assert.equal(r.source, 'live (unsaved)');
  assert.ok(r.html.includes('live'));
});

test('a sibling shell wins over a workspace-wide one', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  const house = path.join(dir, 'house.shell.html');
  await fs.writeFile(doc, '# hi\n');
  await fs.writeFile(path.join(dir, 'report.mdprint.shell.html'), '<div class="item">{{mdprint:content}}</div>');
  await fs.writeFile(house, '<div class="house">{{mdprint:content}}</div>');

  const r = await resolveShell({ filePath: doc, fileName: 'report.md', workspaceFile: house }, quiet);

  assert.equal(r.source, 'report.mdprint.shell.html (this item)');
  assert.ok(r.html.includes('item'));
});

test('a missing shell file is skipped silently — it is the normal case', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  await fs.writeFile(doc, '# hi\n');

  const warnings: string[] = [];
  const r = await resolveShell({ filePath: doc, fileName: 'report.md' }, (l) => warnings.push(l));

  assert.equal(r.source, 'built-in');
  assert.deepEqual(warnings, []);
});

test('an unreadable workspace shellFile is reported, not swallowed', async () => {
  const warnings: string[] = [];
  const r = await resolveShell(
    { fileName: 'x.md', workspaceFile: '/nope/definitely/not/here.shell.html' },
    (l) => warnings.push(l)
  );

  assert.equal(r.source, 'built-in');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /couldn't be read/);
});

test('a shell missing {{mdprint:content}} is refused and falls through to the next layer', async () => {
  const warnings: string[] = [];
  const r = await resolveShell(
    {
      fileName: 'x.md',
      inline: '<div>no content region here</div>',
      workspaceFile: undefined,
    },
    (l) => warnings.push(l)
  );

  assert.equal(r.source, 'built-in', 'an invalid narrow layer must fall through, not block the built-in');
  assert.deepEqual(r.refused, ['setting (mdprint.shell)']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /must contain \{\{mdprint:content\}\}/);
});

test('an invalid narrow layer falls through to a VALID wider one, not straight to built-in', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  const house = path.join(dir, 'house.shell.html');
  await fs.writeFile(doc, '# hi\n');
  await fs.writeFile(house, '<div class="house">{{mdprint:content}}</div>');

  const r = await resolveShell(
    {
      filePath: doc,
      fileName: 'report.md',
      workspaceFile: house,
      inline: '<div>broken, no content token</div>',
    },
    quiet
  );

  assert.equal(r.source, 'workspace file (house.shell.html)');
  assert.deepEqual(r.refused, ['setting (mdprint.shell)']);
});

test('applyTokens substitutes only the tokens it is given, in one pass', () => {
  const { html, unknown } = applyTokens('<h1>{{mdprint:title}}</h1>{{mdprint:content}}', {
    title: 'Report',
    content: '{{mdprint:content}}', // a value containing the literal token text
  });

  assert.equal(html, '<h1>Report</h1>{{mdprint:content}}', 'the substituted value must not be re-scanned');
  assert.deepEqual(unknown, []);
});

test('an unknown token is left verbatim in the output, and reported', () => {
  const { html, unknown } = applyTokens('{{mdprint:content}}{{mdprint:oops}}', { content: 'BODY' });

  assert.equal(html, 'BODY{{mdprint:oops}}', 'an unmatched token must stay visible, not vanish');
  assert.deepEqual(unknown, ['{{mdprint:oops}}']);
});

test('the README documents the same shell precedence order the resolver walks', async () => {
  const dir = await tmpdir();
  const doc = path.join(dir, 'report.md');
  const house = path.join(dir, 'house.shell.html');
  await fs.writeFile(doc, '# hi\n');
  await fs.writeFile(path.join(dir, 'report.mdprint.shell.html'), '<div class="item">{{mdprint:content}}</div>');
  await fs.writeFile(house, '<div class="house">{{mdprint:content}}</div>');

  const base = { filePath: doc, fileName: 'report.md' };

  // Each assertion proves one adjacent pair from the README's diagram: the
  // narrower layer wins whenever it and the next-widest one are both present.
  const live = await resolveShell(
    { ...base, inline: '<div>{{mdprint:content}}</div>', live: '<div class="live">{{mdprint:content}}</div>' },
    quiet
  );
  assert.equal(live.source, 'live (unsaved)', 'live must beat the setting');

  const setting = await resolveShell(
    { ...base, workspaceFile: house, inline: '<div class="setting">{{mdprint:content}}</div>' },
    quiet
  );
  assert.equal(setting.source, 'setting (mdprint.shell)', 'the setting must beat the item file');

  const item = await resolveShell({ ...base, workspaceFile: house }, quiet);
  assert.equal(item.source, 'report.mdprint.shell.html (this item)', 'the item file must beat the workspace file');

  const workspace = await resolveShell({ fileName: 'x.md', workspaceFile: house }, quiet);
  assert.equal(workspace.source, 'workspace file (house.shell.html)', 'the workspace file must beat built-in');

  const readme = await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  const match = readme.match(/```\n(built-in[^\n]*mdprint\.shellFile[^\n]*)\n/);
  assert.ok(match, 'README must carry a shell precedence line naming mdprint.shellFile');
  assert.deepEqual(
    match[1].split('→').map((s) => s.trim()).filter(Boolean),
    ['built-in', 'mdprint.shellFile', '<doc>.mdprint.shell.html', 'mdprint.shell', 'live buffer'],
    'README precedence disagrees with the resolver — the docs are lying to consumers'
  );
});
