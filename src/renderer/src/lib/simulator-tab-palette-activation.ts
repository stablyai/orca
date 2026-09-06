import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { activateAndRevealWorktree } from './worktree-activation'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { findAmbiguousWorktreeIds, isUnifiedTabOwnedByWorktree } from './unified-tab-host-ownership'

export type SimulatorTabPaletteActivationFailure = 'missing-tab' | 'missing-worktree'

export type SimulatorTabPaletteActivationResult =
  | { status: 'activated'; tabId: string }
  | { status: 'failed'; reason: SimulatorTabPaletteActivationFailure }

export type SimulatorTabPaletteActivationTarget = {
  executionHostId?: ExecutionHostId
  tabId: string
  worktreeId: string
}

export function activateSimulatorTabPaletteResult({
  executionHostId,
  tabId,
  worktreeId
}: SimulatorTabPaletteActivationTarget): SimulatorTabPaletteActivationResult {
  const initialState = useAppStore.getState()
  const worktree = initialState.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  const tabs = (initialState.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (candidate) => candidate.id === tabId
  )
  const tab = tabs[0]
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(
    getIndexedAllWorktrees(initialState.worktreesByRepo)
  )
  if (
    tabs.length !== 1 ||
    tab.contentType !== 'simulator' ||
    !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
  ) {
    return { status: 'failed', reason: 'missing-tab' }
  }

  const targetHostId = executionHostId ?? worktree.hostId
  const activated = activateAndRevealWorktree(
    worktree.id,
    targetHostId ? { executionHostId: targetHostId } : {}
  )
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  state.setActiveTab(tab.id)
  state.setActiveTabType('simulator')
  return { status: 'activated', tabId: tab.id }
}
