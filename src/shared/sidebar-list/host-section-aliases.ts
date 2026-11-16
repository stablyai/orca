import type { ExecutionHostId } from '../execution-host'
import type { Repo } from '../repository/repo-types'
import type { Row } from './row-types'

type MergedHost = { id: ExecutionHostId; mergedIntoHostId?: ExecutionHostId }

/**
 * Host ids that share one section: a merged-away host (a managed server's SSH route, or one Orca
 * Cloud sandbox among several) resolves to the row that stands for it. Null when nothing merges.
 */
export function createHostSectionResolver(
  hosts: readonly MergedHost[]
): ((hostId: ExecutionHostId) => ExecutionHostId) | null {
  const shownById = new Map<ExecutionHostId, ExecutionHostId>()
  for (const host of hosts) {
    if (host.mergedIntoHostId) {
      shownById.set(host.id, host.mergedIntoHostId)
    }
  }
  return shownById.size > 0 ? (hostId) => shownById.get(hostId) ?? hostId : null
}

function rekeyCounts(
  map: ReadonlyMap<ExecutionHostId, number> | undefined,
  resolve: (hostId: ExecutionHostId) => ExecutionHostId
): ReadonlyMap<ExecutionHostId, number> | undefined {
  if (!map) {
    return map
  }
  const next = new Map<ExecutionHostId, number>()
  for (const [hostId, count] of map) {
    const shown = resolve(hostId)
    next.set(shown, (next.get(shown) ?? 0) + count)
  }
  return next
}

function rekeyIds(
  map: ReadonlyMap<ExecutionHostId, readonly string[]> | undefined,
  resolve: (hostId: ExecutionHostId) => ExecutionHostId
): ReadonlyMap<ExecutionHostId, readonly string[]> | undefined {
  if (!map) {
    return map
  }
  const next = new Map<ExecutionHostId, readonly string[]>()
  for (const [hostId, ids] of map) {
    const shown = resolve(hostId)
    next.set(shown, [...(next.get(shown) ?? []), ...ids])
  }
  return next
}

function rekeyRepos(
  map: ReadonlyMap<ExecutionHostId, Repo>,
  resolve: (hostId: ExecutionHostId) => ExecutionHostId
): ReadonlyMap<ExecutionHostId, Repo> {
  const next = new Map<ExecutionHostId, Repo>()
  for (const [hostId, repo] of map) {
    const shown = resolve(hostId)
    // The shown host's own registration names the header; else the first merged one's.
    if (!next.has(shown) || hostId === shown) {
      next.set(shown, repo)
    }
  }
  return next
}

/** A header's per-host maps keyed by section: one project header per section, counts summed. */
export function mergeHeaderHostsIntoSections(
  rows: readonly Row[],
  resolve: (hostId: ExecutionHostId) => ExecutionHostId
): Row[] {
  return rows.map((row) => {
    if (row.type !== 'header' || (!row.hostRepos && !row.hostWorktreeCounts)) {
      return row
    }
    return {
      ...row,
      ...(row.hostRepos ? { hostRepos: rekeyRepos(row.hostRepos, resolve) } : {}),
      ...(row.hostWorktreeCounts
        ? { hostWorktreeCounts: rekeyCounts(row.hostWorktreeCounts, resolve) }
        : {}),
      ...(row.hostWorktreeIds ? { hostWorktreeIds: rekeyIds(row.hostWorktreeIds, resolve) } : {})
    }
  })
}
