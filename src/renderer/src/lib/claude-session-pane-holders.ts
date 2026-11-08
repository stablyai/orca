import { resolvePaneAgentSessionId } from '@/lib/agent-session/identity/pane-agent-session-id'
import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

/** Claude reopens one branch of a shared transcript on resume, which may be the other pane's. */
export function isSessionHeldByAnotherPane(
  state: AppState,
  paneKey: string,
  sessionId: string
): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => {
      const bound = state.ptyIdsByTabId[tab.id] ?? []
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      return Object.entries(leaves).some(([leafId, ptyId]) => {
        const leafPaneKey = makePaneKey(tab.id, leafId)
        return (
          !!ptyId &&
          bound.includes(ptyId) &&
          isTerminalLeafId(leafId) &&
          leafPaneKey !== paneKey &&
          resolvePaneAgentSessionId(state, leafPaneKey) === sessionId
        )
      })
    })
  )
}
