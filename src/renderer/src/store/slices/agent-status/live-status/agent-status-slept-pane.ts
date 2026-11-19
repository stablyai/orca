import { isPaneSleepRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { AppState } from '../../../types'

/** A slept pane's record waits for its wake: the agent can still report while its PTY stops, or after. */
export function paneSleepRecordAwaitsWake(state: AppState, paneKey: string): boolean {
  const record = state.sleepingAgentSessionsByPaneKey[paneKey]
  const pane = record && isPaneSleepRecord(record) ? parsePaneKey(paneKey) : null
  if (!pane) {
    return false
  }
  const livePtyIds = state.ptyIdsByTabId[pane.tabId] ?? []
  const leafPtyId = state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  return leafPtyId
    ? state.suppressedPtyExitIds[leafPtyId] === true || !livePtyIds.includes(leafPtyId)
    : livePtyIds.length === 0
}
