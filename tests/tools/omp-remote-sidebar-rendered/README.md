# Remote sidebar rendering proof

```sh
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/omp-remote-sidebar-rendered/run.mjs
```

The fixture uses the production worktree selector, row builder, compact sidebar rows and styles. It supplies completed paired and SSH OMP status entries before any client tabs hydrate, alongside a local completed orphan. Both remote rows must render and the local orphan must remain absent. It then removes the injected statuses and verifies the rows disappear.

This checks rendered presentation, not a live paired/SSH transport or the full Orca shell. Real snapshot retraction, host/workspace isolation and visibility tombstones are covered by `worktree-agent-remote-attribution.test.ts`. The indexed retraction regression covers 100 workspaces with a single status-key enumeration per batch.

The existing hidden Electron fixture host provides an isolated profile. CDP screenshots and a report are written under `.bench-fixtures/omp-remote-sidebar-*`; every native window must remain hidden and unfocused.
