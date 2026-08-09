/**
 * Assigns each persisted PTY id a single owning terminal row at hydration time.
 *
 * Why: a session can persist the same PTY id on more than one terminal row (a
 * stale row left behind by an interrupted close, a legacy row shadowing its
 * canonical unified-tab row). Restoring both makes two panes mirror one PTY, and
 * the hidden mirror's fit resizes the shared PTY to its stale dimensions — the
 * visible pane then wraps at the wrong width. Rows still restore; only the
 * duplicate PTY binding is dropped, so the non-owner spawns a fresh PTY instead.
 */

export type HydrationPtyOwnershipRow = {
  tabId: string
  /** Row is referenced by a unified tab, i.e. it is the one the user can see. */
  isCanonical: boolean
  sortOrder: number
  createdAt: number
  ptyIds: readonly string[]
}

export type HydrationPtyOwnership = {
  ownsPtyId: (tabId: string, ptyId: string) => boolean
  ownsAnyPtyId: (tabId: string) => boolean
}

function compareRows(a: HydrationPtyOwnershipRow, b: HydrationPtyOwnershipRow): number {
  if (a.isCanonical !== b.isCanonical) {
    return a.isCanonical ? -1 : 1
  }
  return (
    a.sortOrder - b.sortOrder ||
    a.createdAt - b.createdAt ||
    (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0)
  )
}

export function resolveHydrationPtyOwnership(
  rows: readonly HydrationPtyOwnershipRow[]
): HydrationPtyOwnership {
  const ownerTabIdByPtyId = new Map<string, string>()
  const ownedPtyCountByTabId = new Map<string, number>()

  for (const row of [...rows].sort(compareRows)) {
    for (const ptyId of row.ptyIds) {
      if (ownerTabIdByPtyId.has(ptyId)) {
        continue
      }
      ownerTabIdByPtyId.set(ptyId, row.tabId)
      ownedPtyCountByTabId.set(row.tabId, (ownedPtyCountByTabId.get(row.tabId) ?? 0) + 1)
    }
  }

  return {
    ownsPtyId: (tabId, ptyId) => ownerTabIdByPtyId.get(ptyId) === tabId,
    ownsAnyPtyId: (tabId) => (ownedPtyCountByTabId.get(tabId) ?? 0) > 0
  }
}
