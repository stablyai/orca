import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import {
  applyDetectedWorktreeUpdates,
  getFolderWorkspaceMetaUpdates
} from '../listing/detected-worktree-meta'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import { settingsForWorktreeOwner } from '../listing/worktree-owner-settings'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { getIndexedWorktreesById } from '../../../worktree-repo-index'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'

function getKnownOwnerHostIds(
  state: ReturnType<WorktreeSliceGet>,
  worktreeId: string
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const worktree of getIndexedWorktreesById(state.worktreesByRepo, worktreeId)) {
    const hostId = parseExecutionHostId(worktree.hostId)?.id
    if (hostId) {
      hostIds.add(hostId)
    }
  }
  return [...hostIds]
}

export function createUpdateWorktreesMeta(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreesMeta'] {
  return async (updatesByWorktreeId) => {
    if (updatesByWorktreeId.size === 0) {
      return
    }

    const gitWorktreeUpdates = new Map<string, Partial<WorktreeMeta>>()
    const folderWorkspaceUpdates: {
      folderWorkspaceId: string
      updates: ReturnType<typeof getFolderWorkspaceMetaUpdates>
    }[] = []
    for (const [worktreeId, updates] of updatesByWorktreeId) {
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        const folderUpdates = getFolderWorkspaceMetaUpdates(updates)
        if (Object.keys(folderUpdates).length > 0) {
          folderWorkspaceUpdates.push({
            folderWorkspaceId: scope.folderWorkspaceId,
            updates: folderUpdates
          })
        }
      } else {
        gitWorktreeUpdates.set(worktreeId, updates)
      }
    }

    set((s) => {
      let nextWorktrees = s.worktreesByRepo
      let nextDetectedWorktrees = s.detectedWorktreesByRepo
      for (const [worktreeId, updates] of gitWorktreeUpdates) {
        nextWorktrees = applyWorktreeUpdates(nextWorktrees, worktreeId, updates)
        nextDetectedWorktrees = applyDetectedWorktreeUpdates(
          nextDetectedWorktrees,
          worktreeId,
          updates
        )
      }
      return nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo
        ? {}
        : {
            ...(nextWorktrees !== s.worktreesByRepo
              ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
              : {}),
            ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
              ? { detectedWorktreesByRepo: nextDetectedWorktrees }
              : {})
          }
    })

    await Promise.all([
      ...folderWorkspaceUpdates.map(({ folderWorkspaceId, updates }) =>
        get().updateFolderWorkspace(folderWorkspaceId, updates)
      ),
      ...Array.from(gitWorktreeUpdates, async ([worktreeId, updates]) => {
        try {
          const state = get()
          const ownerHostIds = getKnownOwnerHostIds(state, worktreeId)
          await (ownerHostIds.length === 0
            ? persistWorktreeMeta(settingsForWorktreeOwner(state, worktreeId), worktreeId, updates)
            : Promise.all(
                ownerHostIds.map((hostId) =>
                  persistWorktreeMeta(
                    settingsForWorktreeOwner(state, worktreeId, hostId),
                    worktreeId,
                    updates
                  )
                )
              ))
        } catch (err) {
          if (isRuntimeSelectorNotFoundError(err)) {
            void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
            return
          }
          console.error('Failed to update worktree meta:', err)
          void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        }
      })
    ])
  }
}
