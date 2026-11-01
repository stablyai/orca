import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import type { ResolvedDiffCommentOwner } from '../diff-comment-owner'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callHostRoute } from '@/runtime/host-route-call'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

/** Writes a workspace's whole review-note list to the host that owns it. */
export async function writeDiffCommentsToHost(
  owner: ResolvedDiffCommentOwner,
  diffComments: DiffComment[]
): Promise<void> {
  const worktreeId = owner.worktreeId
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder' && owner.kind === 'folder') {
    const runtimeEnvironmentId = owner.runtimeEnvironmentId
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
  if (owner.kind !== 'worktree') {
    throw new Error('The workspace host is unresolved; review notes were not saved.')
  }
  const { target, writeHostId } = owner
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
