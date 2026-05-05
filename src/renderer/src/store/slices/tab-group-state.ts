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

/** Normalize an MRU stack: drop ids not in `tabOrder` and keep only the last
 *  occurrence of each id (tail = most recent). */
export function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  // Walk right-to-left so we keep only the latest occurrence of each id, then
  // reverse back to oldest-→-newest order.
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
  return reversed.reverse()
}

/** Push `tabId` to the tail of the MRU stack (most-recently-active) after
 *  removing any prior occurrence. Returns a new array. */
export function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  const filtered = base.filter((id) => id !== tabId)
  filtered.push(tabId)
  return filtered
}

/** Choose the tab to activate when `closingTabId` closes. Prefers the most-
 *  recently-active tab before it (MRU behavior); falls back to the nearest
 *  visual neighbor when the MRU stack is empty (e.g. newly hydrated groups
 *  where only the current active tab has been recorded). */
export function pickNextActiveTab(
  tabOrder: string[],
  recentTabIds: string[] | undefined,
  closingTabId: string
): string | null {
  const sanitized = sanitizeRecentTabIds(recentTabIds, tabOrder)
  // The closing tab is typically at the tail (it's the active tab). Walk back
  // from the tail looking for the most-recent *other* tab still present.
  for (let i = sanitized.length - 1; i >= 0; i--) {
    if (sanitized[i] !== closingTabId) {
      return sanitized[i]
    }
  }
  // No prior tab has been visited in this group — fall back to neighbor
  // selection so the user still lands somewhere sensible.
  return pickNeighbor(tabOrder, closingTabId)
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

export function dedupeTabOrder(tabIds: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const tabId of tabIds) {
    if (seen.has(tabId)) {
      continue
    }
    seen.add(tabId)
    deduped.push(tabId)
  }
  return deduped
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
