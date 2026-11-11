import type { AppState } from '@/store/types'
import { isClaudePaneMidTurn } from '@/lib/agent-session/accounts/claude/claude-session-account-move'
// RA-11: a Restart clicked on the Orca Cloud sign-in strip runs even though Claude reports 'blocked'.
import { isForcedCloudAgentRestart } from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

/** PTYs whose queued account restart can run now: Codex at once, this tab's Claude once its turn ends. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const ready = Object.keys(pending).filter((ptyId) => pending[ptyId] === 'codex')
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (
      pending[ptyId] === 'claude' &&
      (!isClaudePaneMidTurn(state, makePaneKey(tabId, leafId)) || isForcedCloudAgentRestart(ptyId))
    ) {
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
    queued === 'codex' ||
    (queued === 'claude' &&
      (!isClaudePaneMidTurn(state, makePaneKey(tabId, leafId)) || isForcedCloudAgentRestart(ptyId)))
  )
}
