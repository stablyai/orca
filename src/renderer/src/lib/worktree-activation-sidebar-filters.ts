import type { AppState } from '@/store'
import type { Worktree } from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { isDetachedHeadWorkspace } from '@/components/sidebar/visible-worktrees'

export function clearWorktreeActivationSidebarFilters(state: AppState, worktree: Worktree): void {
  if (state.filterRepoIds.length > 0 && !state.filterRepoIds.includes(worktree.repoId)) {
    state.setFilterRepoIds([])
  }
  if (
    state.hideAutomationGeneratedWorkspaces &&
    worktree.automationProvenance?.kind === 'created-by-automation'
  ) {
    state.setHideAutomationGeneratedWorkspaces(false)
  }
  if (state.hideCliCreatedWorkspaces && worktree.cliProvenance?.kind === 'created-by-cli') {
    state.setHideCliCreatedWorkspaces(false)
  }
  if (state.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
    state.setHideDetachedHeadWorkspaces(false)
  }
}

export function revealActivatedWorktree(
  state: AppState,
  worktreeId: string,
  options: {
    behavior?: PendingSidebarWorktreeReveal['behavior']
    executionHostId?: ExecutionHostId
  }
): void {
  if (options.behavior || options.executionHostId) {
    state.revealWorktreeInSidebar(worktreeId, {
      ...(options.behavior ? { behavior: options.behavior } : {}),
      ...(options.executionHostId ? { executionHostId: options.executionHostId } : {})
    })
  } else {
    state.revealWorktreeInSidebar(worktreeId)
  }
}
