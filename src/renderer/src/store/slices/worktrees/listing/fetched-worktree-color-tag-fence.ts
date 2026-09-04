import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getWorkspaceColorTagIdentity,
  normalizeWorkspaceColorTag
} from '../../../../../../shared/workspace-color-tag'
import { isColorTagPersistencePending } from '../metadata/worktree-meta-persist'
import type { FencedWorktreeMergeArgs } from './worktree-slice-types'

export function preserveConcurrentColorTag<T extends Worktree>(
  incoming: readonly T[],
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean,
  requestStartedAt?: number
): T[] {
  if (!current) {
    return [...incoming]
  }
  // Why an empty snapshot rather than a bail-out: a refresh can begin before this repository has a
  // catalog bucket at all; a row created and colored while it runs still has a write in flight that
  // the listing predates, and the fence must be asked about it.
  const startedRows = (requestStarted ?? []).filter(matchesRefreshHost)
  const currentRows = current.filter(matchesRefreshHost)
  const startedById = new Map(startedRows.map((worktree) => [worktree.id, worktree]))
  const currentById = new Map(currentRows.map((worktree) => [worktree.id, worktree]))
  const startedByIdentity = byIdentity(startedRows)
  const currentByIdentity = byIdentity(currentRows)
  return incoming.map((worktree) => {
    // Why identity first: a folder rename between the snapshot and this merge changes the
    // path-derived id while the row keeps its identity; keyed by id alone both lookups miss and the
    // stale answer lands unfenced. Rows without an identity keep the id lookup.
    const key = worktree.identity?.key
    const started =
      (key === undefined ? undefined : startedByIdentity.get(key)) ?? startedById.get(worktree.id)
    const latest =
      (key === undefined ? undefined : currentByIdentity.get(key)) ?? currentById.get(worktree.id)
    if (!latest) {
      return worktree
    }
    // Why: the maps key by path-derived id, and a checkout deleted and recreated at the same path
    // mid-refresh puts a new occupant under the old id. Its color must not be inherited from the
    // rows that described the previous occupant.
    if (!sameOccupant(worktree, latest, started)) {
      return worktree
    }
    // Why the pending guard: a fetch that started after the assignment but joined a listing
    // captured before it sees started and latest already equal to the new color, so only the
    // in-flight write tells the stale answer apart. Color writes emit no local invalidation, so
    // without this the old tag would stick until an unrelated refresh. A row that entered the store
    // after this refresh began has no start snapshot to diff against, but a write in flight for it
    // is still one this listing predates, so the fence decides for it alone.
    if (
      isColorTagPersistencePending(
        worktree.id,
        latest.hostId,
        requestStartedAt,
        latest.identity?.key,
        // Why `?? null`: the merged row is known, so "no owner" means the desktop lists it, not unknown.
        latest.runtimeOwnerEnvironmentId ?? null,
        normalizeWorkspaceColorTag(worktree.colorTag)
      ) ||
      (started !== undefined && (started.colorTag ?? null) !== (latest.colorTag ?? null))
    ) {
      return { ...worktree, colorTag: latest.colorTag ?? null }
    }
    return worktree
  })
}

function byIdentity(rows: readonly Worktree[]): Map<string, Worktree> {
  const map = new Map<string, Worktree>()
  for (const row of rows) {
    if (row.identity?.key !== undefined) {
      map.set(row.identity.key, row)
    }
  }
  return map
}

/** Rows without identities cannot be told apart and keep the pre-identity behaviour. */
function sameOccupant(
  incoming: Worktree,
  latest: Worktree,
  started: Worktree | undefined
): boolean {
  const keys = [incoming.identity?.key, latest.identity?.key, started?.identity?.key]
  const known = keys.filter((key): key is string => key !== undefined)
  return known.every((key) => key === known[0])
}

// The earliest moment this data could have been captured: the shared scan's start when the caller
// joined one, else the caller's own. A write that landed between the two must still be fenced.
export function fenceStartedAt(args: FencedWorktreeMergeArgs): number | undefined {
  const scan = args.refresh.startedAt
  const caller = args.requestStartedAt
  if (scan === undefined || caller === undefined) {
    return scan ?? caller
  }
  return Math.min(scan, caller)
}

/**
 * Visible rows plus any detected-only rows for the same repository. Why: a workspace that exists
 * only in the detected catalog — a hidden external worktree colored from the Agent Map — has no
 * row in the visible list, so a fence fed only that list cannot find it and lets a stale listing
 * undo its assignment. Deduplicated by color-tag identity, never by bare id: a visible row on host
 * A and a detected-only row on host B can share a path-derived id, and dropping B here would leave
 * a B refresh without the snapshot it needs.
 */
export function withDetectedOnlyRows(
  visible: readonly Worktree[] | undefined,
  detected: readonly Worktree[] | undefined
): readonly Worktree[] | undefined {
  if (!detected || detected.length === 0) {
    return visible
  }
  const seen = new Set((visible ?? []).map((worktree) => getWorkspaceColorTagIdentity(worktree)))
  return [
    ...(visible ?? []),
    ...detected.filter((worktree) => !seen.has(getWorkspaceColorTagIdentity(worktree)))
  ]
}
