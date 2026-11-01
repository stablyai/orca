import { toast } from 'sonner'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import type { WorkspaceSpaceChange } from '../../../../shared/workspace-space-change'
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { openUncommittedEntry } from '../right-sidebar/source-control/listing/open-uncommitted-entry'
import { translate } from '@/i18n/i18n'

export function openWorkspaceSpaceChange(
  worktree: WorkspaceSpaceWorktree,
  entry: GitStatusEntry
): void {
  const change = { path: entry.path, area: entry.area }
  if (window.location.pathname.endsWith('/space.html')) {
    void window.api.workspaceSpace.revealWorktree?.(
      worktree.worktreeId,
      worktree.executionHostId,
      change
    )
    return
  }
  void revealWorkspaceSpaceChange(worktree.worktreeId, worktree.executionHostId, change)
}

export async function revealWorkspaceSpaceChange(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  change: WorkspaceSpaceChange
): Promise<void> {
  try {
    const state = useAppStore.getState()
    const worktree = getWorktreeOnHostFromState(state, worktreeId, executionHostId)
    const ownerHostId = executionHostId ?? worktree?.hostId ?? LOCAL_EXECUTION_HOST_ID
    const repo =
      worktree &&
      state.repos.find((repo) => repoMatchesHostIdentity(repo, worktree.repoId, ownerHostId))
    const target = ipcOrRuntimeTargetForHostId(ownerHostId)
    if (!worktree || !repo || !target) {
      throw new Error(
        translate(
          'workspaceSpace.changes.unavailable',
          'The workspace owner is no longer available.'
        )
      )
    }
    const status = await getRuntimeGitStatus(
      {
        target,
        worktreeId,
        worktreePath: worktree.path,
        connectionId: repo.connectionId ?? undefined
      },
      { includeLineStats: false }
    )
    const entry = status.entries.find(
      (entry) => entry.path === change.path && entry.area === change.area
    )
    if (!entry) {
      throw new Error(
        translate(
          'workspaceSpace.changes.stale',
          'This file is no longer in the uncommitted changes. Refresh Space to update the list.'
        )
      )
    }
    const activated = activateAndRevealWorktree(worktreeId, {
      navigationIntent: 'user-open',
      providesInitialSurface: true,
      executionHostId: ownerHostId
    })
    if (activated === false) {
      return
    }
    openUncommittedEntry(useAppStore.getState(), worktreeId, worktree.path, entry, {
      preview: true,
      runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
    })
  } catch (error) {
    toast.error(translate('workspaceSpace.changes.openFailed', 'Could not open changes'), {
      description: error instanceof Error ? error.message : String(error)
    })
  }
}
