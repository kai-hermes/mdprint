/**
 * progress.ts — the editor-shell half of "something is happening".
 *
 * All the stage logic lives in `stage-plan.ts`, which is pure and therefore
 * testable; this file is only the part that needs a live editor — opening a
 * `withProgress` window and driving it.
 *
 * See `stage-plan.ts` for the bug that prompted this — in short, the whole
 * print pipeline ran with the editor completely still: a cold first run spends
 * seconds in `swiftc`, offscreen WebKit layout and page merging, and a wait
 * with no feedback is indistinguishable from a hang.
 *
 * DESIGN RULES:
 *   - The window opens BEFORE the first await, so there is never a gap between
 *     the command firing and something appearing.
 *   - `report()` only ever moves forward; a repeated stage is swallowed rather
 *     than rendered, because a bar that jumps backwards reads as a failure.
 *   - The cancellation flag is real: it cannot interrupt a `swiftc` already in
 *     flight (that is bounded by its own timeout), but it stops the next stage
 *     starting, which is what the user actually asked for.
 *
 * WHY `withProgress` AND NOT A NOTIFICATION: notifications stack up and demand
 * dismissal. This is a work-in-flight indicator, and the editor already has a
 * place for those.
 */

import * as vscode from 'vscode';

import { Stage, StagePlan } from './stage-plan';

export { STAGES } from './stage-plan';
export type { Stage } from './stage-plan';

/**
 * A live progress window plus the stage reporter that drives it.
 *
 * `report` is the only thing the pipeline calls, and it is deliberately cheap
 * and total: an unnamed stage is ignored rather than throwing, because a
 * progress indicator must never be the reason a print fails.
 */
export interface Progress {
  report(stage: Stage): void;
  /** Ask the pipeline to stop at the next safe boundary. */
  cancelled(): boolean;
  /** Close the window. Safe to call twice. */
  done(): void;
}

/**
 * A reporter that does nothing, for the paths that must not show UI.
 *
 * Exists so callers can be written without a `progress?.report()` sprinkle —
 * `report` is always callable, and the no-op keeps the call sites honest
 * instead of conditionally skipped.
 */
export function silentProgress(): Progress {
  return {
    report: () => undefined,
    cancelled: () => false,
    done: () => undefined,
  };
}

/**
 * Open a progress window and hand back a reporter.
 *
 * The returned promise resolves when `task` does, and the window closes in a
 * `finally` so a thrown PrintError still takes the spinner away before the
 * error message appears — an error on top of a spinning bar reads as "still
 * working", which is exactly the confusing state to avoid.
 */
export async function withProgress<T>(
  title: string,
  task: (progress: Progress) => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      // Cancellable: the user can back out of a slow first-run build without
      // waiting for the timeout.
      cancellable: true,
    },
    async (window, token) => {
      const plan = new StagePlan();

      const progress: Progress = {
        report(stage: Stage): void {
          if (token.isCancellationRequested) {
            return;
          }
          const increment = plan.advance(stage);
          if (increment <= 0) {
            return;
          }
          window.report({ message: stage, increment });
        },
        cancelled: () => token.isCancellationRequested,
        done: () => undefined,
      };

      // Show *something* before the first await, so pressing Print is never
      // met with a still window.
      progress.report(StagePlan.opening());

      return task(progress);
    }
  );
}
