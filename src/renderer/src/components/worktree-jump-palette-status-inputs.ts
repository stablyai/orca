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

/** Snapshot hot status/unread maps for index, filters and recent order together at open; PaletteLiveStatusProvider dots own live churn. */
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

// Reuse a frozen empty bundle while closed so unrelated terminal chatter cannot rerender the retained palette.
export const EMPTY_PALETTE_STATUS_INPUTS: PaletteStatusInputs = Object.freeze({
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {}
})

/** Keep tab membership and PTY liveness live through close animation; hot status maps stay in the open-time snapshot. */
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
