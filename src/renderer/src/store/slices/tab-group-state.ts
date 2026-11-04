import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { workspaceRootGroupId } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'

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
  const existing =
    groupsByWorktree[worktreeId]?.find((group) => group.id === preferredGroupId) ??
    groupsByWorktree[worktreeId]?.[0]
  if (existing) {
    return { group: existing, groupsByWorktree, activeGroupIdByWorktree }
  }
  // Switch point: the root group id main and the Loader mint for a workspace with no group.
  const groupId = ORCA_LAYOUT_OWNER_IS_MAIN ? workspaceRootGroupId(worktreeId) : createBrowserUuid()
  const group: TabGroup = { id: groupId, worktreeId, activeTabId: null, tabOrder: [] }
  return {
    group,
    groupsByWorktree: { ...groupsByWorktree, [worktreeId]: [group] },
    activeGroupIdByWorktree: { ...activeGroupIdByWorktree, [worktreeId]: groupId }
  }
}

/** Pick the nearest neighbor in visual order (right first, then left). */
export function pickNeighbor(tabOrder: string[], closingTabId: string): string | null {
  const idx = tabOrder.indexOf(closingTabId)
  if (idx === -1) {
    return null
  }
  if (idx + 1 < tabOrder.length) {
    return tabOrder[idx + 1]
  }
  if (idx - 1 >= 0) {
    return tabOrder[idx - 1]
  }
  return null
}

/** Keep live MRU IDs once, preserving each last occurrence (tail is newest). */
export function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.toReversed()
}

/** Move tabId to MRU tail, returning a new array. */
export function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  const filtered = base.filter((id) => id !== tabId)
  filtered.push(tabId)
  return filtered
}

/** Prefer previous MRU tab on close; newly hydrated groups may know only the current tab, so fall back to visual neighbor. */
export function pickNextActiveTab(
  tabOrder: string[],
  recentTabIds: string[] | undefined,
  closingTabId: string,
  tabs?: readonly Pick<Tab, 'id'>[]
): string | null {
  if (tabs) {
    const realIds = new Set(tabs.map((tab) => tab.id))
    tabOrder = tabOrder.filter((id) => realIds.has(id))
  }
  const sanitized = sanitizeRecentTabIds(recentTabIds, tabOrder)
  for (let i = sanitized.length - 1; i >= 0; i--) {
    if (sanitized[i] !== closingTabId) {
      return sanitized[i]
    }
  }
  return pickNeighbor(tabOrder, closingTabId)
}

export function updateGroup(groups: TabGroup[], updated: TabGroup): TabGroup[] {
  return groups.map((g) => (g.id === updated.id ? updated : g))
}

export { isTransientEditorContentType } from '../../../../shared/workspace-layout/saved-editor-tab-restore'

export function getPersistedEditFileIdsByWorktree(
  session: WorkspaceSessionState
): Record<string, Set<string>> {
  return Object.fromEntries(
    Object.entries(session.openFilesByWorktree ?? {}).map(([worktreeId, files]) => [
      worktreeId,
      new Set(files.map((file) => file.filePath))
    ])
  )
}

export function selectHydratedActiveGroupId(
  groups: TabGroup[],
  persistedActiveGroupId?: string
): string | undefined {
  const preferredGroups = groups.filter((group) => group.tabOrder.length > 0)
  const candidates = preferredGroups.length > 0 ? preferredGroups : groups
  if (persistedActiveGroupId && candidates.some((group) => group.id === persistedActiveGroupId)) {
    return persistedActiveGroupId
  }
  return candidates[0]?.id
}

/** Hydration must remove duplicate IDs left by editor-owner migration; repeated React keys otherwise strand ghost rows. */
export function dedupeTabsById<T extends { id: string }>(tabs: T[]): T[] {
  const seen = new Set<string>()
  return tabs.filter((tab) => {
    if (seen.has(tab.id)) {
      return false
    }
    seen.add(tab.id)
    return true
  })
}

export function dedupeEditorTabsWithinGroups(tabs: Tab[]): {
  tabs: Tab[]
  tabIdAliasesByGroup: Map<string, Map<string, string>>
} {
  const tabIdAliasesByGroup = new Map<string, Map<string, string>>()
  const editorTabIdByGroupAndEntity = new Map<string, Map<string, string>>()
  const dedupedTabs = dedupeTabsById(tabs).filter((tab) => {
    if (tab.contentType !== 'editor') {
      return true
    }
    const editorTabIdByEntity =
      editorTabIdByGroupAndEntity.get(tab.groupId) ?? new Map<string, string>()
    editorTabIdByGroupAndEntity.set(tab.groupId, editorTabIdByEntity)
    const existingTabId = editorTabIdByEntity.get(tab.entityId)
    if (existingTabId !== undefined) {
      const tabIdAliases = tabIdAliasesByGroup.get(tab.groupId) ?? new Map<string, string>()
      tabIdAliasesByGroup.set(tab.groupId, tabIdAliases)
      tabIdAliases.set(tab.id, existingTabId)
      return false
    }
    editorTabIdByEntity.set(tab.entityId, tab.id)
    return true
  })
  return { tabs: dedupedTabs, tabIdAliasesByGroup }
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
    unifiedTabsByWorktree: {
      ...tabsByWorktree,
      [worktreeId]: tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
    }
  }
}
