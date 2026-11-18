import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { isCodexAccountRestart } from '@/store/terminals/codex-account-restart-continuation'
import { collectLeafIds } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

/** PTYs whose queued account restart this tab runs: any Codex at once, and this tab's own Claude panes. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const layout = state.terminalLayoutsByTabId[tabId]
  const ready = collectLeafIds(layout?.root)
    .map((leafId) => makePaneKey(tabId, leafId))
    .filter((key) => {
      const request = pending[key]
      return (
        isCodexAccountRestart(request) && request.tabId === tabId && request.phase === 'accepted'
      )
    })
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId ?? {}
  for (const ptyId of Object.values(ptyIdsByLeafId)) {
    if (pending[ptyId] === 'claude') {
      ready.push(ptyId)
    }
  }
  return ready
}

const paneBoundListeners = new Map<string, Set<() => void>>()

/** A queued restart can arrive before its pane's transport attaches; the attach must wake the tab's executor. */
export function notifyQueuedRestartPaneReady(tabId: string, ptyId: string, paneKey?: string): void {
  const pending = useAppStore.getState().pendingPaneAccountRestarts
  if (!(ptyId in pending) && (!paneKey || !(paneKey in pending))) {
    return
  }
  for (const listener of paneBoundListeners.get(tabId) ?? []) {
    listener()
  }
}

export function onQueuedRestartPaneReady(tabId: string, listener: () => void): () => void {
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
