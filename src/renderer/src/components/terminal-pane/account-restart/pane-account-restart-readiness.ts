import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { isClaudePaneMidTurn } from '@/lib/agent-session/accounts/claude/claude-session-account-move'
import { skipsClaudeTurnHold } from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

export function holdsClaudeRestartForTurn(
  state: AppState,
  paneKey: string,
  restartAll: boolean
): boolean {
  return !restartAll && isClaudePaneMidTurn(state, paneKey)
}

/** PTYs whose queued account restart can run now: Codex at once, this tab's Claude unless held for its turn. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const ready = Object.keys(pending).filter((ptyId) => pending[ptyId] === 'codex')
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (
      pending[ptyId] === 'claude' &&
      !holdsClaudeRestartForTurn(state, makePaneKey(tabId, leafId), skipsClaudeTurnHold(ptyId))
    ) {
      ready.push(ptyId)
    }
  }
  return ready
}

const paneBoundListeners = new Map<string, Set<() => void>>()

/** A queued Claude restart can arrive before its pane's transport attaches; the attach must wake the tab's executor. */
export function notifyQueuedRestartPaneBound(tabId: string, ptyId: string): void {
  if (useAppStore.getState().pendingPaneAccountRestarts[ptyId] !== 'claude') {
    return
  }
  for (const listener of paneBoundListeners.get(tabId) ?? []) {
    listener()
  }
}

export function onQueuedRestartPaneBound(tabId: string, listener: () => void): () => void {
  const listeners = paneBoundListeners.get(tabId) ?? new Set()
  listeners.add(listener)
  paneBoundListeners.set(tabId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      paneBoundListeners.delete(tabId)
    }
  }
}
