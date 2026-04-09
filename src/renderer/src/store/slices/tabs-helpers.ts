import type { Tab, TabGroup } from '../../../../shared/types'

export function findTabAndWorktree(
  tabsByWorktree: Record<string, Tab[]>,
  tabId: string,
  // Why: editor tabs can share the same ID (filePath) across groups when split.
  // When provided, groupId narrows the search to a specific group so operations
  // like close/activate target the correct group's tab, not the first match.
  groupId?: string
): { tab: Tab; worktreeId: string } | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((t) => t.id === tabId && (!groupId || t.groupId === groupId))
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

export function ensureGroup(
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string>,
  worktreeId: string,
  targetGroupId?: string
): {
  group: TabGroup
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
} {
  // Why: in multi-group mode, new tabs must go to the group the user is
  // interacting with. targetGroupId is checked first so the caller can
  // direct creation into a specific group rather than always landing in [0].
  if (targetGroupId) {
    const target = groupsByWorktree[worktreeId]?.find((g) => g.id === targetGroupId)
    if (target) {
      return { group: target, groupsByWorktree, activeGroupIdByWorktree }
    }
  }

  const existing = groupsByWorktree[worktreeId]?.[0]
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
