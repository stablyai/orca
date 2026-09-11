# Relay automatic region correction — proposed plan

Status: **REVISE** following independent GPT-6-astra / medium review. A subsequent interruption experiment proposes replacing the idle-only handshake with finish-existing-sessions migration; see the follow-up at the end and RELAY-INTERRUPTION-FINDINGS.md. Not implementation-ready. See [independent review](RELAY-REGION-CORRECTION-REVIEW.md). Original proposal retained below for traceability; the following review disposition supersedes its safety and scope assumptions.

## Review disposition

Accepted blockers and required revisions:

- SQL activity leases do not prove absence of live sessions. Use an authoritative, admission-fenced idle transition in the existing cell/director handshake; unknown or unsupported cells defer. Cell changes and rollout may be required, contrary to the earlier scope assumption.
- Specify ordered decision generations, fixed expiry, and inconclusive tombstones. Relative measurement age alone does not prevent delayed old reports from resurrecting revoked eligibility.
- Compare migration benefit with the actual assigned region/epoch, not only the previous cached hint. Clearing a cache must not make a 1 ms winner eligible to move.
- Give refresh/reporting an explicit broker owner; isolate probe failures from authentication, serialize assignment application, and avoid reconnecting healthy controls merely to report.
- Measure sampled latency/reliability outcomes as well as migration completion. Desktop-to-cell probes do not establish the complete mobile-to-desktop experience.

The review's five-step revised minimal plan is the basis for the next design revision. No code implementation, deploy, or enable has been performed. Saved pairing does not block relocation, but a quiet live relay connection remains busy; backgrounding mobile is not immediate proof of disconnection. Automatic correction cannot be promised for every updated user without these eligibility and safety limitations.

## Objective and intended user experience

Automatically correct existing desktop relay assignments when a reliable regional preference differs from the assigned region, preserving pairing and active remote work. New users retain probe-based initial placement. Updated existing users refresh legacy preferences and become eligible for bounded correction; updating alone is insufficient until director support is deployed and rollout is enabled. Users with inconclusive comparisons keep their assignment and retry later. Unsupported clients continue working but do not qualify under the proposed new eligibility contract.

A saved mobile pairing must not block relocation. A running local terminal or agent alone should not block it. The precise meaning of an active relay data session, including background mobile connections and SSH relay users, MUST be established from code before promising safe, prompt correction. An open socket is not proof of interactive use; absence of observed activity is not proof that disconnecting it is harmless.

## Scope and evidence

Review the source evidence and design below, independently. The working tree is old; use fetched origin/main, and record the reviewed SHA. The dated deployment observations are in RELAY-ROLLOUT-PROGRESS.md; do not treat them as freshly queried production state.


Checked fetched `origin/main` at `721a2692893ab29f8daee3149965bf5e9adf99a0` on 2026-09-10. This is a source/design investigation, not a new production census or a claim that a new fix was tested or deployed.

### Material correction

**Bidirectional rehome already exists.** PR #19241, commit `f5be177e44`, precedes the deployed #19915 merge (`git merge-base --is-ancestor f5be177e44 a6e6de93c4d6d7d549068780bca8be789ef0f0a7` exited 0). Earlier conversational statements that we must build Asia-to-US rehome were wrong.

- `cloud/apps/relay/src/assignment-store.ts:5328`: candidate preference differs from assigned region, without a hardcoded direction.
- Same file `:5554`: locked recheck skips hosts already in their preferred region.
- Same file `:5603`: target region equals the stored preference.
- `regional-rehome-store.test.ts:346`: explicit Asia-to-US test; `:434` vicinity also tests cooldown before moving back. These test definitions were inspected, not rerun this turn.

### Actual gaps established by source

1. **Receipt age is not measurement age.** `assignment-store.ts:669` passes director `now` into preference storage; `:7205` onward only stores region and observed_at. A cache hit just before its 24-hour expiry can reset observed_at and remain eligible for another preference-max-age interval. No probe algorithm marker accompanies the hint (`relay-http-client.ts:185`).
2. **An inconclusive refresh does not revoke old relocation eligibility.** The resolver deliberately returns no hint when both regions cannot be compared (`relay-region-preference.ts:185` vicinity). `recordRegionPreference` returns early for undefined (`assignment-store.ts:7211`), retaining the prior region and timestamp. That row can remain eligible until its old timestamp ages out. Missing hints from old clients must remain distinguishable from an explicit new inconclusive result.
3. **Cache expiry is lazy, not a refresh schedule.** Resolver calls in broker open (`relay-session-broker.ts:211`) and drain/recovery (`relay-origin-pool.ts:164`) resolve preferences. Normal token refresh (`relay-session-broker.ts:251`) and control rebind (`relay-origin-pool.ts:237`) do not. An otherwise stable connection is not guaranteed to report a new preference after 24 hours. Thus simply waiting a day is not a fleet refresh strategy.
4. **Migration can end old connections at the grace deadline.** `relay-origin-pool.ts:278` schedules closing the old origin; the existing flow is not a guarantee of zero interruption for indefinitely active sessions. Rollout should initially restrict to control-connected hosts with no live user data sessions, with eligibility rechecked under the claim locks.

These are reachable consequences of the code, not proof of how many production hosts each affects.

### Concrete recommendation

**Keep region selection on the desktop and movement in the existing director worker. Fix the freshness contract between them.** Do not add a second RTT-based placement engine or continuous fleet-wide probe collection.

1. Extend the existing assignment request and preference row with a versioned optional region decision: conclusive/inconclusive, measurement age/expiry, and probe-policy version. Use bounded relative age to derive server expiry; repeated cached reports must not extend it. Invalidate legacy cache on adoption of the new policy. Explicit inconclusive decisions revoke migration eligibility; omission from legacy clients is not the same action. Keep legacy placement/reconnect functional, but do not let an unversioned write inherit or manufacture verified eligibility. This is client evidence, not server attestation.
2. Reuse the current resolver and sampling policy. Refresh/report expired decisions while the relay is active, using existing lifecycle scheduling with jitter and backoff. No wakeups for offline/sleeping desktops. Integrate through the assignment/broker flow so returned assignment changes are handled correctly, not discarded by a background request. Consider a debounced refresh on actual network changes; avoid a new 30-minute polling regime. Clear old cached results on policy upgrade.
3. Let the existing bidirectional worker consume only fresh, supported decisions. Reuse its target capacity, cell safety, cooldown, durable attempt, and failure-budget machinery. Add a deterministic cohort limit and initial no-active-data-session gate, rechecked under lock. Keep the current assignment stable during active work; accept delayed correction for continuously busy hosts rather than silently force-closing them.
4. Add aggregate preview/outcome counters using the same eligibility rules: eligible by direction, stale/legacy/inconclusive/busy exclusions, attempts, target registrations, completion/abort, and repeat moves. The existing candidate query has LIMIT 10, so its returned length is not a fleet candidate census. Preview must not claim attempts or consume failure budget. Start with a bounded cohort after the safety gate, expand on observed success, and retain disable control.

Ship director support first, then desktop support, then enable eligible cohorts. Existing strict assignment schema (`cloud/packages/relay-contract/src/director-messages.ts:14`) and HTTP 400 fallback (`relay-http-client.ts:201`) require explicit mixed-version/rollback tests; optional fields alone are not sufficient here. This solution requires a desktop release and director changes, but no cell image change is established as a prerequisite.

### Validation required before rollout

- Cached re-report cannot extend original measurement expiry; expired and unsupported decisions cannot trigger a move.
- Explicit inconclusive result removes eligibility; omitted legacy hint cannot accidentally certify a stale decision.
- Stable long-lived desktop refreshes after expiry without reconnect storms; sleep/resume and retries remain bounded.
- Both migration directions, capacity and cooldown exclusions, race between session admission and idle claim, and active-session preservation.
- New desktop/old director and old desktop/new director, including rollback fallback and policy-cache upgrade.
- Preview and actual claims share eligibility; cohort membership is stable and outcomes are auditable in aggregates.
- Real Postgres suites execute with a configured database (port 55440 only); skipping is not passing.

### Cost and alternatives

Current full comparison uses one warmup plus three retained rounds per origin, at up to two origins per region (`relay-region-probe.ts:109` onward): at most 16 health requests per successful full comparison. At one comparison/day for 10,000 active desktops that is 160,000 requests/day, about 1.85 requests/second averaged across regions, before retries/self-heal/startups. This is sizing arithmetic, not a billing quote or a guarantee of future cadence.

- Immediate global enable is smaller operationally, but cannot distinguish legacy/cached hints from fresh supported decisions and does not refresh stable connections.
- Forcing US or deleting assignments disrupts sticky sessions and ignores desktops for which Asia is preferable.
- IP geolocation does not measure routing/VPN performance and introduces a second conflicting decision source.
- Persisting every RTT sample centrally adds cost and complexity without fixing the freshness contract. Compact sampled diagnostics can be added if outcomes show the current probe policy is unreliable.

This recommendation corrects known mechanisms at fleet scale without claiming every high-RTT host will improve. Updated, eligible desktops converge over time; old clients and continuously busy hosts remain an explicit coverage gap. No production change was made during this investigation.


## Open design questions the reviewer must resolve or flag

- Is this more machinery than needed? Is a smaller cloud-only fix defensible given the actual refresh paths and existing rollout controls?
- What are the exact minimal request/cache/DB fields? How do retries, delayed/out-of-order reports, clock jumps, policy changes, and legacy writes avoid extending or resurrecting stale decisions?
- Can the existing resolver's hysteresis compare against an incumbent after a cache upgrade? Does a fresh winner necessarily justify moving an existing assignment, or is a migration-specific margin missing?
- Which existing lifecycle can refresh and report without causing reconnects, ignoring a changed assignment response, or waking dormant machines? Proposed cadence: existing 24-hour successful decision TTL and one-hour inconclusive retry, spread with jitter; no 30-minute sweep.
- Can activity leases reliably implement the intended idle gate? What happens if mobile is paired but backgrounded, a client connects during claim, or work lives on an SSH host? Is the existing graceful migration safer/simpler than the proposed idle gate?
- Which telemetry proves user benefit rather than just migration success? Is compact sampled comparative evidence needed even if full per-probe persistence is unnecessary?
- Does the design actually converge for affected users after update? Identify starvation, flip-flop, missing refresh, or unsupported-cell cases.
- Are source findings bugs to fix independently of rollout, or only conservative hardening? Distinguish production evidence from possible code paths.

## Review output requested

Write severity-ranked findings with exact origin/main file:line evidence, a concrete failure scenario, and the smallest correction. End with APPROVE / REVISE / REJECT and a revised minimal plan. Do not implement changes or operate production. Save the independent review in RELAY-REGION-CORRECTION-REVIEW.md.

## Follow-up: interruption experiment and simpler migration design

See [RELAY-INTERRUPTION-FINDINGS.md](RELAY-INTERRUPTION-FINDINGS.md) and [reproduction artifacts](tests/tools/relay-rehome-interruption/README.md). Forced migration recovers subscriptions in the harness, but in-flight mutations can become delivery-unknown; no real outage-duration claim is justified. The proposed replacement for the idle gate is to **let existing sessions finish on the source while new sessions use the target**, extending existing dual-origin migration. Desktop/cell preservation tests are red on current source, green with isolated timer-removal counterfactuals, and red again on restore. The store sustains a one-hour simulated dual-control migration and completes on source release.

This supersedes the idle-only handshake as the preferred direction, not the freshness/order/incumbent-threshold fixes. A negotiated mode, replay/cleanup handling, concurrency bounds, and integrated validation remain necessary. Do not deploy the diagnostic timer-removal patch; this replacement design has not yet received independent review. No production changes.
