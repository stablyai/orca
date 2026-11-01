Test Audit

Apply the cleanup. Deletion alone is valid; do not add tests to preserve counts or coverage percentages.

Scope

Read the intended PR's diff against its merge base, nearby coverage, and test-selection workflows. Trace CI fan-out through builds, matrices, setup, and required checks. Keep unrelated tests and user edits out of scope.

Remove low-value tests

Judge tests by the meaningful regressions they catch versus runtime, flakiness, and maintenance cost. Candidates include:

Source-text assertions that freeze implementation details rather than external contracts.

Tests that repeat implementation logic or only verify configured mock responses.

Duplicate cases, unfocused snapshots, trivial assertions, and speculative edge cases.

Expensive UI, network, or SSH tests for behavior already covered at a cheaper layer.

Before deleting unique coverage, identify the lost failure signal and justify its removal. Preserve real protocol and required-check contracts. Remove orphaned fixtures or jobs only after checking callers.

Add replacements only with evidence

A new or strengthened test must have:

A consequential regression grounded in a reported failure, explicit contract, or visible failure mechanism.

An observable production outcome; mock unavailable boundaries, not the behavior being tested.

Proof it fails on the pre-fix code or a realistic production fault and passes with the fix. Restore temporary mutations immediately.

A stable harness at the cheapest layer that exercises the failure.

Prefer extending existing coverage. If no replacement meets this bar, keep valuable tests, delete justified candidates, and report the gap.

Match CI execution to risk

Reuse existing selection logic. Cover production dependencies, shared inputs, harness/config changes, test edits, renames, and deletions.

Narrow broad triggers for expensive suites and their prerequisites. Skipping tests after building the app or starting an SSH matrix saves little.

Keep useful fast checks in normal PR validation and preserve required release/platform/security checks.

Handle unknown diffs conservatively, including shallow history or incomplete pagination. Avoid allowlists that silently omit new relevant tests.

Ensure required checks complete on intentional skips and still propagate failures.

Verify and report

Run affected surviving tests and relevant config checks. For routing changes, exercise relevant and irrelevant diffs, shared inputs, test edits, renames/deletions, and unknown-diff fallback. Inspect the resulting job graph; do not validate routing with brittle source-string tests.

Report deletions and lost/retained coverage, replacement failure demonstrations, run/skip policy, checks run, and remaining gaps. Base savings on inspected jobs or measurements; label estimates. Push, merge, or post only when asked.
