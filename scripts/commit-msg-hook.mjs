#!/usr/bin/env node
// commit-msg-hook.mjs — enforce the conventional-commit subject line.
//
// This feeds release-please: it reads `feat`/`fix`/`feat!` (and friends) out of
// commit history to decide the next version and the changelog. A subject that
// doesn't match is invisible to it — the commit still lands, but silently
// doesn't count, which is a worse failure than being told at commit time.
//
// Two ways to invoke it:
//   node scripts/commit-msg-hook.mjs <path-to-commit-msg-file>   (a real git hook)
//   node scripts/commit-msg-hook.mjs --check-range [<rev-range>] (CI: check a PR's commits)

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const SUBJECT_RE = new RegExp(`^(${TYPES.join('|')})(\\([\\w./-]+\\))?!?: .+`);

// Commits git itself generates, or that a human is never expected to type by
// hand — these are exempt rather than forced into the convention.
const EXEMPT_RE = /^(Merge |Revert "|fixup!|squash!|Initial commit)/;

export function isValidSubject(subject) {
  return EXEMPT_RE.test(subject) || SUBJECT_RE.test(subject);
}

function firstLine(text) {
  return text.split('\n').find((l) => l.trim().length > 0) ?? '';
}

function fail(subject) {
  process.stderr.write(
    `\nmdprint: commit subject doesn't match the conventional-commit format:\n\n` +
      `    ${subject}\n\n` +
      `Expected: <type>(<scope>)!: <subject>, where <type> is one of\n` +
      `    ${TYPES.join(', ')}\n\n` +
      `Example:  fix(printer): honour a printer's advertised duplex modes\n` +
      `Breaking: feat!: drop the mdprint.legacyTheme setting\n\n` +
      `This feeds automatic versioning and the changelog (release-please) — a\n` +
      `subject outside the convention is silently invisible to it.\n\n`
  );
}

async function checkFile(msgPath) {
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(msgPath, 'utf8');
  const subject = firstLine(text);
  if (!isValidSubject(subject)) {
    fail(subject);
    process.exit(1);
  }
}

async function checkRange(range) {
  const { execFileSync } = await import('node:child_process');
  const rev = range || process.argv[3] || 'origin/main..HEAD';
  let out;
  try {
    out = execFileSync('git', ['log', '--format=%s', rev], { encoding: 'utf8' });
  } catch (e) {
    process.stderr.write(`mdprint: couldn't read commit range "${rev}": ${e.message}\n`);
    process.exit(1);
    return;
  }
  const subjects = out.split('\n').filter((l) => l.trim().length > 0);
  const bad = subjects.filter((s) => !isValidSubject(s));
  if (bad.length > 0) {
    process.stderr.write(`mdprint: ${bad.length} commit subject(s) don't match the convention:\n\n`);
    for (const s of bad) {
      process.stderr.write(`    ${s}\n`);
    }
    fail(bad[0]);
    process.exit(1);
  }
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--check-range') {
    await checkRange(process.argv[3]);
    return;
  }
  if (!arg) {
    process.stderr.write('usage: commit-msg-hook.mjs <commit-msg-file> | --check-range [<range>]\n');
    process.exit(1);
    return;
  }
  await checkFile(arg);
}

// Only run when invoked directly (as a hook or from CI) — not when imported
// for its exports, e.g. by a future test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
