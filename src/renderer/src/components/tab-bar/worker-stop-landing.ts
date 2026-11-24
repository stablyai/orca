import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  landOnEmptiedWorktree,
  landsOnEmptiedWorktree
} from '@/store/slices/tabs/tabs-empty-workspace'
import { indexedWorkerTab } from './worker-tab-index'

const leaveSelectionAlone = (): void => {}

/** A confirmed stop can drop its surface in a later host frame. */
export function prepareWorkerStopLanding(
  worktreeId: string,
  tabId: string
): (waitForRemoval: boolean) => void {
  const { activeWorktreeId, activeWorkspaceExecutionHostId, activeView } = useAppStore.getState()
  if (activeWorktreeId !== worktreeId) {
    return leaveSelectionAlone
  }
  const ownsSelection = (state: AppState): boolean =>
    state.activeWorktreeId === worktreeId &&
    state.activeWorkspaceExecutionHostId === activeWorkspaceExecutionHostId &&
    state.activeView === activeView
  return (waitForRemoval) => {
    if (!ownsSelection(useAppStore.getState())) {
      return
    }
    if (
      landOnEmptiedWorktree(useAppStore.setState, useAppStore.getState, worktreeId) ||
      !waitForRemoval
    ) {
      return
    }
    let unsubscribe: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      unsubscribe?.()
      unsubscribe = undefined
      if (timeout !== undefined) {
        clearTimeout(timeout)
        timeout = undefined
      }
    }
    const reconcile = (state: AppState): void => {
      if (!ownsSelection(state)) {
        finish()
        return
      }
      const tabs = state.unifiedTabsByWorktree[worktreeId]
      if (indexedWorkerTab(tabs, tabId)) {
        return
      }
      if (tabs?.length) {
        finish()
        return
      }
      if (landsOnEmptiedWorktree(state, worktreeId, 0)) {
        finish()
        landOnEmptiedWorktree(useAppStore.setState, useAppStore.getState, worktreeId)
      }
    }
    unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
        state.activeView !== previous.activeView ||
        state.unifiedTabsByWorktree[worktreeId] !== previous.unifiedTabsByWorktree[worktreeId] ||
        state.tabsByWorktree[worktreeId] !== previous.tabsByWorktree[worktreeId] ||
        state.browserTabsByWorktree[worktreeId] !== previous.browserTabsByWorktree[worktreeId] ||
        state.openFiles !== previous.openFiles
      ) {
        reconcile(state)
      }
    })
    timeout = setTimeout(finish, 20_000)
    reconcile(useAppStore.getState())
  }
}
