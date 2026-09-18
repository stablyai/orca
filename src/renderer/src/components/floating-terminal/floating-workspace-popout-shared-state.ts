import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

let popoutDetached = false
const detachedListeners = new Set<() => void>()

export function setFloatingWorkspacePopoutDetached(value: boolean): void {
  if (popoutDetached === value) {
    return
  }
  popoutDetached = value
  for (const listener of detachedListeners) {
    listener()
  }
}

export function subscribeFloatingWorkspacePopoutDetached(listener: () => void): () => void {
  detachedListeners.add(listener)
  return () => {
    detachedListeners.delete(listener)
  }
}

export function isFloatingWorkspacePopoutDetached(): boolean {
  return popoutDetached
}

// Why a getState read, not a hook: dialog hosts in both documents share one decision.
export function isFloatingWorkspaceTerminalTab(tabId: string): boolean {
  const state = useAppStore.getState()
  const terminalTabs = state.tabsByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  if (terminalTabs.some((tab) => tab.id === tabId)) {
    return true
  }
  const unifiedTabs = state.unifiedTabsByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  return unifiedTabs.some((tab) => tab.id === tabId || tab.entityId === tabId)
}

export function resetFloatingWorkspacePopoutSharedStateForTest(): void {
  setFloatingWorkspacePopoutDetached(false)
}
