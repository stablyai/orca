import { isCodexAccountRestart } from '@/store/terminals/codex-account-restart-continuation'
import type { AppState } from '@/store/types'
import { isClaudePaneMidTurn } from '@/lib/agent-session/accounts/claude/claude-session-account-move'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

/** PTYs whose queued account restart can run now: Codex at once, this tab's Claude once its turn ends. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.paneAccountRestarts
  const ready = Object.keys(pending).filter((key) => {
    const request = pending[key]
    return isCodexAccountRestart(request)
      ? request.tabId === tabId && request.phase === 'accepted'
      : request === 'codex'
  })
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (pending[ptyId] === 'claude' && !isClaudePaneMidTurn(state, makePaneKey(tabId, leafId))) {
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
  const queued = state.paneAccountRestarts[ptyId]
  return (
    queued === 'codex' ||
    (queued === 'claude' && !isClaudePaneMidTurn(state, makePaneKey(tabId, leafId)))
  )
}
