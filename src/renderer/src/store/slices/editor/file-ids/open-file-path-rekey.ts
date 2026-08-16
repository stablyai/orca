import type { AppState } from '../../../types'
import type { TabGroup } from '../../../../../../shared/tab-types'
import { pruneTabGroupLayoutForGroups } from '../../tabs-hydration'

export function rekeyFileIdRecord<T>(
  record: Record<string, T>,
  migrations: ReadonlyMap<string, string>
): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const mapped = migrations.get(key)
    if (mapped !== undefined && mapped !== key) {
      next[mapped] = value
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : record
}

export function nextActiveIdAfterRemoval(
  ids: readonly string[],
  recentIds: readonly string[] | undefined,
  removedIds: ReadonlySet<string>
): string | null {
  const recent = (recentIds ?? []).toReversed().find((id) => !removedIds.has(id))
  return recent ?? ids.find((id) => !removedIds.has(id)) ?? null
}

export function removeEmptyEditorGroups(
  previousGroups: TabGroup[],
  groups: TabGroup[],
  movedTabIds: ReadonlySet<string>,
  layout: AppState['layoutByWorktree'][string] | undefined
): { groups: TabGroup[]; layout: AppState['layoutByWorktree'][string] | undefined } {
  const emptiedGroupIds = new Set(
    previousGroups
      .filter(
        (group) =>
          group.tabOrder.some((id) => movedTabIds.has(id)) &&
          groups.find((candidate) => candidate.id === group.id)?.tabOrder.length === 0
      )
      .map((group) => group.id)
  )
  const remaining = groups.filter((group) => !emptiedGroupIds.has(group.id))
  if (remaining.length === 0) {
    return { groups: [], layout: undefined }
  }
  const validIds = new Set(remaining.map((group) => group.id))
  return {
    groups: remaining,
    layout: layout ? (pruneTabGroupLayoutForGroups(layout, validIds) ?? undefined) : undefined
  }
}
