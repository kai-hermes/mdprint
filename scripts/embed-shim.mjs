/**
 * embed-shim.mjs — regenerate src/platform/shim-source.ts from shim.swift.
 *
 * Two copies of the Swift exist and that is deliberate:
 *
 *   src/platform/shim.swift       — the editable original. This is the file you
 *                                   open, read and change; it gets syntax
 *                                   highlighting and can be compiled by hand.
 *   src/platform/shim-source.ts   — the same text as a TypeScript string, which
 *                                   is what actually ships inside the extension.
 *
 * There is no build step that could do this automatically without adding a
 * bundler, and a bundler is not worth it for one file. So instead there is one
 * script and a test (src/test/shim.test.ts) that fails the moment the two
 * drift. Run this after every edit to the Swift:
 *
 *     npm run embed-shim
 *
 * Escaping: backticks, backslashes and `${` all have to be neutralised because
 * the Swift becomes a template literal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const swiftPath = path.join(repo, 'src', 'platform', 'shim.swift');
const outPath = path.join(repo, 'src', 'platform', 'shim-source.ts');

const swift = fs.readFileSync(swiftPath, 'utf8').trimEnd();

const escaped = swift
  .split('\n')
  .map((line) => line.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'))
  .join('\\n');

const header = `/**
 * shim-source.ts — GENERATED FILE. Do not edit.
 *
 * Source of truth: src/platform/shim.swift
 * Regenerate with: npm run embed-shim
 *
 * src/test/shim.test.ts fails if this file and the Swift drift apart, so the
 * failure mode is a red test rather than a silently stale converter.
 */

`;

const body =
  `export const PDF_SHIM_FILENAME = 'mdprint-pdf.swift';\n\n` +
  `export const PDF_SHIM_SOURCE: string = \`\n${escaped}\n\`;\n`;

fs.writeFileSync(outPath, header + body, 'utf8');
console.log(`embedded ${swift.split('\n').length} lines of Swift into src/platform/shim-source.ts`);
