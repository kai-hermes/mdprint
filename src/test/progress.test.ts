/**
 * progress.test.ts — layer 4: does the user actually see something moving?
 *
 * THE BUG THIS FILE EXISTS FOR (reported 2026-09-22, verbatim):
 *
 *   "while connecting and running the script, there's no progress being
 *    displayed in there to suggest something is happening. We should have this
 *    until the dialog pops up or the print window asking you which printer to
 *    use."
 *
 * The extension had no progress surface at all: `printCommand` ran the whole
 * pipeline — `swiftc` compiling the converter on a cold machine, the offscreen
 * WebKit layout, the page merge, `lp` — with the editor completely still. A
 * wait with no feedback is indistinguishable from a hang.
 *
 * `withProgress` itself needs a live editor, so it is not directly testable
 * here. What IS testable, and what actually breaks in practice, is the STAGE
 * TABLE and the increment arithmetic — the parts that decide whether the bar
 * moves, whether it moves forward, and whether the last stage leaves room for
 * the work still running.
 *
 * The specific trap being guarded: an earlier version computed the bar's
 * increment as `fractionFor(stage) - (highest >= 0 ? 0 : 0)`, which is just
 * `fractionFor(stage)` — a constant, not a delta. The bar snapped to a fixed
 * position on every stage instead of advancing. `increments` below models the
 * real arithmetic so that class of bug cannot come back.
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { STAGES, Stage, StagePlan } from '../stage-plan';

/**
 * Drive the REAL `StagePlan` over a sequence, collecting what the window would
 * be told. This deliberately exercises the shipped class rather than
 * re-implementing its arithmetic — a mirror of the logic under test cannot
 * fail for the right reason, which is precisely how the duplex bug survived
 * its own suite.
 */
function increments(sequence: Stage[]): { message: string; increment: number }[] {
  const plan = new StagePlan();
  const out: { message: string; increment: number }[] = [];

  for (const stage of sequence) {
    const increment = plan.advance(stage);
    if (increment > 0) {
      out.push({ message: stage, increment });
    }
  }
  return out;
}

test('there are stages to show, and the first one is not silence', () => {
  assert.ok(STAGES.length >= 4, 'a progress bar needs real stages to walk through');
  assert.ok(
    STAGES[0].length > 0,
    'the first stage is shown before the first await, so it must be meaningful'
  );
});

test('stage names are for the user, not for the code', () => {
  // "Building the PDF converter" belongs in a progress bar; `ensureShim` does
  // not. Internal identifiers leaking into UI is the usual way this regresses.
  const leaks = STAGES.filter((s) => /[a-z][A-Z]/.test(s) || s.includes('_') || s.includes('()'));

  assert.deepEqual(
    leaks,
    [],
    `stage text must not contain identifiers or camelCase internals; found ${JSON.stringify(leaks)}`
  );
});

test('the cold-start compile is named, because that is the longest silent wait', () => {
  // This is the one the user is most likely to hit and most likely to mistake
  // for a hang: first print on a new machine builds the converter.
  assert.ok(
    STAGES.some((s) => /converter/i.test(s)),
    'the first-run shim compile must be surfaced — it is the longest stall'
  );
});

test('the last stage is reserved for the work still in flight', () => {
  // The bar must not be full while the final stage is still running, or a
  // completed-looking bar sits frozen through the slowest part.
  const last = increments([...STAGES]).at(-1);
  assert.ok(last, 'increments must be non-empty for the full sequence');
  assert.ok(
    last.increment > 0 && last.increment < 100,
    `the final stage must leave headroom; got increment ${last?.increment}`
  );
});

test('a full run produces a strictly increasing bar that never reaches 100%', () => {
  const steps = increments([...STAGES]);
  assert.equal(steps.length, STAGES.length, 'every stage must report exactly once');

  let total = 0;
  for (const step of steps) {
    assert.ok(step.increment > 0, `stage "${step.message}" made no visible progress`);
    total += step.increment;
  }
  assert.ok(
    total > 0 && total < 100,
    `a full run must advance without completing the bar while work continues; got ${total}`
  );
});

test('THE BUG: increments are deltas, not absolute positions', () => {
  // With the old arithmetic every increment equalled its absolute fraction, so
  // the first stage alone jumped the bar to ~14% and the rest were no-ops in
  // effect. Assert the shape that a delta produces: unequal, small steps.
  const steps = increments([...STAGES]);
  const incrementsOnly = steps.map((s) => s.increment);

  // A constant increment for every stage is exactly what the broken version
  // produced for equally-spaced stages... but the real tell is the TOTAL.
  const total = incrementsOnly.reduce((a, b) => a + b, 0);
  const absoluteSum = STAGES.map((_, i) => ((i + 1) / (STAGES.length + 1)) * 100).reduce(
    (a, b) => a + b,
    0
  );

  assert.ok(
    Math.abs(total - absoluteSum) > 1,
    'delta arithmetic must differ from absolute arithmetic — this is the regression'
  );
});

test('re-reporting a stage does not twitch the bar backwards', () => {
  // A theme lookup or a retry can report the same stage twice; the bar must
  // stay put rather than jump back and read as a failure.
  const withRepeat: Stage[] = [STAGES[0], STAGES[0], STAGES[1], STAGES[1], STAGES[2]];
  const steps = increments(withRepeat);

  assert.equal(steps.length, 3, `repeats must be swallowed; got ${JSON.stringify(steps.map((s) => s.message))}`);
  for (const step of steps) {
    assert.ok(step.increment > 0, 'a forwarded stage must still make progress');
  }
});

test('going backwards is refused, because it reads as a restart', () => {
  // Asserted against `advance()` DIRECTLY, not through the `increments` helper.
  // The helper filters non-positive increments, so it silently hid the fact
  // that removing the guard makes `advance()` return a NEGATIVE delta — which
  // in the real window would drag the bar backwards. Testing through a filter
  // that discards the very values the guard exists to produce is no test at all.
  const plan = new StagePlan();
  plan.advance(STAGES[2]);

  const backwards = plan.advance(STAGES[0]);
  assert.equal(
    backwards,
    0,
    `a stage earlier than the current one must return 0, never a negative delta; got ${backwards}`
  );
});

test('a repeated stage returns zero, not a second helping of progress', () => {
  const plan = new StagePlan();
  const first = plan.advance(STAGES[1]);
  const repeat = plan.advance(STAGES[1]);

  assert.ok(first > 0, 'the first report must advance');
  assert.equal(repeat, 0, 'a repeat must be swallowed, or the bar over-reports');
});

test('no advance ever returns a negative number', () => {
  // The invariant the backwards guard exists to maintain, checked across an
  // exhaustive walk of every ordering of two stages.
  for (const a of STAGES) {
    for (const b of STAGES) {
      const plan = new StagePlan();
      plan.advance(a);
      const second = plan.advance(b);
      assert.ok(
        second >= 0,
        `advance(${JSON.stringify(a)}) then advance(${JSON.stringify(b)}) returned ${second}; negatives drag the bar backwards`
      );
    }
  }
});

test('out-of-order forwards still advance monotonically', () => {
  // The pipeline is not strictly linear: on the dialog door, "handing the PDF
  // to the print dialog" follows "laying out the pages" with no printer query.
  const outOfOrder: Stage[] = [STAGES[0], STAGES[4], STAGES[6]];
  const steps = increments(outOfOrder);

  assert.equal(steps.length, 3);
  for (const step of steps) {
    assert.ok(step.increment > 0, `stage "${step.message}" must advance the bar`);
  }
});
