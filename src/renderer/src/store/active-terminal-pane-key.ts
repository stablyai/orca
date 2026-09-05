import type { AppState } from './types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'

export type ActiveTerminalPaneKeyState = Pick<
  AppState,
  'activeTabType' | 'activeTabId' | 'terminalLayoutsByTabId'
>

/** Pane key of the focused terminal leaf, or null when no terminal tab is active. */
export function selectActiveTerminalPaneKey(state: ActiveTerminalPaneKeyState): string | null {
  if (state.activeTabType !== 'terminal' || !state.activeTabId) {
    return null
  }
  const leafId = state.terminalLayoutsByTabId[state.activeTabId]?.activeLeafId
  if (!leafId || !isTerminalLeafId(leafId)) {
    return null
  }
  return makePaneKey(state.activeTabId, leafId)
}
