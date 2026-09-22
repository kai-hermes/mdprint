/**
 * exec.ts — the only place this extension shells out.
 *
 * Everything goes through here for one reason: a child process that nobody
 * watches is how you get a silent stall, and a silent stall is the one failure
 * mode this tool is not allowed to have. Every call has a timeout, every
 * failure is a PrintError with the stderr text in it, and stdout/stderr are
 * captured so they can be quoted back to the user.
 *
 * No shell. Arguments are an array, so a document title containing a quote or a
 * semicolon can never turn into a command.
 */

import { execFile } from 'node:child_process';
import { PrintError } from './types';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  /** Milliseconds before we give up and report a stall. */
  timeoutMs?: number;
}

/**
 * Run a program and capture everything. Rejects with a PrintError on non-zero
 * exit, so callers never have to check a code.
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<RunResult>((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');

        if (error) {
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
          const code = typeof error.code === 'number' ? error.code : 1;

          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new PrintError(`${cmd} isn't installed, or isn't on this machine's PATH.`));
            return;
          }
          if (killed) {
            reject(
              new PrintError(
                `${cmd} didn't come back within ${Math.round(timeoutMs / 1000)}s. ` +
                  `Nothing was printed — check the printer is switched on and reachable.`
              )
            );
            return;
          }

          const detail = (err.trim() || out.trim() || `exit ${code}`).split('\n').slice(-4).join(' ');
          reject(new PrintError(`${cmd} failed: ${detail}`));
          return;
        }

        resolve({ stdout: out, stderr: err, code: 0 });
      }
    );
  });
}

/** Run, and give back stdout only. Convenience for the many read-only probes. */
export async function capture(cmd: string, args: string[], options?: RunOptions): Promise<string> {
  const r = await run(cmd, args, options);
  return r.stdout;
}

/**
 * Run for its exit code alone, treating failure as a `false` answer rather than
 * an error. For probes like "is this program here?" where absence is a fact,
 * not a fault.
 */
export async function probe(cmd: string, args: string[], options?: RunOptions): Promise<boolean> {
  try {
    await run(cmd, args, options);
    return true;
  } catch {
    return false;
  }
}
