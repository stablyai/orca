import type { BackgroundMountTerminalWorktreeDetail } from '@/constants/terminal'

export type BackgroundMountColdRestorePaneRestrictions = Map<
  string,
  ReadonlyMap<string, ReadonlySet<string>>
>

export function mergeBackgroundMountColdRestorePaneScopes(
  existing: BackgroundMountTerminalWorktreeDetail,
  incoming: BackgroundMountTerminalWorktreeDetail,
  tabIds: readonly string[]
): BackgroundMountTerminalWorktreeDetail['coldRestorePaneKeysByTabId'] {
  const merged: Record<string, readonly string[]> = {}
  for (const tabId of tabIds) {
    const existingRequested = existing.tabIds?.includes(tabId) === true
    const incomingRequested = incoming.tabIds?.includes(tabId) === true
    const existingKeys = existing.coldRestorePaneKeysByTabId?.[tabId]
    const incomingKeys = incoming.coldRestorePaneKeysByTabId?.[tabId]
    // An unscoped request for the same tab dominates a mail-scoped one.
    if ((existingRequested && !existingKeys) || (incomingRequested && !incomingKeys)) {
      continue
    }
    const paneKeys = [...new Set([...(existingKeys ?? []), ...(incomingKeys ?? [])])]
    if (paneKeys.length > 0) {
      merged[tabId] = paneKeys
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export function applyBackgroundMountColdRestorePaneRestriction(
  restrictions: BackgroundMountColdRestorePaneRestrictions,
  detail: BackgroundMountTerminalWorktreeDetail
): void {
  const { worktreeId, tabIds, coldRestorePaneKeysByTabId } = detail
  const existing = restrictions.get(worktreeId)
  if (!tabIds) {
    restrictions.delete(worktreeId)
    return
  }
  const next = new Map(existing ?? [])
  for (const tabId of tabIds) {
    const paneKeys = coldRestorePaneKeysByTabId?.[tabId]
    if (!paneKeys) {
      next.delete(tabId)
      continue
    }
    next.set(tabId, new Set([...(next.get(tabId) ?? []), ...paneKeys]))
  }
  if (next.size > 0) {
    restrictions.set(worktreeId, next)
  } else {
    restrictions.delete(worktreeId)
  }
}

export function getBackgroundMountColdRestorePaneKeys(
  restrictions: BackgroundMountColdRestorePaneRestrictions,
  worktreeId: string,
  tabId: string
): ReadonlySet<string> | undefined {
  return restrictions.get(worktreeId)?.get(tabId)
}

export function pruneBackgroundMountColdRestorePaneRestrictions(
  restrictions: BackgroundMountColdRestorePaneRestrictions,
  tabsByWorktree: Record<string, readonly { id: string }[]>
): void {
  for (const [worktreeId, byTabId] of restrictions) {
    const liveTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
    let hasClosedTab = false
    for (const tabId of byTabId.keys()) {
      if (!liveTabIds.has(tabId)) {
        hasClosedTab = true
        break
      }
    }
    if (!hasClosedTab) {
      continue
    }
    const retained = new Map([...byTabId].filter(([tabId]) => liveTabIds.has(tabId)))
    if (retained.size > 0) {
      restrictions.set(worktreeId, retained)
    } else {
      restrictions.delete(worktreeId)
    }
  }
}
