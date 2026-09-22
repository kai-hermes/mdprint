/**
 * extract-shim.mjs — pull the shipped Swift back out of the build.
 *
 * Why this exists, and why it is not just "cat shim.swift":
 *
 * The extension does NOT run src/platform/shim.swift. It runs the string
 * constant in src/platform/shim-source.ts, which is generated from the .swift by
 * `npm run embed-shim`. Those are two different artifacts, and the whole
 * "only page 1 printed" class of bug lives in the gap between them.
 *
 * This script closes that gap as a CHECK rather than a hope: it imports the
 * compiled constant — the exact text that would ship inside the .vsix — and
 * writes it out so it can be compiled and run for real on a Mac. If the embedded
 * copy is stale or mangled by escaping, this is where it shows up, and not in
 * a user's first print.
 *
 *   node scripts/extract-shim.mjs [outfile]
 *
 * Default outfile is /tmp/mdprint-shim-check.swift.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const out = process.argv[2] ?? '/tmp/mdprint-shim-check.swift';

// Resolve inside the repo so the import is relative to the build output and
// does not depend on the caller's working directory.
const modulePath = path.join(repo, 'out', 'platform', 'shim-source.js');

if (!fs.existsSync(modulePath)) {
  console.error(`${modulePath} is missing. Run \`npm run build\` first.`);
  process.exit(1);
}

const { PDF_SHIM_SOURCE, PDF_SHIM_FILENAME } = await import(modulePath);

fs.writeFileSync(out, PDF_SHIM_SOURCE, 'utf8');

// Sanity-check the escaped text survived the round trip through TypeScript.
const problems = [];
if (!PDF_SHIM_SOURCE.includes('import WebKit')) problems.push('lost "import WebKit"');
if (!PDF_SHIM_SOURCE.includes('import PDFKit')) problems.push('lost "import PDFKit"');
if (!PDF_SHIM_SOURCE.includes('measureBlocks')) problems.push('lost the pagination pass');
if (/\\\$\{/.test(PDF_SHIM_SOURCE)) problems.push('contains an unescaped template interpolation');
if (PDF_SHIM_SOURCE.includes('\\n') === false && PDF_SHIM_SOURCE.includes('\n') === false) {
  problems.push('has no newlines at all — the escaping probably collapsed the file');
}

if (problems.length > 0) {
  console.error('the embedded shim is mangled:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`extracted ${PDF_SHIM_SOURCE.length} chars -> ${out}`);
console.log(`shipped filename: ${PDF_SHIM_FILENAME}`);
console.log('now: swiftc -o /tmp/shimcheck "' + out + '" -framework WebKit -framework AppKit -framework PDFKit');
