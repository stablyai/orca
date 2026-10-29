import { editSessionSource, type SessionSourceEdit } from '@/store/session-source-edits'
import { tryRuntimeTargetForWorktreeOwner } from './worktree-owner-target'
import { warnAmbiguousOwnerOnce } from '@/lib/ambiguous-owner-warning'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { isRuntimeSelectorNotFoundError } from './runtime-worktree-rpc-errors'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import type { WorktreeSliceGet } from './worktree-slice-types'
import { selectWorktreesByRepo } from '../../../workspace-record-selectors'

/** Replaces only the copy on `hostId`; a same-id twin on another host is a different worktree. */
export function replaceWorktreeInRepoLists(
  state: Pick<AppState, 'repos' | 'worktreesByRepo'>,
  updatedWorktree: Worktree,
  hostId: ExecutionHostId,
  edit: SessionSourceEdit<Pick<AppState, 'repos' | 'worktreesByRepo'>> = editSessionSource(state)
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(updatedWorktree.id)
  const current = selectWorktreesByRepo(state)[repoId]
  if (!current) {
    return selectWorktreesByRepo(state)
  }
  const options = worktreeHostMatchOptions(state, repoId, hostId)
  edit.set(
    'worktreesByRepo',
    repoId,
    current.map((worktree) =>
      worktree.id === updatedWorktree.id && worktreeMatchesHost(worktree, hostId, options)
        ? updatedWorktree
        : worktree
    )
  )
  return edit.read('worktreesByRepo')
}

export function persistPassiveWorktreeMetaForOwner(
  get: WorktreeSliceGet,
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  errorLabel: string
): void {
  const ownerTarget = tryRuntimeTargetForWorktreeOwner(get(), worktreeId)
  if (!ownerTarget) {
    warnAmbiguousOwnerOnce(worktreeId, errorLabel)
    return
  }
  void persistWorktreeMeta(ownerTarget, worktreeId, updates).catch((err) => {
    if (isRuntimeSelectorNotFoundError(err)) {
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      return
    }
    console.error(`Failed to ${errorLabel}:`, err)
    void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
  })
}
