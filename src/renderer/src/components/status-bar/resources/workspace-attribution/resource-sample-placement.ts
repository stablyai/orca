import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import { canonicalExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  MergeContext,
  RuntimeHostResourceSample,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import {
  resolveResourceFolderWorkspace,
  resolveResourceWorkspaceHost,
  stampedRuntimeHostId
} from './resource-workspace-host'

/** Where a sampled workspace's row goes, and how it is named. */
export type SamplePlacement = Pick<
  UnifiedWorktreeRow,
  | 'worktreeId'
  | 'worktreeName'
  | 'repoId'
  | 'repoName'
  | 'isRemote'
  | 'hostLabel'
  | 'runtimeHostId'
  | 'unplaced'
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
 * Null for a workspace a paired machine hosts, so its load is never attributed here. Terminals follow
 * the workspace's host, as before. Chats run here, so they drop only when that host is also the record's stamp.
 */
export function localSamplePlacement(
  ctx: MergeContext,
  wt: WorktreeMemory,
  chatOnly: boolean
): SamplePlacement | null {
  const worktree = resolveResourceFolderWorkspace(ctx, wt.worktreeId)
  const repoId = worktree?.repoId ?? wt.repoId
  const { isRemote, runtimeHostId } = resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId)
  if (runtimeHostId && (!chatOnly || stampedRuntimeHostId(ctx, wt.worktreeId))) {
    return null
  }
  return {
    worktreeId: wt.worktreeId,
    worktreeName: worktree?.displayName?.trim() || wt.worktreeName,
    repoId,
    repoName: (worktree && ctx.repoDisplayNameById.get(repoId)) || wt.repoName,
    isRemote
  }
}

/** A paired sample beside a workspace this machine's own sample already shows is host-qualified. */
export function pairedSamplePlacement(
  ctx: MergeContext,
  host: RuntimeHostResourceSample,
  wt: WorktreeMemory,
  shownLocally?: (worktreeId: string, repoId: string) => boolean
): SamplePlacement {
  const worktree = resolveResourceFolderWorkspace(ctx, wt.worktreeId)
  const repoId = worktree?.repoId ?? wt.repoId
  // A worktree stamped with a paired host belongs to that host alone, wherever its repo is tracked.
  const ambiguous = ctx.ambiguousWorktreeIds?.has(wt.worktreeId) ?? false
  const recordHostId = stampedRuntimeHostId(ctx, wt.worktreeId)
  const owned =
    !shownLocally?.(wt.worktreeId, repoId) &&
    (recordHostId
      ? recordHostId === canonicalExecutionHostId(host.hostId)
      : resolveResourceWorkspaceHost(ctx, wt.worktreeId, repoId).runtimeHostId === host.hostId)
  // Keep foreign/unplaced server load host-qualified so same-ID workspaces elsewhere cannot absorb it.
  return {
    worktreeId: owned ? wt.worktreeId : `${host.hostId}|${wt.worktreeId}`,
    worktreeName: (owned && worktree?.displayName?.trim()) || wt.worktreeName,
    repoId: owned ? repoId : `${host.hostId}|${wt.repoId}`,
    repoName: (owned && ctx.repoDisplayNameById.get(repoId)) || wt.repoName,
    isRemote: true,
    ...(host.hostLabel ? { hostLabel: host.hostLabel } : {}),
    readOnly: true,
    runtimeHostId: host.hostId,
    // A repo placed on this host isn't enough: an unlisted or duplicated worktree can't be selected.
    unplaced: owned && !ambiguous && ctx.worktreeById?.has(wt.worktreeId) ? undefined : true
  }
}
