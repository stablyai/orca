import type { DiffComment } from '../../../shared/diff-comment-types'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from './workspace-record-selectors'

const EMPTY_DIFF_COMMENTS = Object.freeze([]) as unknown as DiffComment[]

/** Every store field note ownership is resolved from; a write changing none of them changes no owner. */
export const DIFF_COMMENT_OWNER_INPUTS = [
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'repos',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'settings',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const satisfies readonly (keyof AppState)[]

export type DiffCommentSelectorState = Pick<AppState, 'worktreesByRepo'> &
  Partial<Pick<AppState, (typeof DIFF_COMMENT_OWNER_INPUTS)[number]>>

/** One twin of a worktree id, as the owner index tells rows apart: its host and its paired server. */
export type DiffCommentTwin = { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }

function twinOf(row: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>): DiffCommentTwin {
  const runtimeOwnerEnvironmentId = row.runtimeOwnerEnvironmentId?.trim()
  return {
    ...(row.hostId ? { hostId: row.hostId } : {}),
    ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
  }
}

function isTwin(row: Worktree, twin: DiffCommentTwin): boolean {
  const own = twinOf(row)
  return (
    own.hostId === twin.hostId && own.runtimeOwnerEnvironmentId === twin.runtimeOwnerEnvironmentId
  )
}

/** The rows' identity (`twin`) and, whenever they name one, the host the write names. */
export type DiffCommentRows = {
  twin?: DiffCommentTwin
  hostId?: ExecutionHostId
  worktrees: readonly Worktree[]
}

/**
 * The host a twin's write names: a paired server's row goes through that server (rival servers
 * may proxy the same SSH target), else the row's own stamp.
 */
export function diffCommentTwinHostId(twin: DiffCommentTwin): ExecutionHostId | undefined {
  return twin.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(twin.runtimeOwnerEnvironmentId)
    : twin.hostId
}

/** Rollback bookkeeping key: one per twin, so a twin's floor never restores another copy. */
export function diffCommentFloorKey(worktreeId: string, twin: DiffCommentTwin | undefined): string {
  return twin
    ? `${JSON.stringify([twin.hostId ?? null, twin.runtimeOwnerEnvironmentId ?? null])}\0${worktreeId}`
    : worktreeId
}

/** With host twins, pick the captured identity, else the selected host's copy; never guess. Single-host duplicate rows still represent one workspace. */
export function findDiffCommentRows(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  hint: { twin?: DiffCommentTwin; hostId?: ExecutionHostId } = {}
): DiffCommentRows | null {
  const rows = (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (row) => row.id === worktreeId
  )
  const { twin: captured } = hint
  if (captured) {
    const exact = rows.filter((row) => isTwin(row, captured))
    // Listings may add the write’s host stamp; hostless writes can follow a newly stamped row only if all copies agree.
    const sole = rows.length > 0 && rows.every((row) => isTwin(row, twinOf(rows[0])))
    const stamped =
      exact.length > 0 || captured.hostId
        ? []
        : hint.hostId
          ? rows.filter((row) => isTwin(row, { ...captured, hostId: hint.hostId }))
          : sole && twinOf(rows[0]).runtimeOwnerEnvironmentId === captured.runtimeOwnerEnvironmentId
            ? rows
            : []
    const worktrees = exact.length > 0 ? exact : stamped
    return worktrees.length > 0
      ? { twin: captured, hostId: diffCommentTwinHostId(captured) ?? hint.hostId, worktrees }
      : null
  }
  if (rows.length === 0) {
    return null
  }
  const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  const owner = named
    ? findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(state), worktreeId, named)
    : null
  if (rows.every((row) => isTwin(row, twinOf(rows[0])))) {
    // Main refuses hostless writes amid twins; capture identity too so queued saves cannot switch to newly listed copies.
    const twin = twinOf(rows[0])
    const hostId = diffCommentTwinHostId(twin)
    // A differently stamped row is not the selected host’s unlisted copy; unstamped provenance remains unknown.
    if (named && twin.hostId && !rows.some((row) => row === owner)) {
      return null
    }
    return { twin, ...(hostId ? { hostId } : {}), worktrees: rows }
  }
  const row = rows.find((candidate) => candidate === owner)
  if (!row) {
    return null
  }
  const twin = twinOf(row)
  // Selection attributes unstamped rows; notes alone cannot. Hostless writes would follow the currently open workspace.
  const hostId = diffCommentTwinHostId(twin) ?? named ?? undefined
  return hostId
    ? { twin, hostId, worktrees: rows.filter((candidate) => isTwin(candidate, twin)) }
    : null
}

/** The notes of those rows; the last duplicate wins, as in the id index the rest of the app reads. */
export function diffCommentRowNotes(found: {
  worktrees: readonly Worktree[]
}): DiffComment[] | undefined {
  return found.worktrees.at(-1)?.diffComments
}

/** Queued saves follow rows holding the chain’s last list despite new host stamps; after external replacement, resolve the captured twin (or bare ID when never twinned) again. */
export function readQueuedDiffComments(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  chain: { twin?: DiffCommentTwin; hostId?: ExecutionHostId; latest: DiffComment[] | undefined }
): { list: DiffComment[] | undefined } | null {
  const rows = selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []
  if (
    chain.latest &&
    rows.some((row) => row.id === worktreeId && row.diffComments === chain.latest)
  ) {
    return { list: chain.latest }
  }
  const found = findDiffCommentRows(
    state,
    worktreeId,
    chain.twin ? { twin: chain.twin, hostId: chain.hostId } : {}
  )
  return found ? { list: diffCommentRowNotes(found) } : null
}

export function selectWorktreeDiffComments(
  state: DiffCommentSelectorState,
  worktreeId: string | null | undefined
): DiffComment[] | undefined {
  if (!worktreeId) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments
  }
  // Only an identifiable copy shows notes: the selected host's, or the sole one. Another copy's notes would invite writes to it.
  const found = findDiffCommentRows(state, worktreeId)
  return found ? diffCommentRowNotes(found) : undefined
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
