import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import type { DiffCommentOwner } from './diff-comment-owner'
import { toRuntimeWorktreeSelector } from '../../../runtime/rpc/targets/runtime-worktree-selector'
import { callHostRoute } from '@/runtime/rpc/calls/host-route-call'
import { hostRouteForAuthority } from '@/runtime/rpc/targets/runtime-client-target'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

/** Writes a workspace's whole review-note list to the host that owns it; the base is the list it was edited from. */
export async function writeDiffCommentsToHost(
  owner: DiffCommentOwner,
  diffComments: DiffComment[],
  diffCommentsBase: DiffComment[] | undefined
): Promise<void> {
  const worktreeId = owner.worktreeId
  const scope = parseWorkspaceKey(worktreeId)
  // Why base: the host applies only this edit, so notes another device added meanwhile survive.
  const baseUpdate = diffCommentsBase ? { diffCommentsBase } : {}
  if (scope?.type === 'folder' && owner.kind === 'folder') {
    const runtimeEnvironmentId = owner.runtimeEnvironmentId
    const updates = { diffComments, ...baseUpdate }
    const updated = runtimeEnvironmentId
      ? (
          await callHostRoute<{ folderWorkspace: FolderWorkspace | null }>(
            // Why local: the folder's catalog row lives on the server even when it names an SSH target.
            hostRouteForAuthority({
              endpoint: { kind: 'environment', environmentId: runtimeEnvironmentId },
              at: 'local'
            }),
            'folderWorkspace.update',
            { folderWorkspaceId: scope.folderWorkspaceId, updates },
            { timeoutMs: 15_000 }
          )
        ).folderWorkspace
      : await window.api.folderWorkspaces.update({
          folderWorkspaceId: scope.folderWorkspaceId,
          updates
        })
    if (!updated?.diffComments) {
      throw new Error('Failed to persist folder workspace review notes')
    }
    return
  }
  if (owner.kind !== 'worktree') {
    throw new Error('The workspace host is unresolved; review notes were not saved.')
  }
  // The captured authority is the route: this app names the place it keeps the copy, a server owns its own.
  const { endpoint, at } = owner.authority
  if (endpoint.kind === 'self') {
    const meta = await window.api.worktrees.updateMeta({
      worktreeId,
      executionHostId: at,
      updates: { diffComments, ...baseUpdate }
    })
    // Why: main answers null when it refuses or drops the write; reporting success would lose the notes.
    if (!meta) {
      throw new Error('This computer did not save the review notes.')
    }
    return
  }
  await callRuntimeRpc(
    { kind: 'environment', environmentId: endpoint.environmentId },
    'worktree.set',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      diffComments,
      ...baseUpdate
    },
    { timeoutMs: 15_000 }
  )
}

/** The notes a worktree's host holds now; this computer's are read through an update that changes nothing. */
export async function readDiffCommentsFromHost(
  owner: Extract<DiffCommentOwner, { kind: 'worktree' }>
): Promise<DiffComment[]> {
  const { endpoint, at } = owner.authority
  if (endpoint.kind === 'self') {
    const meta = await window.api.worktrees.updateMeta({
      worktreeId: owner.worktreeId,
      executionHostId: at,
      updates: {}
    })
    if (!meta) {
      throw new Error('This computer did not answer with the review notes.')
    }
    return meta.diffComments ?? []
  }
  const { worktree } = await callRuntimeRpc<{ worktree?: { diffComments?: DiffComment[] } }>(
    { kind: 'environment', environmentId: endpoint.environmentId },
    'worktree.show',
    { worktree: toRuntimeWorktreeSelector(owner.worktreeId) },
    { timeoutMs: 15_000 }
  )
  return worktree?.diffComments ?? []
}
