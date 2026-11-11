import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { workspaceRootGroupId } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { replaceRecordEntries, replaceTabBuckets } from '../../keyed-record-transitions'

export function findTabAndWorktree(
  tabsByWorktree: Record<string, Tab[]>,
  tabId: string
): { tab: Tab; worktreeId: string } | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      return { tab, worktreeId }
    }
  }
  return null
}

export function findGroupForTab(
  groupsByWorktree: Record<string, TabGroup[]>,
  worktreeId: string,
  groupId: string
): TabGroup | null {
  const groups = groupsByWorktree[worktreeId] ?? []
  return groups.find((g) => g.id === groupId) ?? null
}

export function findGroupAndWorktree(
  groupsByWorktree: Record<string, TabGroup[]>,
  groupId: string
): { group: TabGroup; worktreeId: string } | null {
  for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
    const group = groups.find((candidate) => candidate.id === groupId)
    if (group) {
      return { group, worktreeId }
    }
  }
  return null
}

export function findTabByEntityInGroup(
  tabsByWorktree: Record<string, Tab[]>,
  worktreeId: string,
  groupId: string,
  entityId: string,
  contentType?: Tab['contentType']
): Tab | null {
  const tabs = tabsByWorktree[worktreeId] ?? []
  return (
    tabs.find(
      (tab) =>
        tab.groupId === groupId &&
        tab.entityId === entityId &&
        (contentType ? tab.contentType === contentType : true)
    ) ?? null
  )
}

export function ensureGroup(
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string>,
  worktreeId: string,
  preferredGroupId?: string
): {
  group: TabGroup
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
} {
  const { group, created } = ensureWorktreeGroup(
    groupsByWorktree[worktreeId],
    worktreeId,
    preferredGroupId
  )
  if (!created) {
    return { group, groupsByWorktree, activeGroupIdByWorktree }
  }
  return {
    group,
    groupsByWorktree: replaceRecordEntries(groupsByWorktree, [[worktreeId, [group]]]),
    activeGroupIdByWorktree: replaceRecordEntries(activeGroupIdByWorktree, [[worktreeId, group.id]])
  }
}

/** ensureGroup for one worktree's groups; a created group becomes the worktree's only and active group. */
export function ensureWorktreeGroup(
  groups: TabGroup[] | undefined,
  worktreeId: string,
  preferredGroupId?: string
): { group: TabGroup; created: boolean } {
  const existing = groups?.find((group) => group.id === preferredGroupId) ?? groups?.[0]
  if (existing) {
    return { group: existing, created: false }
  }
  // Switch point: the root group id main and the Loader mint for a workspace with no group.
  const groupId = ORCA_LAYOUT_OWNER_IS_MAIN ? workspaceRootGroupId(worktreeId) : createBrowserUuid()
  return { group: { id: groupId, worktreeId, activeTabId: null, tabOrder: [] }, created: true }
}

export function updateGroup(groups: TabGroup[], updated: TabGroup): TabGroup[] {
  return groups.map((g) => (g.id === updated.id ? updated : g))
}

/** Patch one tab; return null if absent so callers can return {} to Zustand. */
export function patchTab(
  tabsByWorktree: Record<string, Tab[]>,
  tabId: string,
  patch: Partial<Tab>
): { unifiedTabsByWorktree: Record<string, Tab[]> } | null {
  const found = findTabAndWorktree(tabsByWorktree, tabId)
  if (!found) {
    return null
  }
  const patchChangesTab = (Object.keys(patch) as (keyof Tab)[]).some(
    (key) => found.tab[key] !== patch[key]
  )
  if (!patchChangesTab) {
    return null
  }
  const { worktreeId } = found
  const tabs = tabsByWorktree[worktreeId] ?? []
  return {
    unifiedTabsByWorktree: replaceTabBuckets(tabsByWorktree, [
      [worktreeId, tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))]
    ])
  }
}
