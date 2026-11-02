import type { AppState } from '../types'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import {
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { callHostRoute } from '@/runtime/host-route-call'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

/** Writes a workspace's whole review-note list to the host that owns it. */
export async function writeDiffCommentsToHost(
  state: AppState,
  worktreeId: string,
  diffComments: DiffComment[],
  folderExecutionHostId?: ReturnType<typeof getExecutionHostIdForFolderWorkspace>,
  writeHostId?: ExecutionHostId
): Promise<void> {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const executionHostId =
      folderExecutionHostId ?? getExecutionHostIdForFolderWorkspace(state, scope.folderWorkspaceId)
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      executionHostId
    )
    const updated = runtimeEnvironmentId
      ? (
          await callHostRoute<{ folderWorkspace: FolderWorkspace | null }>(
            // Why local: the folder's catalog row lives on the server even when it names an SSH target.
            hostRouteForAuthority({
              endpoint: { kind: 'environment', environmentId: runtimeEnvironmentId },
              at: 'local'
            }),
            'folderWorkspace.update',
            { folderWorkspaceId: scope.folderWorkspaceId, updates: { diffComments } },
            { timeoutMs: 15_000 }
          )
        ).folderWorkspace
      : await window.api.folderWorkspaces.update({
          folderWorkspaceId: scope.folderWorkspaceId,
          updates: { diffComments }
        })
    if (!updated?.diffComments) {
      throw new Error('Failed to persist folder workspace review notes')
    }
    return
  }
  const target = runtimeTargetForWorkspaceOwner(state, {
    workspaceId: worktreeId,
    hostId: writeHostId
  })
  if (!target) {
    throw new Error('The workspace host is unresolved; review notes were not saved.')
  }
  if (target.kind === 'local') {
    const meta = await window.api.worktrees.updateMeta({
      worktreeId,
      ...(writeHostId ? { executionHostId: writeHostId } : {}),
      updates: { diffComments }
    })
    // Why: main answers null when it refuses or drops the write; reporting success would lose the notes.
    if (!meta) {
      throw new Error('This computer did not save the review notes.')
    }
    return
  }
  await callRuntimeRpc(
    target,
    'worktree.set',
    { worktree: toRuntimeWorktreeSelector(worktreeId), diffComments },
    { timeoutMs: 15_000 }
  )
}
