import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'

export type SimulatorTabPaletteActivationFailure = 'missing-tab' | 'missing-worktree'

export type SimulatorTabPaletteActivationResult =
  | { status: 'activated'; tabId: string }
  | { status: 'failed'; reason: SimulatorTabPaletteActivationFailure }

export type SimulatorTabPaletteActivationTarget = {
  tabId: string
  worktreeId: string
}

export function activateSimulatorTabPaletteResult({
  tabId,
  worktreeId
}: SimulatorTabPaletteActivationTarget): SimulatorTabPaletteActivationResult {
  const initialState = useAppStore.getState()
  const tab = (initialState.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId && candidate.contentType === 'simulator'
  )
  if (!tab) {
    return { status: 'failed', reason: 'missing-tab' }
  }

  // Why thread hostId: activateAndRevealWorktree resolves the worktree and stores
  // activeWorkspaceExecutionHostId from it, so remote-hosted worktrees need it.
  const worktree = initialState.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const activated = activateAndRevealWorktree(
    worktree.id,
    worktree.hostId ? { executionHostId: worktree.hostId } : {}
  )
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id)
  state.setActiveTab(tab.id)
  state.setActiveTabType('simulator')
  return { status: 'activated', tabId: tab.id }
}
