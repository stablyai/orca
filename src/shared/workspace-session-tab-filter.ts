/**
 * A saved session with some tab-bar tabs removed, and everything that named them made consistent:
 * groups lose them (a group they emptied goes, with its layout leaf), and per-workspace focus on a
 * removed tab or group moves to what is left. Terminal rows and layouts are left to the caller.
 */
import type { Tab, TabGroup } from './tab-types'
import { toVisibleTabType } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { pruneGroupLayout } from './workspace-session-terminal-tab-close'

export function filterWorkspaceSessionTabs(
  session: WorkspaceSessionState,
  keepTab: (owner: string, tab: Tab) => boolean
): WorkspaceSessionState {
  const removedByOwner = new Map<string, Set<string>>()
  const keptTypesByOwner = new Map<string, Set<string>>()
  const unifiedTabs: Record<string, Tab[]> = {}
  for (const [owner, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    const kept = tabs.filter((tab) => keepTab(owner, tab))
    unifiedTabs[owner] = kept.length === tabs.length ? tabs : kept
    if (kept.length !== tabs.length) {
      const keptIds = new Set(kept.map((tab) => tab.id))
      removedByOwner.set(
        owner,
        new Set(tabs.filter((tab) => !keptIds.has(tab.id)).map((tab) => tab.id))
      )
      keptTypesByOwner.set(owner, new Set(kept.map((tab) => toVisibleTabType(tab.contentType))))
    }
  }
  if (removedByOwner.size === 0) {
    return session
  }
  const tabGroups = mapOwners(session.tabGroups, removedByOwner, (groups, removed) =>
    groups.flatMap((group) => {
      const kept = withoutTabs(group, removed)
      return kept.tabOrder.length === 0 && group.tabOrder.length > 0 ? [] : [kept]
    })
  )
  const groupIds = (owner: string): Set<string> =>
    new Set((tabGroups?.[owner] ?? []).map((group) => group.id))
  return {
    ...session,
    unifiedTabs,
    ...(tabGroups ? { tabGroups } : {}),
    ...(session.tabGroupLayouts
      ? {
          tabGroupLayouts: filterOwners(session.tabGroupLayouts, removedByOwner, (layout, owner) =>
            pruneGroupLayout(layout, groupIds(owner))
          )
        }
      : {}),
    ...(session.activeGroupIdByWorktree
      ? {
          activeGroupIdByWorktree: filterOwners(
            session.activeGroupIdByWorktree,
            removedByOwner,
            (groupId, owner) => {
              const ids = groupIds(owner)
              return ids.has(groupId) ? groupId : ids.values().next().value
            }
          )
        }
      : {}),
    ...(session.activeTabIdByWorktree
      ? {
          activeTabIdByWorktree: filterOwners(
            session.activeTabIdByWorktree,
            removedByOwner,
            (tabId, owner) => (tabId && removedByOwner.get(owner)?.has(tabId) ? undefined : tabId)
          )
        }
      : {}),
    ...(session.activeTabTypeByWorktree
      ? {
          activeTabTypeByWorktree: filterOwners(
            session.activeTabTypeByWorktree,
            removedByOwner,
            (type, owner) => (keptTypesByOwner.get(owner)?.has(type) ? type : undefined)
          )
        }
      : {})
  }
}

function withoutTabs(group: TabGroup, tabIds: ReadonlySet<string>): TabGroup {
  const tabOrder = group.tabOrder.filter((id) => !tabIds.has(id))
  const recentTabIds = group.recentTabIds?.filter((id) => !tabIds.has(id))
  const activeTabId =
    group.activeTabId && !tabIds.has(group.activeTabId)
      ? group.activeTabId
      : (recentTabIds?.at(-1) ?? tabOrder.at(-1) ?? null)
  return { ...group, tabOrder, activeTabId, ...(recentTabIds ? { recentTabIds } : {}) }
}

/** Each owner that lost tabs mapped; the rest as they were. */
function mapOwners<T>(
  record: Record<string, T> | undefined,
  removedByOwner: ReadonlyMap<string, ReadonlySet<string>>,
  map: (value: T, removed: ReadonlySet<string>) => T
): Record<string, T> | undefined {
  if (!record) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(record).map(([owner, value]) => {
      const removed = removedByOwner.get(owner)
      return [owner, removed ? map(value, removed) : value]
    })
  )
}

/** Like `mapOwners`, but an owner mapped to nothing is dropped. */
function filterOwners<T>(
  record: Record<string, T>,
  removedByOwner: ReadonlyMap<string, ReadonlySet<string>>,
  map: (value: T, owner: string) => T | null | undefined
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([owner, value]) => {
      if (!removedByOwner.has(owner) || value === null) {
        return [[owner, value]]
      }
      const mapped = map(value, owner)
      return mapped === undefined || mapped === null ? [] : [[owner, mapped]]
    })
  )
}
