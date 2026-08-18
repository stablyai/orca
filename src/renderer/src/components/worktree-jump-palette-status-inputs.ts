import type { AppState } from '@/store/types'

export type PaletteStatusInputsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimePaneTitlesByTabId'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'tabsByWorktree'
  | 'unreadTerminalTabs'
  | 'unreadAgentCompletionPanes'
>

export type PaletteStatusInputs = Pick<
  PaletteStatusInputsState,
  'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'tabsByWorktree'
>

/** The hottest maps, read as a snapshot rather than subscribed. See `selectPaletteIndexStatusSnapshot`. */
export type PaletteIndexStatusSnapshot = Pick<
  PaletteStatusInputsState,
  | 'agentStatusByPaneKey'
  | 'runtimePaneTitlesByTabId'
  | 'unreadTerminalTabs'
  | 'unreadAgentCompletionPanes'
>

const EMPTY_PALETTE_INDEX_STATUS: PaletteIndexStatusSnapshot = Object.freeze({
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  unreadTerminalTabs: {},
  unreadAgentCompletionPanes: {}
})

/**
 * The agent-status, pane-title and unread maps as of *now*, for the palette's index, ordering,
 * filters and recent-section membership. Snapshotted rather than subscribed because the dots own
 * that churn (`PaletteLiveStatusProvider`), leaving the index free to freeze on open — membership
 * and row order then agree on one open-time reading instead of half-live, half-frozen.
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
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    unreadTerminalTabs: s.unreadTerminalTabs,
    unreadAgentCompletionPanes: s.unreadAgentCompletionPanes
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
