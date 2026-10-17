import type { AppState } from '@/store'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/** Whether the pane's agent is mid-turn: a restart during a reply, permission prompt or question drops it. */
export function isAgentPaneMidTurn(
  state: Pick<AppState, 'agentStatusByPaneKey'>,
  paneKey: string,
  agent: AccountRestartAgent
): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.agentType === agent && entry.state !== 'done'
}

/** Whether a queued restart for `agent` may run in `paneKey` now: never mid-turn. */
export function isQueuedAccountRestartReady(
  state: AppState,
  agent: AccountRestartAgent,
  paneKey: string
): boolean {
  return !isAgentPaneMidTurn(state, paneKey, agent)
}

/** This tab's PTYs whose queued account restart can run now that their turn has ended. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const ready: string[] = []
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    const queued = pending[ptyId]
    if (queued && isQueuedAccountRestartReady(state, queued, makePaneKey(tabId, leafId))) {
      ready.push(ptyId)
    }
  }
  return ready
}

/** Whether `ptyId`'s queued restart can run against the store as it is now. */
export function isAccountRestartReady(
  state: AppState,
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  const queued = state.pendingPaneAccountRestarts[ptyId]
  return (
    queued !== undefined && isQueuedAccountRestartReady(state, queued, makePaneKey(tabId, leafId))
  )
}
