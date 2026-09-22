/**
 * stage-plan.ts — the pure half of the progress indicator.
 *
 * Split from `progress.ts` for exactly the same reason `duplex-rules.ts` was
 * split from `duplex-choice.ts`, and `template-css.ts` from `theme.ts`:
 * `vscode` is not a real module outside the editor, so anything importing it
 * cannot be unit-tested. The stage table and the increment arithmetic are the
 * parts that actually break, and they need no editor to be wrong.
 *
 * THE BUG THIS FILE EXISTS FOR (reported 2026-09-22, verbatim):
 *
 *   "while connecting and running the script, there's no progress being
 *    displayed in there to suggest something is happening. We should have this
 *    until the dialog pops up or the print window asking you which printer to
 *    use."
 *
 * The extension had no progress surface at all. A cold first print spends
 * seconds compiling the PDF converter, booting offscreen WebKit and laying out
 * pages, with the editor completely still the entire time — and a wait with no
 * feedback is indistinguishable from a hang.
 */

/**
 * The stages of a print, in the order the user experiences them.
 *
 * Ordering matters: the bar refuses to go backwards, so this array is also the
 * authority on what "forward" means.
 *
 * Names are for the USER, not for the code. "Building the PDF converter" fits
 * in a progress bar; `ensureShim` does not. Anything camelCase or snake_case is
 * a leaked identifier and `progress.test.ts` rejects it.
 */
export const STAGES = [
  'collecting what you see in the editor',
  'applying the template',
  'building the PDF converter (first run only)',
  'laying out the pages',
  'asking the printer',
  'checking what this printer can do',
  'handing the PDF to the print dialog',
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * How far through a stage is, as a fraction of the whole.
 *
 * Never 0 (the first stage must visibly move the bar) and never 100: the last
 * sliver is reserved so the bar is still moving when the final stage starts,
 * rather than sitting full while the slowest work continues.
 */
export function fractionFor(stage: Stage): number {
  const i = STAGES.indexOf(stage);
  if (i < 0) {
    return 0;
  }
  return ((i + 1) / (STAGES.length + 1)) * 100;
}

/**
 * Track how far along we are, refusing to go backwards.
 *
 * A bar that jumps backwards reads as a failure-then-restart, so a repeat or an
 * out-of-order report must be swallowed rather than rendered. Returns the delta
 * to hand to the progress window, or 0 when there is nothing to do.
 *
 * This is deliberately stateful and pure rather than inlined in the `vscode`
 * wrapper: an earlier version computed the increment as
 * `fractionFor(stage) - (highest >= 0 ? 0 : 0)` — which is just
 * `fractionFor(stage)`, a constant, not a delta. The bar snapped rather than
 * advanced, and nothing caught it because the arithmetic was untestable.
 */
export class StagePlan {
  private last = 0;

  /** Advance to `stage`; returns the increment, or 0 if nothing should move. */
  advance(stage: Stage): number {
    const fraction = fractionFor(stage);
    if (fraction <= this.last) {
      return 0;
    }
    const delta = fraction - this.last;
    this.last = fraction;
    return delta;
  }

  /** The first stage, shown before the first await so the window is never blank. */
  static opening(): Stage {
    return STAGES[0];
  }
}
