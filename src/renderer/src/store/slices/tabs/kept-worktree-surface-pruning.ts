import type { AppState } from '../../types'
import { toVisibleTabType, type Tab, type TabGroup } from '../../../../../shared/tab-types'
import { sanitizeRecentTabIds } from './tab-selection-history'
import type { RecordDraft } from '../../keyed-record-transitions'

/** Surfaces leaving workspaces that stay, such as one host's tabs under an id its twin publishes. */
export type KeptWorktreeSurfaceRemoval = {
  worktreeIds: ReadonlySet<string>
  terminalTabIds: ReadonlySet<string>
  fileIds: ReadonlySet<string>
  browserTabIds: ReadonlySet<string>
  /** Unified tab ids of non-file surfaces such as chats. */
  unifiedTabIds: ReadonlySet<string>
}

function isRemovedUnifiedTab(tab: Tab, removed: KeptWorktreeSurfaceRemoval): boolean {
  if (removed.unifiedTabIds.has(tab.id)) {
    return true
  }
  if (tab.contentType === 'terminal') {
    return removed.terminalTabIds.has(tab.entityId)
  }
  if (tab.contentType === 'browser') {
    return removed.browserTabIds.has(tab.entityId)
  }
  return toVisibleTabType(tab.contentType) === 'editor' && removed.fileIds.has(tab.entityId)
}

function pruneGroup(group: TabGroup, removedIds: ReadonlySet<string>): TabGroup {
  if (!group.tabOrder.some((id) => removedIds.has(id))) {
    return group
  }
  const tabOrder = group.tabOrder.filter((id) => !removedIds.has(id))
  const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, tabOrder)
  // Why MRU first: closing the active tab lands on the previously active one, as closeUnifiedTab does.
  const activeTabId =
    group.activeTabId && removedIds.has(group.activeTabId)
      ? (recentTabIds.at(-1) ?? tabOrder[0] ?? null)
      : group.activeTabId
  return {
    ...group,
    tabOrder,
    activeTabId,
    ...(group.recentTabIds ? { recentTabIds } : {})
  }
}

/** Rewrites only the kept workspaces' entries, keeping the map's identity when none changes. */
function pruneEntries<T>(
  map: Record<string, T>,
  worktreeIds: ReadonlySet<string>,
  prune: (value: T) => T | undefined
): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const worktreeId of worktreeIds) {
    if (!(worktreeId in map)) {
      continue
    }
    const value = prune(map[worktreeId])
    if (value === map[worktreeId]) {
      continue
    }
    next ??= { ...map }
    if (value === undefined) {
      delete next[worktreeId]
    } else {
      next[worktreeId] = value
    }
  }
  return next ?? map
}

/** pruneEntries as draft operations, for seam records whose entries are never undefined. */
export function pruneKeptEntries<T>(
  draft: RecordDraft<T>,
  worktreeIds: ReadonlySet<string>,
  prune: (value: T) => T
): void {
  for (const worktreeId of worktreeIds) {
    const current = draft.get(worktreeId)
    if (current !== undefined) {
      draft.set(worktreeId, prune(current))
    }
  }
}

function withoutIds<T extends { id: string }>(items: T[], ids: ReadonlySet<string>): T[] {
  return items.some((item) => ids.has(item.id)) ? items.filter((item) => !ids.has(item.id)) : items
}

/** Per-field pruners for workspaces that stay while some of their surfaces leave. */
export function createKeptWorktreeSurfacePruners(
  s: Pick<AppState, 'unifiedTabsByWorktree'>,
  removed: KeptWorktreeSurfaceRemoval
) {
  const { worktreeIds } = removed
  const removedUnifiedIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (s.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => isRemovedUnifiedTab(tab, removed))
        .map((tab) => tab.id)
    )
  )
  const removedIds = new Set([
    ...removedUnifiedIds,
    ...removed.terminalTabIds,
    ...removed.fileIds,
    ...removed.browserTabIds
  ])
  // Why dropped, not repointed: selection derivation falls back to a surviving surface.
  const dropSelectionOf =
    <T>(ids: ReadonlySet<string>) =>
    (map: Record<string, T>): Record<string, T> =>
      pruneEntries(map, worktreeIds, (value) =>
        typeof value === 'string' && ids.has(value) ? undefined : value
      )
  const pruneGroups = (groups: TabGroup[]): TabGroup[] => {
    const next = groups.map((group) => pruneGroup(group, removedIds))
    return next.every((group, index) => group === groups[index]) ? groups : next
  }
  return {
    /** Seam records prune through draft operations; see pruneKeptEntries. */
    entries: {
      tabs: (tabs: AppState['tabsByWorktree'][string]) => withoutIds(tabs, removed.terminalTabIds),
      unifiedTabs: (tabs: Tab[]) => withoutIds(tabs, removedUnifiedIds),
      groups: pruneGroups
    },
    unifiedTabs: (map: AppState['unifiedTabsByWorktree']) =>
      pruneEntries(map, worktreeIds, (tabs) => withoutIds(tabs, removedUnifiedIds)),
    tabBarOrder: (map: AppState['tabBarOrderByWorktree']) =>
      pruneEntries(map, worktreeIds, (order) =>
        order.some((id) => removedIds.has(id)) ? order.filter((id) => !removedIds.has(id)) : order
      ),
    browserTabs: (map: AppState['browserTabsByWorktree']) =>
      pruneEntries(map, worktreeIds, (tabs) => withoutIds(tabs, removed.browserTabIds)),
    files: (files: AppState['openFiles']) => withoutIds(files, removed.fileIds),
    activeTabIds: dropSelectionOf<AppState['activeTabIdByWorktree'][string]>(
      removed.terminalTabIds
    ),
    activeFileIds: dropSelectionOf<AppState['activeFileIdByWorktree'][string]>(removed.fileIds),
    activeBrowserTabIds: dropSelectionOf<AppState['activeBrowserTabIdByWorktree'][string]>(
      removed.browserTabIds
    )
  }
}
