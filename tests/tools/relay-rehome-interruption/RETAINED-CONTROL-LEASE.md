# Retained source control: reuse the existing activity renewal

Investigated 2026-09-10 against fetched `origin/main` at `fb85f88d645f3e886a9df7dd2bf41d065f7e7a4c`. Source was exported into `.tmp/retained-control-lease` inside this worktree. Production untouched; no app launch. This is a prototype and design finding, not a completed optional migration feature.

## Recommended revision

Use the cell's existing successful `renewControlActivity` result to extend the same retained control's in-memory lifetime. Do not add another desktop timer, source rebind, WebSocket renewal command, or periodic database query solely for this requirement.

A healthy cell already pings every 15 seconds and renews its control activity every 30 seconds (`host-session-registry.ts:70`, `:1111`). The requested activity horizon is 105 seconds from request start. On successful renewal, a negotiated retained source may set its control expiry to `max(existingControlExpiry, requestedActivityExpiry)`. It does not receive another unconditional six hours. Delayed responses use the original requested deadline, never response-time plus a new interval.

Current atomic Postgres renewal authorizes either the current assignment or its still-open exact forward migration (`assignment-store.ts:3353` onward), checks the control activity ID/cell, updates the activity, and rejects missing/released/wrong-cell activity. That is already the right place to validate authority. For the future retained mode, narrow that existing statement with the immutable attempt/mode/source basis/incarnation; keep its current row-lock order rather than adding a separate check/query. The current primitive alone does not certify the future mode or capability: those fields do not exist yet.

Local success handling must also match captured attempt, current session object, socket, generation and retained-mode marker, and must not act after retirement, rollback, replacement, or emergency drain. Regular controls retain their existing six-hour rotation policy. Normal JWT and silence enforcement remain unchanged.

## First-grant ordering is required

Before acknowledging a finish-existing drain and instructing desktop cutover, establish one successful short renewal bound to that exact optional migration. Then reuse the existing heartbeat schedule for subsequent renewals. Never wait until a near-expiry source reaches its first later heartbeat: that heartbeat currently starts async renewal and checks expiry before the response returns. A test demonstrates that a mode flag alone does not save a source with only 1ms left.

On initial renewal failure/stale generation, do not acknowledge retained-mode readiness or send its drain instruction. Reconcile the provisional target using the separately planned retained-generation rollback path. An in-flight request or missing-activity reacquisition alone is not a renewal grant. If the connection has already failed during validation, do not resurrect it.

This can add one initial validation/renewal for mode adoption, but no second recurring renewal loop. Actor identity/mode negotiation and rollback are still part of the overall feature; this revision removes the extra recurring wire protocol that plan v2 section 5a had proposed.

## Prototype and tests

`retained-control-prototype.patch` adds a test-only retained-attempt marker and guarded expiry extension to the cell's existing renewal success callback. The marker is injected in the harness to represent successful future negotiation. There is deliberately no public way to enable it. The patch does not implement first-grant dispatch ordering, durable mode predicates, negotiation, rollback or multi-day reconciliation; **do not merge/deploy it as the feature**.

Thirteen new deterministic tests plus thirty existing registry tests pass: **43 passed, zero skipped**. Covered:

- Same socket/generation survives the old lease expiry; four heartbeat ticks still use only two renewal calls and one original activation.
- 2,884 heartbeat ticks span 12h 1m simulated time, with exactly 1,442 renewal calls and no new activation or splice closure.
- Ordinary regional source expiry remains unchanged when retained mode is absent.
- Database errors do not extend the latest successful grant; expiry remains enforced.
- Lost migration authority triggers the existing close behavior.
- Responses for an obsolete attempt or closed socket cannot extend the old lifetime.
- Delayed success uses request-start expiry.
- JWT expiry, 75-second silence watchdog, and emergency drain remain enforced.
- A flag without the first grant does not authorize survival past expiry.
- Missing-activity reacquisition alone does not extend control lifetime.

Baseline/restored source: three preservation/expiry-extension tests fail, ten negative/boundary tests pass. Prototype: all thirteen pass. The final test overlay differs from the first run only by non-null assertions needed by TypeScript. Relay package typecheck passes on the prototype plus final tests.

The simulated duration is not real device observation. Mock database grants and synthetic socket state isolate callback lifetime behavior; no physical network, mobile UI or application mutation is exercised in this test.

## Real Postgres validation

An ephemeral PostgreSQL 17 container was bound only to `127.0.0.1:55440`. Existing `control-renewal-postgres.test.ts`: **6 passed, zero skipped**, with ORCA_RELAY_TEST_POSTGRES_URL supplied only to the child process. Tests prove the current primitive permits the source only during its forward migration, rejects renewal after migration completion, does not resurrect a released control, preserves ordering of older/fresher expiries, bounds expiry, and uses one autocommitted statement in steady state. They do not test the future mode-specific SQL predicates or full cell/director/desktop feature.

Container was stopped and automatically removed after the tests. No production credentials or raw host records were used.

## Reproduce

In the pinned snapshot's independent `cloud/` workspace, install filtered dependencies with `pnpm install --frozen-lockfile --ignore-scripts --filter @orca-cloud/relay...`, build `@orca-cloud/relay-contract` and `@orca-cloud/postgres-schema`, then apply the test/prototype patches at the snapshot root.

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --filter @orca-cloud/relay exec vitest run src/host-session-registry.test.ts
pnpm --filter @orca-cloud/relay typecheck
```

With an explicitly configured ephemeral database on 55440:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --filter @orca-cloud/relay exec vitest run src/control-renewal-postgres.test.ts
```

Never count its conditional describe.skip as success. To prove the counterfactual, restore only `host-session-registry.ts` to the pinned source while retaining the test overlay, then run `-t retention-lease:`. Expect three failures. No production source remains modified in the snapshot after this investigation.

Final patch SHA-256:

- tests: `5b43b3f15358bc0ce2766b5e6f9bd07f97f0c8fd569897726c030b325e82e1c2`
- prototype: `3fa262216fa02499edea0122318dfc8aac6686b2c82aede6855bbd5151a32f2b`

## Scope of the conclusion

This is a smaller, tested mechanism for the **control lifetime requirement**. It does not remove the need for same-generation rollback, final-pending-work notifications, mode-aware 24-hour cleanup/redrain rules, compatible operational rollback floor, or integrated real-socket validation. Those are separate parts of the overall retention feature. No claim that the entire feature is simple or incapable of new issues is warranted.
