import type { AppState } from '@/store/types'

export type PaletteStatusInputsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimePaneTitlesByTabId'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'tabsByWorktree'
>

export type PaletteStatusInputs = Pick<
  PaletteStatusInputsState,
  'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'tabsByWorktree'
>

/** The two hottest maps, read as a snapshot rather than subscribed. See `selectPaletteIndexStatusSnapshot`. */
export type PaletteIndexStatusSnapshot = Pick<
  PaletteStatusInputsState,
  'agentStatusByPaneKey' | 'runtimePaneTitlesByTabId'
>

const EMPTY_PALETTE_INDEX_STATUS: PaletteIndexStatusSnapshot = Object.freeze({
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {}
})

/**
 * The agent-status and pane-title maps as of *now*, for the palette's index, ordering and filters.
 * Snapshotted rather than subscribed because the dots own that churn (`PaletteLiveStatusProvider`),
 * leaving the index free to freeze on open.
 */
export function selectPaletteIndexStatusSnapshot(
  s: PaletteStatusInputsState,
  active: boolean
): PaletteIndexStatusSnapshot {
  if (!active) {
    return EMPTY_PALETTE_INDEX_STATUS
  }
  return {
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId
  }
}

// Why: the palette stays mounted once opened, so a shared frozen bundle keeps `useShallow` stable
// and stops the closed palette re-rendering on unrelated terminal chatter.
export const EMPTY_PALETTE_STATUS_INPUTS: PaletteStatusInputs = Object.freeze({
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {}
})

/**
 * The status maps the palette must keep live while `active` (open, or still animating closed): the
 * tab set changes underneath it and PTY liveness decides whether a workspace counts as sleeping.
 * The two hot maps are deliberately absent — see `selectPaletteIndexStatusSnapshot`.
 */
export function selectPaletteStatusInputs(
  s: PaletteStatusInputsState,
  active: boolean
): PaletteStatusInputs {
  if (!active) {
    return EMPTY_PALETTE_STATUS_INPUTS
  }
  return {
    ptyIdsByTabId: s.ptyIdsByTabId,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    tabsByWorktree: s.tabsByWorktree
  }
}
