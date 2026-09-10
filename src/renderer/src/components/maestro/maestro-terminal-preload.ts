import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { requestBackgroundTerminalWorktreeMount } from '../terminal/background-terminal-worktree-mount'

export const MAESTRO_TERMINAL_PRELOAD_START_DELAY_MS = 50
export const MAESTRO_TERMINAL_PRELOAD_INTERVAL_MS = 120

type TimerId = ReturnType<typeof globalThis.setTimeout>

type MaestroTerminalPreloadOptions = {
  worktreeId: string
  getTerminalTabIds: () => readonly string[]
  isTerminalMounted?: (tabId: string, worktreeId: string) => boolean
  requestMount?: typeof requestBackgroundTerminalWorktreeMount
  setTimer?: (callback: () => void, delayMs: number) => TimerId
  clearTimer?: (timerId: TimerId) => void
}

export function terminalWorkspaceIdForMaestroKey(workspaceKey: string): string | null {
  const scope = parseWorkspaceKey(workspaceKey)
  if (scope?.type === 'worktree') {
    return scope.worktreeId
  }
  return scope?.type === 'folder' ? workspaceKey : null
}

export function scheduleMaestroTerminalPreload({
  worktreeId,
  getTerminalTabIds,
  isTerminalMounted = hasRegisteredRuntimeTerminalTab,
  requestMount = requestBackgroundTerminalWorktreeMount,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout
}: MaestroTerminalPreloadOptions): () => void {
  const requestedTabIds = new Set<string>()
  let timerId: TimerId | null = null
  let cancelled = false

  const preloadNext = (): void => {
    if (cancelled) {
      return
    }
    const nextTabId = getTerminalTabIds().find(
      (tabId) => !requestedTabIds.has(tabId) && !isTerminalMounted(tabId, worktreeId)
    )
    if (!nextTabId) {
      return
    }
    requestedTabIds.add(nextTabId)
    requestMount({ worktreeId, tabIds: [nextTabId] })
    timerId = setTimer(preloadNext, MAESTRO_TERMINAL_PRELOAD_INTERVAL_MS)
  }

  timerId = setTimer(preloadNext, MAESTRO_TERMINAL_PRELOAD_START_DELAY_MS)
  return () => {
    cancelled = true
    if (timerId !== null) {
      clearTimer(timerId)
    }
  }
}
