import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRootProjectEntryKey,
  type RootProjectEntry
} from '../../../../../../shared/root-project-order'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'

function getNormalizedCatalogHostId(hostId?: string): string {
  const parsedHostId = parseExecutionHostId(hostId ?? 'local')?.id
  return (parsedHostId ? getCatalogHostIdForExecutionHost(parsedHostId) : null) ?? hostId ?? 'local'
}

export function getMovedRankUpdates<T>(
  entries: readonly T[],
  dragged: T,
  rank: (entry: T) => number
): Map<T, number> {
  const index = entries.indexOf(dragged)
  const lower = index > 0 ? rank(entries[index - 1]) : Number.NEGATIVE_INFINITY
  let end = index + 1
  while (end < entries.length && rank(entries[end]) <= lower) {
    end += 1
  }
  const upper = end < entries.length ? rank(entries[end]) : Number.POSITIVE_INFINITY
  if (end === index + 1 && rank(dragged) > lower && rank(dragged) < upper) {
    return new Map()
  }
  const count = end - index
  const step =
    Number.isFinite(lower) && Number.isFinite(upper) ? (upper - lower) / (count + 1) : 1000
  const first = Number.isFinite(lower)
    ? lower + step
    : Number.isFinite(upper)
      ? upper - step * count
      : 0
  const updates = new Map<T, number>()
  let previous = lower
  for (let offset = 0; offset < count; offset += 1) {
    const value = first + step * offset
    if (!Number.isFinite(value) || value <= previous || value >= upper) {
      return new Map(entries.map((entry, entryIndex) => [entry, entryIndex * 1000]))
    }
    previous = value
    updates.set(entries[index + offset], value)
  }
  return updates
}

export function filterRootEntriesToDraggedHostSection(args: {
  entries: readonly RootProjectEntry[]
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  visibleKeys: readonly string[]
  draggedKey: string
  hostId?: string
}): RootProjectEntry[] {
  const groupIds = new Set(args.projectGroups.map((group) => group.id))
  const ownerHostsByKey = new Map<string, Set<string>>()
  const addHost = (key: string, hostId: string): void => {
    const hosts = ownerHostsByKey.get(key) ?? new Set<string>()
    hosts.add(hostId)
    ownerHostsByKey.set(key, hosts)
  }
  for (const group of args.projectGroups) {
    if (!group.parentGroupId || !groupIds.has(group.parentGroupId)) {
      addHost(`group:${group.id}`, getNormalizedCatalogHostId(getRepoExecutionHostId(group)))
    }
  }
  for (const repo of args.repos) {
    if (!repo.projectGroupId || !groupIds.has(repo.projectGroupId)) {
      addHost(`repo:${repo.id}`, getNormalizedCatalogHostId(getRepoExecutionHostId(repo)))
    }
  }

  let sectionHostIds: Set<string>
  if (args.hostId !== undefined) {
    sectionHostIds = new Set([getNormalizedCatalogHostId(args.hostId)])
  } else {
    let intersection: Set<string> | undefined
    const union = new Set<string>()
    for (const key of args.visibleKeys) {
      const hosts = ownerHostsByKey.get(key)
      if (!hosts || hosts.size === 0) {
        continue
      }
      for (const host of hosts) {
        union.add(host)
      }
      intersection = intersection
        ? new Set([...intersection].filter((host) => hosts.has(host)))
        : new Set(hosts)
    }
    sectionHostIds =
      intersection && intersection.size > 0
        ? intersection
        : union.size > 0
          ? union
          : (ownerHostsByKey.get(args.draggedKey) ?? new Set())
  }

  const visibleKeySet = new Set(args.visibleKeys)
  return args.entries.filter((entry) => {
    const key = getRootProjectEntryKey(entry)
    if (visibleKeySet.has(key)) {
      return true
    }
    const hosts = ownerHostsByKey.get(key)
    if (!hosts) {
      return false
    }
    for (const host of hosts) {
      if (sectionHostIds.has(host)) {
        return true
      }
    }
    return false
  })
}
