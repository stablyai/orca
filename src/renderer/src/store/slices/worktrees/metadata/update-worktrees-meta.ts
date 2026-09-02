import type { WorktreeMetaBatchUpdate, WorktreeSlice } from '../../worktree-helpers'
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
  return async (updates) => {
    if (updates.length === 0) {
      return
    }

    const gitWorktreeUpdates: WorktreeMetaBatchUpdate[] = []
    const folderWorkspaceUpdates: {
      folderWorkspaceId: string
      updates: ReturnType<typeof getFolderWorkspaceMetaUpdates>
    }[] = []
    for (const entry of updates) {
      const scope = parseWorkspaceKey(entry.worktreeId)
      if (scope?.type === 'folder') {
        const folderUpdates = getFolderWorkspaceMetaUpdates(entry.updates)
        if (Object.keys(folderUpdates).length > 0) {
          folderWorkspaceUpdates.push({
            folderWorkspaceId: scope.folderWorkspaceId,
            updates: folderUpdates
          })
        }
      } else {
        gitWorktreeUpdates.push(entry)
      }
    }

    set((s) => {
      let nextWorktrees = s.worktreesByRepo
      let nextDetectedWorktrees = s.detectedWorktreesByRepo
      for (const entry of gitWorktreeUpdates) {
        nextWorktrees = applyWorktreeUpdates(
          nextWorktrees,
          entry.worktreeId,
          entry.updates,
          entry.executionHostId
        )
        nextDetectedWorktrees = applyDetectedWorktreeUpdates(
          nextDetectedWorktrees,
          entry.worktreeId,
          entry.updates,
          entry.executionHostId
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
      ...gitWorktreeUpdates.map(async ({ worktreeId, updates, executionHostId }) => {
        try {
          const state = get()
          const ownerHostIds = executionHostId
            ? [executionHostId]
            : getKnownOwnerHostIds(state, worktreeId)
          await (ownerHostIds.length === 0
            ? persistWorktreeMeta(settingsForWorktreeOwner(state, worktreeId), worktreeId, updates)
            : Promise.all(
                ownerHostIds.map((hostId) => {
                  const worktree = getIndexedWorktreesById(state.worktreesByRepo, worktreeId).find(
                    (candidate) => candidate.hostId === hostId
                  )
                  return persistWorktreeMeta(
                    settingsForWorktreeOwner(state, worktreeId, hostId),
                    worktreeId,
                    updates,
                    hostId,
                    worktree?.identity?.key
                  )
                })
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
