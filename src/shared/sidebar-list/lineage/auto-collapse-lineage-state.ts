import { LINEAGE_GROUP_PREFIX } from '../sections/group-keys'

export function isLineageGroupKey(key: string): boolean {
  return key.startsWith(LINEAGE_GROUP_PREFIX)
}

/** Keeps explicit expand overrides disjoint from `collapsedGroups` as lineage folds change. */
export function reconcileExpandedLineageGroupsOnCollapseChange(args: {
  previousCollapsed: ReadonlySet<string>
  nextCollapsed: ReadonlySet<string>
  previousExpanded: ReadonlySet<string>
  trackExplicitExpands: boolean
}): ReadonlySet<string> {
  const { previousCollapsed, nextCollapsed, previousExpanded, trackExplicitExpands } = args
  let nextExpanded: Set<string> | null = null
  const ensureMutable = (): Set<string> => {
    if (!nextExpanded) {
      nextExpanded = new Set(previousExpanded)
    }
    return nextExpanded
  }

  for (const key of previousCollapsed) {
    if (isLineageGroupKey(key) && !nextCollapsed.has(key) && trackExplicitExpands) {
      if (!previousExpanded.has(key)) {
        ensureMutable().add(key)
      }
    }
  }
  for (const key of nextCollapsed) {
    if (isLineageGroupKey(key) && previousExpanded.has(key)) {
      ensureMutable().delete(key)
    }
  }
  return nextExpanded ?? previousExpanded
}

export function reconcileExpandedLineageGroupsList(args: {
  key: string
  collapsed: boolean
  previousExpanded: readonly string[] | undefined
  trackExplicitExpands: boolean
}): string[] | undefined {
  const { key, collapsed, previousExpanded, trackExplicitExpands } = args
  if (!isLineageGroupKey(key)) {
    return undefined
  }
  const current = previousExpanded ?? []
  const hasKey = current.includes(key)
  if (collapsed) {
    return hasKey ? current.filter((candidate) => candidate !== key) : undefined
  }
  if (!trackExplicitExpands || hasKey) {
    return undefined
  }
  return [...current, key]
}

export type AutoCollapseLineageMode = 'seed-existing' | 'collapse-new'

export type AutoCollapseLineageUpdate = {
  collapsedGroups: Set<string>
  expandedLineageGroups: Set<string>
  collapsedChanged: boolean
  expandedChanged: boolean
  addedCollapsedKeys: string[]
}

/** Computes the one-time collapse or initial-seed delta for parents that currently have children. */
export function computeAutoCollapseLineageUpdate(args: {
  parentKeys: Iterable<string>
  protectedParentKeys: ReadonlySet<string>
  collapsedGroups: ReadonlySet<string>
  expandedLineageGroups: ReadonlySet<string>
  mode: AutoCollapseLineageMode
}): AutoCollapseLineageUpdate | null {
  const { parentKeys, protectedParentKeys, collapsedGroups, expandedLineageGroups, mode } = args
  let nextCollapsed: Set<string> | null = null
  let nextExpanded: Set<string> | null = null
  const addedCollapsedKeys: string[] = []

  for (const key of parentKeys) {
    if (!isLineageGroupKey(key)) {
      continue
    }
    if (collapsedGroups.has(key) || expandedLineageGroups.has(key)) {
      continue
    }
    if (mode === 'seed-existing' || protectedParentKeys.has(key)) {
      if (!nextExpanded) {
        nextExpanded = new Set(expandedLineageGroups)
      }
      nextExpanded.add(key)
      continue
    }
    if (!nextCollapsed) {
      nextCollapsed = new Set(collapsedGroups)
    }
    if (!nextCollapsed.has(key)) {
      nextCollapsed.add(key)
      addedCollapsedKeys.push(key)
    }
  }

  if (!nextCollapsed && !nextExpanded) {
    return null
  }
  return {
    collapsedGroups: nextCollapsed ?? new Set(collapsedGroups),
    expandedLineageGroups: nextExpanded ?? new Set(expandedLineageGroups),
    collapsedChanged: nextCollapsed !== null,
    expandedChanged: nextExpanded !== null,
    addedCollapsedKeys
  }
}
