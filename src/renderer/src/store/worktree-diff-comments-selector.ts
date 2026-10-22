import type { DiffComment } from '../../../shared/diff-comment-types'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import { getIndexedWorktreeById } from './worktree-repo-index'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { namedHostForOwnerRef } from '@/lib/resolve-owner'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from './workspace-record-selectors'

const EMPTY_DIFF_COMMENTS = Object.freeze([]) as unknown as DiffComment[]

type DiffCommentSelectorState = Pick<AppState, 'worktreesByRepo'> &
  Partial<
    Pick<
      AppState,
      | 'activeWorkspaceExecutionHostId'
      | 'activeWorktreeId'
      | 'folderWorkspaces'
      | 'projectGroups'
      | 'restoredRuntimeHostIdByWorkspaceSessionKey'
      | 'runtimeEnvironments'
      | 'settings'
    >
  >

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

/**
 * The rows whose review notes a change reads or writes. With one host publishing the id, every
 * row of it is the one worktree, exactly as before twins existed. With two, a twin is picked by, in order: the twin a queued write captured; the one twin holding the notes the
 * change names (UUIDs, so an async delivery still finds its copy after navigation); the open
 * workspace's host. Nothing else guesses.
 */
export function findDiffCommentRows(
  state: Pick<
    DiffCommentSelectorState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  worktreeId: string,
  hint: { twin?: DiffCommentTwin; hostId?: ExecutionHostId; commentIds?: ReadonlySet<string> } = {}
): DiffCommentRows | null {
  const rows = (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (row) => row.id === worktreeId
  )
  const { twin: captured, commentIds } = hint
  if (captured) {
    const exact = rows.filter((row) => isTwin(row, captured))
    // Why: a listing may since have stamped an unstamped row with the very host its write names.
    // With no host named, only a lone copy can be the one that gained a stamp.
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
    return worktrees.length > 0 ? { twin: captured, worktrees } : null
  }
  if (rows.length === 0) {
    return null
  }
  const pickTwin = (row: Worktree | undefined, named?: ExecutionHostId): DiffCommentRows | null => {
    if (!row) {
      return null
    }
    const twin = twinOf(row)
    // Why: an unstamped row the selection names is on that host; one only its notes name has no
    // host to say, and a host-less write would be routed by whatever workspace is open.
    const hostId = diffCommentTwinHostId(twin) ?? named
    return hostId
      ? { twin, hostId, worktrees: rows.filter((candidate) => isTwin(candidate, twin)) }
      : null
  }
  if (rows.every((row) => isTwin(row, twinOf(rows[0])))) {
    // Why the stamp even without a twin: main refuses a host-less write while the repo has twins.
    // The identity too, so a queued save never reads a copy listed after it.
    const twin = twinOf(rows[0])
    const hostId = diffCommentTwinHostId(twin)
    // Why: the open workspace naming another host means its copy isn't listed yet (e.g. a restore
    // ahead of its host's listing); this copy's stamp says it is not that one. Notes it holds still
    // name it, and an unstamped row has unknown provenance, not another host's.
    const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
    const holdsNamedNotes = rows.some((row) => row.diffComments?.some((c) => commentIds?.has(c.id)))
    const owner = named
      ? findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(state), worktreeId, named)
      : null
    if (named && twin.hostId && !holdsNamedNotes && !rows.some((row) => row === owner)) {
      return null
    }
    return { twin, ...(hostId ? { hostId } : {}), worktrees: rows }
  }
  const holders = commentIds?.size
    ? rows.filter((row) => row.diffComments?.some((comment) => commentIds.has(comment.id)))
    : []
  if (holders.length > 0 && holders.every((row) => isTwin(row, twinOf(holders[0])))) {
    return pickTwin(holders[0])
  }
  const named = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  const owner = named
    ? findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(state), worktreeId, named)
    : null
  return pickTwin(
    rows.find((row) => row === owner),
    named ?? undefined
  )
}

/** The notes of those rows; the last duplicate wins, as in the id index the rest of the app reads. */
export function diffCommentRowNotes(found: {
  worktrees: readonly Worktree[]
}): DiffComment[] | undefined {
  return found.worktrees.at(-1)?.diffComments
}

/**
 * What a queued write sends. The rows still holding the list its chain last produced are its copy
 * whatever stamps or twins a listing added since; after an out-of-band replacement, its twin's rows
 * (or the id's, if it was never a twin) as the owner lookup now finds them.
 */
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

/** The list a change naming these notes would edit; see {@link findDiffCommentRows}. */
export function readDiffCommentsForChange(
  state: DiffCommentSelectorState,
  worktreeId: string,
  commentIds: Iterable<string>
): DiffComment[] {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return findFolderWorkspaceOwner(state, scope.folderWorkspaceId)?.diffComments ?? []
  }
  const found = findDiffCommentRows(state, worktreeId, { commentIds: new Set(commentIds) })
  return (found && diffCommentRowNotes(found)) ?? []
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
  // Why: the open twin's own notes; an unnamed twin still reads its first copy, as writes refuse it.
  // Mounted surfaces rerun this on every store write, so only the open workspace scans its bucket;
  // the rest share the immutable-snapshot id index.
  const open = namedHostForOwnerRef(state, { workspaceId: worktreeId })
    ? findDiffCommentRows(state, worktreeId)
    : null
  return open
    ? diffCommentRowNotes(open)
    : getIndexedWorktreeById(selectWorktreesByRepo(state), worktreeId)?.diffComments
}

export function selectWorktreeDiffCommentsOrEmpty(
  state: Parameters<typeof selectWorktreeDiffComments>[0],
  worktreeId: string | null | undefined
): DiffComment[] {
  return selectWorktreeDiffComments(state, worktreeId) ?? EMPTY_DIFF_COMMENTS
}
