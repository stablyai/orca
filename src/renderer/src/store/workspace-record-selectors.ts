import {
  resolveQualifiedFolderWorkspaceResult,
  type QualifiedFolderHostState,
  type FolderHostWorkspace
} from '../../../shared/folder-workspace-execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'

// Route workspace readers here; check-workspace-record-read-ratchet.mjs enforces this boundary.

export type WorkspaceRecordState = Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'> &
  Pick<QualifiedFolderHostState, 'repos' | 'projectGroups'>

/** Git worktrees per repo id, in listing order. */
export function selectWorktreesByRepo<TState extends { worktreesByRepo?: unknown }>(
  state: TState
): TState['worktreesByRepo'] {
  return state.worktreesByRepo
}

export function selectFolderWorkspaces<TState extends { folderWorkspaces?: unknown }>(
  state: TState
): TState['folderWorkspaces'] {
  return state.folderWorkspaces
}

/** Checkouts git reports that Orca does not track, per repo id. */
export function selectDetectedWorktreesByRepo<TState extends { detectedWorktreesByRepo?: unknown }>(
  state: TState
): TState['detectedWorktreesByRepo'] {
  return state.detectedWorktreesByRepo
}

// ─── Keyed records ───────────────────────────────────────────────────

/**
 * The row that owns `target` on its host, including a paired runtime's logical host alias.
 * An ambiguous owner on that host answers undefined.
 */
export function selectWorkspaceByHostTarget(
  state: WorkspaceRecordState,
  target: HostWorktreeTarget
): Worktree | undefined {
  const scope = parseWorkspaceKey(target.id)
  if (scope?.type === 'folder') {
    const result = resolveQualifiedIndexedFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      target.hostId
    )
    return result.kind === 'selected'
      ? getFolderWorkspaceWorktree(result.value.workspace, result.value)
      : undefined
  }
  return (
    findIndexedWorktreeOwnerForHost(state.worktreesByRepo, target.id, target.hostId) ?? undefined
  )
}

const qualifiedFolderOwnerCache = new WeakMap<
  readonly FolderHostWorkspace[],
  {
    groups: QualifiedFolderHostState['projectGroups']
    repos: QualifiedFolderHostState['repos']
    rows: ReadonlyMap<string, readonly FolderHostWorkspace[]>
    positions: ReadonlyMap<FolderHostWorkspace, number>
    results: Map<string, ReturnType<typeof resolveQualifiedFolderWorkspaceResult>>
  }
>()

export function resolveQualifiedIndexedFolderWorkspace<W extends FolderHostWorkspace>(
  state: QualifiedFolderHostState<W>,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): ReturnType<typeof resolveQualifiedFolderWorkspaceResult<W>> {
  const folders = selectFolderWorkspaces(state)
  if (!folders) {
    return { kind: 'missing' }
  }
  let cache = qualifiedFolderOwnerCache.get(folders)
  if (!cache || cache.groups !== state.projectGroups || cache.repos !== state.repos) {
    const rows = new Map<string, FolderHostWorkspace[]>()
    const positions = new Map<FolderHostWorkspace, number>()
    for (const [index, folder] of folders.entries()) {
      positions.set(folder, index)
      const id = folder.id
      const copies = rows.get(id) ?? []
      copies.push(folder)
      rows.set(id, copies)
    }
    cache = { groups: state.projectGroups, repos: state.repos, rows, positions, results: new Map() }
    qualifiedFolderOwnerCache.set(folders, cache)
  }
  const key = executionHostId ? `${folderWorkspaceId}\0${executionHostId}` : folderWorkspaceId
  let result = cache.results.get(key)
  if (!result) {
    result = resolveQualifiedFolderWorkspaceResult(
      { ...state, folderWorkspaces: cache.rows.get(folderWorkspaceId) ?? [] },
      folderWorkspaceId,
      executionHostId
    )
    cache.results.set(key, result)
  }
  const positions = cache.positions
  const isCallerResult = (
    value: ReturnType<typeof resolveQualifiedFolderWorkspaceResult>
  ): value is ReturnType<typeof resolveQualifiedFolderWorkspaceResult<W>> =>
    value.kind !== 'selected' ||
    folders[positions.get(value.value.workspace) ?? -1] === value.value.workspace
  return isCallerResult(result)
    ? result
    : resolveQualifiedFolderWorkspaceResult(state, folderWorkspaceId, executionHostId)
}

const folderWorkspaceWorktreeCache = new WeakMap<FolderWorkspace, Worktree>()
const qualifiedFolderWorktreeCache = new WeakMap<
  FolderWorkspace,
  {
    hostId: ExecutionHostId
    connectionId: string | null
    worktree: Worktree
  }
>()
/** Stable synthetic row per folder workspace object, so selectors keep referential equality. */
export function getFolderWorkspaceWorktree(
  folderWorkspace: FolderWorkspace,
  resolved?: { hostId: ExecutionHostId; connectionId: string | null }
): Worktree {
  if (resolved) {
    const cached = qualifiedFolderWorktreeCache.get(folderWorkspace)
    if (cached?.hostId === resolved.hostId && cached.connectionId === resolved.connectionId) {
      return cached.worktree
    }
    const worktree = folderWorkspaceToWorktree({
      ...folderWorkspace,
      executionHostId: resolved.hostId,
      connectionId: resolved.connectionId
    })
    qualifiedFolderWorktreeCache.set(folderWorkspace, { ...resolved, worktree })
    return worktree
  }
  const cached = folderWorkspaceWorktreeCache.get(folderWorkspace)
  if (cached) {
    return cached
  }
  const worktree = folderWorkspaceToWorktree(folderWorkspace)
  folderWorkspaceWorktreeCache.set(folderWorkspace, worktree)
  return worktree
}
