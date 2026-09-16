import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { WEB_SESSION_GROUP_PREFIX, type WebSessionTabsSyncState } from './state'
import { sanitizeRecentTabIds } from './state-equality-core'

export function chooseTargetGroupId(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): string {
  const groups = state.groupsByWorktree[snapshot.worktree] ?? []
  const layoutGroupIds = collectLayoutGroupIds(state.layoutByWorktree[snapshot.worktree])
  const inRenderedLayout = (groupId: string | null | undefined): boolean =>
    Boolean(groupId && (layoutGroupIds.size === 0 || layoutGroupIds.has(groupId)))
  const preferred =
    groups.find((group) => group.id === snapshot.activeGroupId && inRenderedLayout(group.id)) ??
    groups.find(
      (group) =>
        group.id === state.activeGroupIdByWorktree[snapshot.worktree] && inRenderedLayout(group.id)
    ) ??
    groups.find((group) => inRenderedLayout(group.id))
  // Why: host snapshots can reference desktop-only group ids; the rendered group is the only safe CSS anchor for mirrored panes.
  const firstRenderedLayoutGroupId = layoutGroupIds.values().next().value as string | undefined
  return (
    preferred?.id ??
    firstRenderedLayoutGroupId ??
    snapshot.activeGroupId ??
    `${WEB_SESSION_GROUP_PREFIX}${snapshot.worktree}`
  )
}

export function collectLayoutGroupIds(layout: TabGroupLayoutNode | undefined): Set<string> {
  const result = new Set<string>()
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.add(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

export function buildHostGroupIdByTabId(
  hostGroups: readonly RuntimeMobileSessionTabGroup[] | undefined
): Map<string, string> {
  const result = new Map<string, string>()
  for (const group of hostGroups ?? []) {
    for (const tabId of group.tabOrder) {
      result.set(tabId, group.id)
    }
    if (group.activeTabId) {
      result.set(group.activeTabId, group.id)
    }
  }
  return result
}

export function pruneTabGroupLayout(
  layout: TabGroupLayoutNode | null | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneTabGroupLayout(layout.first, validGroupIds)
  const second = pruneTabGroupLayout(layout.second, validGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

export function dropTabGroupLayoutGroups(
  layout: TabGroupLayoutNode | null,
  excludedGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return excludedGroupIds.has(layout.groupId) ? null : layout
  }
  const first = dropTabGroupLayoutGroups(layout.first, excludedGroupIds)
  const second = dropTabGroupLayoutGroups(layout.second, excludedGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

export function appendTabGroupLayout(
  first: TabGroupLayoutNode | null,
  second: TabGroupLayoutNode | null
): TabGroupLayoutNode | null {
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  // Why: a group already placed by `first` must not gain a second leaf — two
  // leaves for one group render the same tab strip in two columns, and each
  // later snapshot appends another copy.
  const appended = dropTabGroupLayoutGroups(second, collectLayoutGroupIds(first))
  if (!appended) {
    return first
  }
  return {
    type: 'split',
    direction: 'horizontal',
    first,
    second: appended
  }
}

export function tabGroupLayoutEqual(
  a: TabGroupLayoutNode | null | undefined,
  b: TabGroupLayoutNode | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  if (a.type !== b.type) {
    return false
  }
  if (a.type === 'leaf') {
    return b.type === 'leaf' && a.groupId === b.groupId
  }
  return (
    b.type === 'split' &&
    a.direction === b.direction &&
    a.ratio === b.ratio &&
    tabGroupLayoutEqual(a.first, b.first) &&
    tabGroupLayoutEqual(a.second, b.second)
  )
}

export function mapHostRecentTabIds(
  recentTabIds: readonly string[] | undefined,
  hostToLocalTabId: ReadonlyMap<string, string>,
  tabOrder: readonly string[]
): string[] {
  if (!recentTabIds || recentTabIds.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  return sanitizeRecentTabIds(
    recentTabIds.map((tabId) => hostToLocalTabId.get(tabId) ?? '').filter(Boolean),
    [...valid]
  )
}
