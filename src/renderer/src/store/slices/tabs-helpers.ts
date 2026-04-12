import type { Tab, TabContentType, TabGroup, WorkspaceSessionState } from '../../../../shared/types'

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

export function findGroupForTab(
  groupsByWorktree: Record<string, TabGroup[]>,
  worktreeId: string,
  groupId: string
): TabGroup | null {
  const groups = groupsByWorktree[worktreeId] ?? []
  return groups.find((g) => g.id === groupId) ?? null
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
  const groupId = globalThis.crypto.randomUUID()
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

export function updateGroup(groups: TabGroup[], updated: TabGroup): TabGroup[] {
  return groups.map((g) => (g.id === updated.id ? updated : g))
}

export function isTransientEditorContentType(contentType: TabContentType): boolean {
  return contentType === 'diff' || contentType === 'conflict-review'
}

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

/**
 * Apply a partial update to a single tab, returning the new `unifiedTabsByWorktree`
 * map. Returns `null` if the tab is not found (callers should return `{}` to the
 * zustand setter in that case).
 */
export function patchTab(
  tabsByWorktree: Record<string, Tab[]>,
  tabId: string,
  patch: Partial<Tab>
): { unifiedTabsByWorktree: Record<string, Tab[]> } | null {
  const found = findTabAndWorktree(tabsByWorktree, tabId)
  if (!found) {
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
