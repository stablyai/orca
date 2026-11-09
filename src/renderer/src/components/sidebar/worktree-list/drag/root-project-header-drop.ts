import { measureSidebarHeaderDragRect } from './sidebar-header-drag-geometry'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  compareRootProjectEntries,
  getRootProjectEntryKey,
  getRootProjectEntryRank,
  type RootProjectEntry
} from '../../../../../../shared/root-project-order'
import { getDistinctProjectGroups } from '../../../../../../shared/project-groups'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'

export type RootProjectHeaderDrag = {
  rootProjectHeaderKeys?: readonly string[]
  onCommitRootProjectOrder?: (
    visibleKeys: readonly string[],
    draggedKey: string,
    dropIndex: number
  ) => void
}

export function getRootProjectHeaderDragKeys(
  keys: readonly string[] | undefined,
  draggedKey: string,
  hostId?: string
): readonly string[] | undefined {
  if (!keys?.includes(draggedKey)) {
    return undefined
  }
  const hostIndex = hostId === undefined ? -1 : keys.indexOf(`host:${hostId}`)
  if (hostIndex >= 0) {
    let end = hostIndex + 1
    while (end < keys.length && !keys[end].startsWith('host:')) {
      end += 1
    }
    const section = keys.slice(hostIndex + 1, end)
    return section.includes(draggedKey) ? section : undefined
  }
  const index = keys.indexOf(draggedKey)
  let start = index
  let end = index + 1
  while (start > 0 && !keys[start - 1].startsWith('host:')) {
    start -= 1
  }
  while (end < keys.length && !keys[end].startsWith('host:')) {
    end += 1
  }
  return keys.slice(start, end)
}

export function getRootProjectHeaderKey(row: GroupHeaderRow): string | undefined {
  if ((row.projectGroupDepth ?? 0) !== 0) {
    return undefined
  }
  const repo = row.repo && (row.anchorRepo ?? row.repo)
  return repo
    ? `repo:${repo.id}`
    : row.projectGroup?.id
      ? `group:${row.projectGroup.id}`
      : undefined
}

export function getSidebarRootProjectHeaderKeys(rows: readonly HostSectionRow[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.type === 'host-header') {
      keys.push(`host:${row.hostId}`)
      seen.clear()
      continue
    }
    if (row.type !== 'header') {
      continue
    }
    const key = getRootProjectHeaderKey(row)
    if (key && !seen.has(key)) {
      keys.push(key)
      seen.add(key)
    }
  }
  return keys
}

export function getRootProjectHeaderOccurrenceKey(key: string, hostId?: string): string {
  return JSON.stringify([hostId ?? '', key])
}

export function getRootProjectHeaderCountByOccurrenceKey(
  keys: readonly string[] | undefined
): Map<string, number> {
  const counts = new Map<string, number>()
  if (!keys) {
    return counts
  }
  let start = 0
  let hostId: string | undefined
  for (let end = 0; end <= keys.length; end += 1) {
    if (end < keys.length && !keys[end].startsWith('host:')) {
      continue
    }
    for (let index = start; index < end; index += 1) {
      counts.set(getRootProjectHeaderOccurrenceKey(keys[index], hostId), end - start)
    }
    hostId = keys[end]?.slice('host:'.length)
    start = end + 1
  }
  return counts
}

export function measureRootProjectHeaderDragRects(
  container: HTMLElement,
  keys: readonly string[],
  hostId?: string
) {
  const indexByKey = new Map(keys.map((key, index) => [key, index]))
  const containerRect = container.getBoundingClientRect()
  return [...container.querySelectorAll<HTMLElement>('[data-root-project-header-key]')]
    .flatMap((element) => {
      if (hostId !== undefined && element.dataset.rootProjectHeaderHost !== hostId) {
        return []
      }
      const key = element.dataset.rootProjectHeaderKey
      const headerIndex = key === undefined ? undefined : indexByKey.get(key)
      if (key === undefined || headerIndex === undefined) {
        return []
      }
      return [
        {
          key,
          headerIndex,
          bucketKey: 'root',
          ...measureSidebarHeaderDragRect(
            element,
            container,
            containerRect,
            'data-root-project-header-section-end'
          )
        }
      ]
    })
    .sort((left, right) => left.top - right.top)
}

export function getRootProjectOrderForSidebarDrop(args: {
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  visibleKeys: readonly string[]
  draggedKey: string
  dropIndex: number
}): RootProjectEntry[] {
  const sourceIndex = args.visibleKeys.indexOf(args.draggedKey)
  if (sourceIndex === -1 || args.dropIndex === sourceIndex || args.dropIndex === sourceIndex + 1) {
    return []
  }
  const groups = getDistinctProjectGroups(args.projectGroups)
  const groupIds = new Set(groups.map((group) => group.id))
  const repos = new Map<string, Repo>()
  for (const repo of args.repos) {
    if (!repos.has(repo.id) && (!repo.projectGroupId || !groupIds.has(repo.projectGroupId))) {
      repos.set(repo.id, repo)
    }
  }
  const entries: RootProjectEntry[] = [
    ...groups
      .filter((group) => !group.parentGroupId || !groupIds.has(group.parentGroupId))
      .map((group) => ({ kind: 'group' as const, group })),
    ...[...repos.values()].map((repo) => ({ kind: 'repo' as const, repo }))
  ]
  const repoOrder = getLogicalRepoOrderRankById(args.repos.map((repo) => repo.id))
  entries.sort((left, right) => compareRootProjectEntries(left, right, repoOrder))
  const dragged = entries.find((entry) => getRootProjectEntryKey(entry) === args.draggedKey)
  if (!dragged) {
    return []
  }
  const remaining = entries.filter((entry) => entry !== dragged)
  const beforeKey = args.visibleKeys[args.dropIndex]
  const afterKey = args.visibleKeys[args.dropIndex - 1]
  const beforeIndex = remaining.findIndex((entry) => getRootProjectEntryKey(entry) === beforeKey)
  const afterIndex = remaining.findIndex((entry) => getRootProjectEntryKey(entry) === afterKey)
  const insertAt = beforeIndex !== -1 ? beforeIndex : afterIndex !== -1 ? afterIndex + 1 : -1
  if (insertAt < 0) {
    return []
  }
  remaining.splice(insertAt, 0, dragged)
  return remaining
}

function getMovedRankUpdates<T>(
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
      return new Map(entries.map((entry, index) => [entry, index * 1000]))
    }
    previous = value
    updates.set(entries[index + offset], value)
  }
  return updates
}

export function getRootProjectOrderUpdatesForSidebarDrop(
  args: Parameters<typeof getRootProjectOrderForSidebarDrop>[0]
): {
  entry: RootProjectEntry
  rootProjectOrder?: number
  tabOrder?: number
}[] {
  const entries = getRootProjectOrderForSidebarDrop(args)
  const dragged = entries.find((entry) => getRootProjectEntryKey(entry) === args.draggedKey)
  if (!dragged) {
    return []
  }
  const repoOrder = getLogicalRepoOrderRankById(args.repos.map((repo) => repo.id))
  const draggedIndex = entries.indexOf(dragged)
  const staysLegacyGroup =
    dragged.kind === 'group' &&
    dragged.group.rootProjectOrder === undefined &&
    (draggedIndex === 0 ||
      getRootProjectEntryRank(entries[draggedIndex - 1], repoOrder) === Number.NEGATIVE_INFINITY)
  const ranks = staysLegacyGroup
    ? new Map<RootProjectEntry, number>()
    : getMovedRankUpdates(entries, dragged, (entry) => getRootProjectEntryRank(entry, repoOrder))
  const groups = entries.filter((entry) => entry.kind === 'group')
  const tabRanks =
    dragged.kind === 'group'
      ? getMovedRankUpdates(groups, dragged, (entry) => entry.group.tabOrder)
      : new Map<RootProjectEntry, number>()
  return entries.flatMap((entry) => {
    const rootProjectOrder = ranks.get(entry)
    const tabOrder = tabRanks.get(entry)
    return rootProjectOrder === undefined && tabOrder === undefined
      ? []
      : [{ entry, rootProjectOrder, tabOrder }]
  })
}
