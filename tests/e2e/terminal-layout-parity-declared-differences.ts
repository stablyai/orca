import type {
  DeclaredParityDifference,
  UnstableOnMainPath
} from './terminal-layout-parity-snapshot'

/**
 * Differences from main this branch is allowed, each tied to the named bug it fixes. Keep empty
 * on an inert PR. Paths are prefixes of the runner's report paths, e.g. `[0].persisted.local`.
 */
export const TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES: readonly DeclaredParityDifference[] = [
  {
    scenario: 'close-pane',
    bugId: '#30326',
    paths: [
      '[0].renderer.mountedPanesByTabId.#1.leafOrder',
      '[0].renderer.terminalLayoutsByTabId.#1.ptyIdsByLeafId',
      '[0].renderer.terminalLayoutsByTabId.#1.root',
      '[0].persisted.local.terminalLayoutsByTabId.#1.ptyIdsByLeafId',
      '[0].persisted.local.terminalLayoutsByTabId.#1.root'
    ],
    reason:
      'Closing the focused pane activates its sibling instead of the first pane; leaves are labelled from the active leaf, so the same two-pane layout relabels.'
  }
]

/** Paths main itself does not reproduce; reported but not failed. Remove an entry once main is fixed. */
export const TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN: readonly UnstableOnMainPath[] = []
