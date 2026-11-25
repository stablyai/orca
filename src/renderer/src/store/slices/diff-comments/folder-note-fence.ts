import type { AppState } from '../../types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { peekHostCatalogGeneration } from '../../host-catalog/host-catalog-fence'
import type { DiffCommentOwner } from './diff-comment-owner'

type FolderOwner = Extract<DiffCommentOwner, { kind: 'folder' }>

/**
 * Notes a protected copy took from a host-issued receipt or read, with the newest folder catalog
 * fetch generation claimed at that moment. A fetch claimed at or before it may have sampled the host
 * before that commit, so it never replaces those notes. This outlives the protected queue itself.
 */
const fencedNotes = new Map<string, { catalogHostId: ExecutionHostId; generation: number }>()

export function catalogTargetOf(owner: FolderOwner): RuntimeClientTarget {
  return owner.runtimeEnvironmentId
    ? { kind: 'environment', environmentId: owner.runtimeEnvironmentId }
    : { kind: 'local' }
}

function fenceKey(rowHostId: ExecutionHostId, folderWorkspaceId: string): string {
  return `${rowHostId}\0${folderWorkspaceId}`
}

export function folderWorkspaceIdOf(owner: FolderOwner): string | null {
  const scope = parseWorkspaceKey(owner.worktreeId)
  return scope?.type === 'folder' ? scope.folderWorkspaceId : null
}

/** The host whose folder catalog lists this copy's row. */
export function folderCatalogHostIdOf(owner: FolderOwner): ExecutionHostId {
  return getRuntimeTargetHostId(catalogTargetOf(owner))
}

/** Whether a fetch with this generation may predate notes this copy took from the host. */
export function isFolderNotesFenceHolding(
  rowHostId: ExecutionHostId,
  folderWorkspaceId: string,
  fetchGeneration: number
): boolean {
  const fence = fencedNotes.get(fenceKey(rowHostId, folderWorkspaceId))
  return fence !== undefined && fetchGeneration <= fence.generation
}

export function recordFolderNotesFence(get: () => AppState, owner: FolderOwner): void {
  const folderWorkspaceId = folderWorkspaceIdOf(owner)
  if (!folderWorkspaceId) {
    return
  }
  const target = catalogTargetOf(owner)
  fencedNotes.set(fenceKey(owner.executionHostId, folderWorkspaceId), {
    catalogHostId: getRuntimeTargetHostId(target),
    generation: peekHostCatalogGeneration(get, 'folder-workspaces', target)
  })
}

/** Drops the fence of a copy whose row was replaced or removed: its notes are no longer that row's. */
export function forgetFolderNotesFence(owner: FolderOwner): void {
  const folderWorkspaceId = folderWorkspaceIdOf(owner)
  if (folderWorkspaceId) {
    fencedNotes.delete(fenceKey(owner.executionHostId, folderWorkspaceId))
  }
}

/**
 * Applied to a catalog fetch's merged rows. Rows of a fenced copy keep the notes state already holds
 * when the fetch was claimed no later than the fence; a later fetch replaces them and retires it.
 */
export function keepFencedFolderNotes(args: {
  catalogHostId: ExecutionHostId
  fetchGeneration: number
  merged: readonly FolderWorkspace[]
  current: readonly FolderWorkspace[]
  rowHostId: (workspace: FolderWorkspace) => ExecutionHostId
}): readonly FolderWorkspace[] {
  if (fencedNotes.size === 0) {
    return args.merged
  }
  let changed = false
  const next = args.merged.map((row) => {
    const hostId = args.rowHostId(row)
    const key = fenceKey(hostId, row.id)
    const fence = fencedNotes.get(key)
    if (!fence || fence.catalogHostId !== args.catalogHostId) {
      return row
    }
    if (args.fetchGeneration > fence.generation) {
      fencedNotes.delete(key)
      return row
    }
    const kept = args.current.find(
      (entry) =>
        entry.id === row.id && entry.createdAt === row.createdAt && args.rowHostId(entry) === hostId
    )
    if (!kept || kept.diffComments === row.diffComments) {
      return row
    }
    changed = true
    return { ...row, diffComments: kept.diffComments }
  })
  return changed ? next : args.merged
}

export function resetFolderNotesFenceForTests(): void {
  fencedNotes.clear()
}
