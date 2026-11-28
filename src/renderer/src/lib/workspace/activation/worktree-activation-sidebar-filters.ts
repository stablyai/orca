import type { Worktree } from '../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/worktree-list/listing/visible-worktree-options-from-state'

/** Hiding is no filter: opening such a workspace leaves the sidebar's filters and the project hidden. */
export function isWorktreeInHiddenProject(wt: Pick<Worktree, 'repoId' | 'hostId'>): boolean {
  const state = useAppStore.getState()
  // The sidebar's own hidden-project check, with its default host, so both agree on unstamped rows.
  return buildVisibleWorktreeOptionsFromState(
    state,
    readRuntimeStatuses(),
    getIndexedRepoMap(state.repos)
  ).hiddenProjects.isRowHidden(wt)
}
