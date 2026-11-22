import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import type {
  MergeContext,
  RuntimeHostResourceSample,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import {
  resolveResourceFolderWorkspace,
  resolveResourceWorkspaceHost
} from './resource-workspace-host'

/** Where a sampled workspace's row goes, and how it is named. */
export type SamplePlacement = Pick<
  UnifiedWorktreeRow,
  'worktreeId' | 'worktreeName' | 'repoId' | 'repoName' | 'isRemote' | 'hostLabel' | 'unplaced'
> & { readOnly?: true }

/** The catalog inputs placement reads; a sample's cached rows stay valid while these keep their identity. */
export function placementInputs(ctx: MergeContext): readonly unknown[] {
  return [
    ctx.worktreeById,
    ctx.ambiguousWorktreeIds,
    ctx.repoDisplayNameById,
    ctx.repoConnectionIdById,
    ctx.repoRuntimeHostIdById
  ]
}

/**
 * Null for a workspace a paired machine hosts, so its load, chats included, is never attributed here.
 * A chat under a duplicated id can't be opened, since the window can't tell which twin holds it.
 */
export function localSamplePlacement(
  ctx: MergeContext,
  wt: WorktreeMemory
): SamplePlacement | null {
  const worktree = resolveResourceFolderWorkspace(ctx, wt.worktreeId)
  const repoId = worktree?.repoId ?? wt.repoId
  const { isRemote, runtimeHostId } = resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId)
  if (runtimeHostId) {
    return null
  }
  return {
    worktreeId: wt.worktreeId,
    worktreeName: worktree?.displayName?.trim() || wt.worktreeName,
    repoId,
    repoName: (worktree && ctx.repoDisplayNameById.get(repoId)) || wt.repoName,
    isRemote,
    ...(ctx.ambiguousWorktreeIds?.has(wt.worktreeId) ? { unplaced: true as const } : {})
  }
}

/** Foreign or unplaced paired load stays host-qualified so same-ID workspaces elsewhere cannot absorb it. */
export function pairedSamplePlacement(
  ctx: MergeContext,
  host: RuntimeHostResourceSample,
  wt: WorktreeMemory
): SamplePlacement {
  const worktree = resolveResourceFolderWorkspace(ctx, wt.worktreeId)
  const repoId = worktree?.repoId ?? wt.repoId
  const owned =
    resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId).runtimeHostId === host.hostId
  return {
    worktreeId: owned ? wt.worktreeId : `${host.hostId}|${wt.worktreeId}`,
    worktreeName: (owned && worktree?.displayName?.trim()) || wt.worktreeName,
    repoId: owned ? repoId : `${host.hostId}|${wt.repoId}`,
    repoName: (owned && ctx.repoDisplayNameById.get(repoId)) || wt.repoName,
    isRemote: true,
    hostLabel: host.hostLabel,
    readOnly: true
  }
}
