import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { computeVisibleWorktrees } from './compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import {
  getVisibleWorkspaceHostIdSet,
  worktreeMatchesVisibleHost
} from './visible-worktree-host-scope'

const NO_WORKTREES: readonly Worktree[] = []

/** Workspaces only "Hide sleeping" removes; every other sidebar filter still applies. */
export function useHiddenSleepingWorktrees(
  visibleWorktrees: readonly Worktree[]
): readonly Worktree[] {
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  return useMemo(() => {
    if (showSleepingWorkspaces) {
      return NO_WORKTREES
    }
    // Why no activity subscription: sleep and wake both move a row in or out of visibleWorktrees.
    const state = useAppStore.getState()
    const repoMap = getIndexedRepoMap(state.repos)
    const visibleHostIds = getVisibleWorkspaceHostIdSet(state)
    const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
    const shownKeys = new Set(visibleWorktrees.map(getWorktreeHostIdentity))
    const hidden = computeVisibleWorktrees(worktreesByRepo, [], {
      ...buildVisibleWorktreeOptionsFromState(state, repoMap),
      showSleepingWorkspaces: true
    }).filter(
      (worktree) =>
        !worktree.isArchived &&
        !shownKeys.has(getWorktreeHostIdentity(worktree)) &&
        worktreeMatchesVisibleHost(worktree, visibleHostIds, repoMap, defaultHostId)
    )
    return hidden.length === 0
      ? NO_WORKTREES
      : hidden.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }, [showSleepingWorkspaces, visibleWorktrees, worktreesByRepo])
}
