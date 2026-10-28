import type {
  DeclaredParityDifference,
  UnstableOnMainPath
} from './terminal-layout-parity-snapshot'

/**
 * Differences from main this branch is allowed, each tied to the named bug it fixes. Keep empty
 * on an inert PR. Paths are prefixes of the runner's report paths, e.g. `[0].persisted.local`.
 */
export const TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES: readonly DeclaredParityDifference[] = []

/** Paths main itself does not reproduce; reported but not failed. Remove an entry once main is fixed. */
export const TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN: readonly UnstableOnMainPath[] = [
  {
    scenario: 'close-tab',
    paths: ['[0].persisted.local.terminalTopologyRevisionByRepoId.#2'],
    evidence:
      '2026-10-24 Linux: --base=5f3f0097cba9 --head=5f3f0097cba9 --grep="close-tab|close-pane" reproduced 2 → 3 with identical topology. See the PR verification artifact parity-baseline.json. The earlier full base/head run observed 3 → 2 at this same path.'
  }
]
