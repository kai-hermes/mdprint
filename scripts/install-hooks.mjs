#!/usr/bin/env node
// install-hooks.mjs — wire commit-msg-hook.mjs into git's hooks on `npm install`.
//
// Uses `git rev-parse --git-path hooks` rather than assuming `.git/hooks`:
// in a git WORKTREE, `.git` is a file pointing at
// `<main-repo>/.git/worktrees/<name>`, and hooks are shared from the common
// dir, not per-worktree — a naive `path.join(root, '.git', 'hooks')` would
// try to create a directory underneath a plain file and silently do nothing.
//
// The installed hook itself resolves its OWN worktree at commit time (`git
// rev-parse --show-toplevel`), not the path this script happened to run
// from — hooks are shared across every worktree of a repo, so baking in
// *this* worktree's absolute path would point at a directory that may not
// exist by the time someone commits from a different one.
//
// A no-op, not a failure, when there's no git repo at all (installed from a
// tarball) or `git` isn't on PATH — this runs on every `npm install`/`npm
// ci`, including in CI, where it should be silent and harmless.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOOK = `#!/bin/sh
# Installed by \`npm install\` — see scripts/install-hooks.mjs.
root=$(git rev-parse --show-toplevel) || exit 0
exec node "$root/scripts/commit-msg-hook.mjs" "$1"
`;

try {
  const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    encoding: 'utf8',
  }).trim();
  if (!hooksDir) {
    process.exit(0);
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'commit-msg');
  fs.writeFileSync(hookPath, HOOK, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
} catch {
  // No git repo, no git on PATH, or a hook that couldn't be written — never
  // block `npm install` over this.
  process.exit(0);
}
