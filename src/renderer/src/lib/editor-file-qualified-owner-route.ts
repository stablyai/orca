import { resolveUnstampedRecordHost } from '@/lib/workspace/ownership/worktree-operation-catalog-route'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findFolderWorkspaceOwner } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import {
  findIndexedWorktreeOwnerForHost,
  findIndexedDetectedWorktrees
} from './workspace/ownership/worktree-runtime-owner-index'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  resolveWorktreeOperationRouteResultForHost,
  type WorktreeOperationRouteResolution,
  type WorktreeOperationRouteState
} from '@/lib/workspace/ownership/worktree-operation-route'

export function resolveQualifiedEditorOwnerRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationRouteResolution & { ownershipProjection: 'explicit' } {
  const scope = parseWorkspaceKey(worktreeId)
  const published =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? executionHostId === 'local'
      : scope?.type === 'folder'
        ? Boolean(findFolderWorkspaceOwner(state, scope.folderWorkspaceId, executionHostId))
        : Boolean(
            findIndexedWorktreeOwnerForHost(
              selectWorktreesByRepo(state),
              worktreeId,
              executionHostId
            )
          ) ||
          findIndexedDetectedWorktrees(
            selectDetectedWorktreesByRepo(state),
            worktreeId,
            executionHostId
          ).length > 0 ||
          (executionHostId === 'local' &&
            findIndexedDetectedWorktrees(selectDetectedWorktreesByRepo(state), worktreeId).some(
              (row) =>
                !row.hostId &&
                !row.runtimeOwnerEnvironmentId?.trim() &&
                resolveUnstampedRecordHost(state, row) === 'local'
            ))
  const resolution: WorktreeOperationRouteResolution = published
    ? resolveWorktreeOperationRouteResultForHost(state, worktreeId, executionHostId)
    : { kind: 'missing' }
  return { ...resolution, ownershipProjection: 'explicit' }
}
