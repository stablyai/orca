# Relay rehome interruption experiment

This is an investigation harness overlay, **not a production patch**. Source revision: `721a2692893ab29f8daee3149965bf5e9adf99a0`.

`interruption-tests.patch` adds four focused tests to existing harnesses. It also stubs unused native keychain imports in the mobile failover test; injected credential storage remains the original test dependency. `diagnostic-counterfactual.patch` removes two forced-close scheduling sites to isolate their effect. It deliberately lacks mode negotiation and changes existing deadline semantics; **do not merge or deploy it**.

## Results

| Oracle | Current source | Counterfactual | Restored source |
| --- | --- | --- | --- |
| Desktop retains existing work beyond 30s, then closes source on final connection release | FAIL: old transport stopped | PASS | FAIL |
| Cell retains active splice beyond 30s with control heartbeat | FAIL: close code 4503 | PASS | FAIL |
| Mobile re-resolves assignment after drain, reuses credential, restores subscription | PASS | Unchanged | PASS |
| Store holds registered migration for one hour with both controls renewed, completes on source release | PASS | Unchanged | PASS |

These are deterministic service tests with fake sockets/physical sessions and clocks. The store test uses SQLite. They do not measure real mobile outage time or prove production Postgres concurrency or PTY survival. The mobile retry test advances a fake clock 251ms: 250ms configured backoff plus 1ms simulated socket event. Network, TLS, crypto, director, and target authentication latency are injected, not measured.

## Reproduction layout

The local snapshot is `.tmp/relay-interruption` inside this worktree. It was created with `git archive` of the pinned revision's `src`, `mobile`, `cloud`, `config`, `package.json`, and `pnpm-workspace.yaml`; the root `node_modules` is reused by symlink. Cloud dependencies were installed from the independent cloud workspace with pnpm 10.24.0, `install --frozen-lockfile --ignore-scripts --filter @orca-cloud/relay...`, then `pnpm --filter @orca-cloud/relay-contract build`.

Mobile transport-only setup: the snapshot's mobile tsconfig was replaced with a minimal ES2022/ESNext/bundler config to avoid loading the absent Expo SDK; production source was unchanged. Mobile resolves the locally installed `@noble/hashes` 1.8.0 required by its package.json, rather than root's incompatible 2.x. No native app launches or device keychain access.

Apply the tests patch to a fresh pinned snapshot. From the snapshot root, use `ORCA_BACKGROUND_LAUNCH=1` for each test command:

```sh
../../node_modules/.bin/vitest run --config config/vitest.config.ts src/main/runtime/relay/relay-session-broker.test.ts -t 'repro:'
../../node_modules/.bin/vitest run --config mobile/vitest.config.ts mobile/src/transport/mobile-relay-runtime-failover.test.ts -t 'repro:'
```

From the snapshot's `cloud/` directory:

```sh
pnpm --filter @orca-cloud/relay exec vitest run src/host-session-registry.test.ts src/regional-rehome-store.test.ts -t 'repro:'
```

The first and cell preservation tests MUST fail on baseline. Apply the counterfactual to the snapshot and rerun those exact tests; both pass. Reverse only the counterfactual and rerun: both fail again. Source-only restore must preserve the byte-identical test overlay.

Broader checks on restored production source: desktop broker/origin suites = 18 passed (new preservation repro excluded); cell registry/drain/store suites = 95 passed (two added repros excluded); four mobile RPC/failover/logical-client/reconnect suites = 64 passed with zero skips. The separate one-hour store repro passed. Filtered runs deliberately report unselected tests as skipped; no PostgreSQL suites were invoked or counted as passing.

Patch SHA-256:

- tests: `526c7b90bd6646c5a4884eba778eb86fc2a83e0f257001563eb3183fe1189802`
- counterfactual: `6bc6432261a343099d39321b8594eea0a5088851fc00b9c632c8944eca466188`

The snapshot is left with original production source restored and the diagnostic tests retained. User changes in package.json and tests/tools/relay-bench were preserved.
