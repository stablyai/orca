import type { WorktreeSlice } from '../../worktree-helpers'
import { tryRuntimeTargetForWorktreeOwner } from '../listing/worktree-owner-target'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../listing/detected-worktree-meta'
import { getFolderWorkspaceActivityPersistence } from './folder-workspace-activity'
import { warnAmbiguousOwnerOnce } from '@/lib/ambiguous-owner-warning'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'

export function createBumpWorktreeActivity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['bumpWorktreeActivity'] {
  return (worktreeId) => {
    // Switch point: the owning host writes Recent stamps; terminal start and exit are not events.
    if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
      return
    }
    const now = Date.now()
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      // Why: folder meta lives on the FolderWorkspace record — persistWorktreeMeta would write a
      // worktreeMeta['folder:…'] row that folderWorkspaces:list never reads back (#10251).
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      let shouldPersist = false
      set((s) => {
        if (!s.folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
          return s
        }
        shouldPersist = true
        const isActive = s.activeWorktreeId === worktreeId
        return {
          folderWorkspaces: s.folderWorkspaces.map((workspace) =>
            workspace.id === folderWorkspaceId ? { ...workspace, lastActivityAt: now } : workspace
          ),
          // Why: active-workspace PTY events are click side-effects, so they must not reorder it.
          ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
        }
      })
      if (shouldPersist) {
        getFolderWorkspaceActivityPersistence(get).record(folderWorkspaceId, now)
      }
      return
    }
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree) {
        return s
      }
      shouldPersist = true
      // Why: skip sortEpoch bump for the active worktree — its PTY events are click side-effects (reorder-on-click bug, PR #209).
      // lastActivityAt is still persisted so the next background-driven sortEpoch bump includes this worktree's score.
      const isActive = s.activeWorktreeId === worktreeId
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? {
              worktreesByRepo: nextWorktrees,
              ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
            }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    const ownerTarget = tryRuntimeTargetForWorktreeOwner(get(), worktreeId)
    if (!ownerTarget) {
      warnAmbiguousOwnerOnce(worktreeId, 'persist worktree activity timestamp')
      return
    }
    void persistWorktreeMeta(ownerTarget, worktreeId, {
      lastActivityAt: now
    }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        return
      }
      console.error('Failed to persist worktree activity timestamp:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  }
}
