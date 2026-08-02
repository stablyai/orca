import type { AppState } from '@/store/types'

export type PaletteStatusInputsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimePaneTitlesByTabId'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'tabsByWorktree'
>

export type PaletteStatusInputs = PaletteStatusInputsState

// Why: shared frozen bundle returned whenever the Cmd+J jump palette isn't
// active. The two hottest maps here — agentStatusByPaneKey and
// runtimePaneTitlesByTabId — get a new top-level identity on every agent-status
// transition and every terminal pane-title write app-wide. The palette is always
// mounted (App.tsx renders <CommandDialog open={visible}>) and stays mounted for
// the whole session once opened, so subscribing to them while it's closed
// re-rendered the whole palette — and recomputed its per-worktree live/working-dot
// sort over every worktree — on unrelated terminal chatter. A useShallow
// subscription keeps this same reference across that churn, so the closed palette
// stops reacting. Frozen so the shared singleton can't be mutated.
export const EMPTY_PALETTE_STATUS_INPUTS: PaletteStatusInputs = Object.freeze({
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {}
})

/**
 * Select the five status maps the jump palette needs to derive per-worktree
 * live/working dots and switcher ordering — but only while it's `active` (open,
 * or still animating closed). While inactive nothing is shown, so return a stable
 * frozen constant that a `useShallow`-wrapped subscription keeps referentially
 * equal across the (very hot) agent-status / pane-title writes, skipping the
 * re-render that would otherwise fire on the always-mounted palette on every
 * unrelated terminal. The instant it becomes active the live maps flow through
 * and every derivation recomputes exactly as before.
 */
export function selectPaletteStatusInputs(
  s: PaletteStatusInputsState,
  active: boolean
): PaletteStatusInputs {
  if (!active) {
    return EMPTY_PALETTE_STATUS_INPUTS
  }
  return {
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    tabsByWorktree: s.tabsByWorktree
  }
}
