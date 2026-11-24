import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import type { DiffCommentOwner } from './diff-comment-owner'
import { toRuntimeWorktreeSelector } from '../../../runtime/rpc/targets/runtime-worktree-selector'
import { callHostRoute } from '@/runtime/rpc/calls/host-route-call'
import { hostRouteForAuthority, type HostRoute } from '@/runtime/rpc/targets/runtime-client-target'
import {
  captureHostIdentityFence,
  isHostIdentityContinued
} from '@/runtime/rpc/environment-revisions/host-identity-fence'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

// Why local: the folder's catalog row lives on the server even when it names an SSH target.
function folderCatalogRoute(
  runtimeEnvironmentId: string
): ReturnType<typeof hostRouteForAuthority> {
  return hostRouteForAuthority({
    endpoint: { kind: 'environment', environmentId: runtimeEnvironmentId },
    at: 'local'
  })
}

/** One folder row's update on the host owning its catalog; the host answers with the row it changed. */
async function updateFolderRow(
  owner: Extract<DiffCommentOwner, { kind: 'folder' }>,
  folderWorkspaceId: string,
  updates: { diffComments?: DiffComment[]; diffCommentsBase?: DiffComment[] }
): Promise<FolderWorkspace | null> {
  return owner.runtimeEnvironmentId
    ? (
        await callHostRoute<{ folderWorkspace: FolderWorkspace | null }>(
          folderCatalogRoute(owner.runtimeEnvironmentId),
          'folderWorkspace.update',
          { folderWorkspaceId, updates },
          { timeoutMs: 15_000 }
        )
      ).folderWorkspace
    : await window.api.folderWorkspaces.update({ folderWorkspaceId, updates })
}

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
    const updated = await updateFolderRow(owner, scope.folderWorkspaceId, {
      diffComments,
      ...baseUpdate
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

/**
 * The notes a folder row holds now, read through an update that changes no field: the host answers
 * with exactly the row a later write merges into (never another same-id row), and only that row.
 */
async function readFolderDiffCommentsFromHost(
  owner: Extract<DiffCommentOwner, { kind: 'folder' }>
): Promise<DiffComment[]> {
  const scope = parseWorkspaceKey(owner.worktreeId)
  if (scope?.type !== 'folder') {
    throw new Error('The workspace host is unresolved; review notes were not saved.')
  }
  const held = await updateFolderRow(owner, scope.folderWorkspaceId, {})
  // Why throw: without the host's list there is no safe base, and a write without one replaces it.
  if (!held) {
    throw new Error('This workspace was not found on its host; review notes were not saved.')
  }
  return held.diffComments ?? []
}

/** The notes a workspace's host holds now, read through an update that changes nothing where one exists. */
async function readDiffCommentsFromHost(owner: DiffCommentOwner): Promise<DiffComment[]> {
  if (owner.kind === 'folder') {
    return readFolderDiffCommentsFromHost(owner)
  }
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

function remoteRouteOf(owner: DiffCommentOwner): HostRoute | null {
  if (owner.kind === 'folder') {
    return owner.runtimeEnvironmentId ? folderCatalogRoute(owner.runtimeEnvironmentId) : null
  }
  return owner.authority.endpoint.kind === 'self' ? null : hostRouteForAuthority(owner.authority)
}

/**
 * Reads what the host holds, decides the write from it, then writes it to the same machine.
 * Why the identity check: a base read from one machine must never be merged on another one.
 */
export async function rewriteDiffCommentsOnHost(
  owner: DiffCommentOwner,
  decide: (held: DiffComment[]) => { diffComments: DiffComment[]; diffCommentsBase: DiffComment[] }
): Promise<void> {
  const route = remoteRouteOf(owner)
  const fence = route ? captureHostIdentityFence(route) : null
  const { diffComments, diffCommentsBase } = decide(await readDiffCommentsFromHost(owner))
  if (fence && !isHostIdentityContinued(fence)) {
    throw new Error('The workspace host changed; review notes were not saved.')
  }
  await writeDiffCommentsToHost(owner, diffComments, diffCommentsBase)
}
