// Why never filtered against live tabs: UI hydrates before the tab catalogs (the
// `filterRepoIds` trap) and the list is shared across clients, so no one client's
// tabs are authoritative. Stale ids are simply never read by the grid's index map.
//
// A view, not a model: hiding a tab leaves its pty running and its tab in place.

import { preserveStringArrayIdentity } from './ui/ui-slice-hydration-sanitizers'

/** Drop non-strings and duplicates, keeping the first occurrence. Returns the input when already clean. */
export function sanitizeSessionGridHiddenTabIds(
  hiddenTabIds: readonly string[] | undefined
): string[] {
  if (!hiddenTabIds || hiddenTabIds.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const clean: string[] = []
  for (const id of hiddenTabIds) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id)
      clean.push(id)
    }
  }
  // Returning the input when nothing was dropped is redundancy, not a guard: the only caller
  // (hydrateSessionGridState) re-checks identity against the STORE's array right after, and the
  // persisted writer never sees this output — it diffs by value in `stringArrayEqual`.
  return preserveStringArrayIdentity(hiddenTabIds as string[], clean) ?? clean
}

/** Remove one retired tab. Returns the input when the id was not present. */
export function pruneSessionGridHiddenTabIds(
  hiddenTabIds: readonly string[],
  closedTabId: string
): string[] {
  return hiddenTabIds.includes(closedTabId)
    ? hiddenTabIds.filter((id) => id !== closedTabId)
    : (hiddenTabIds as string[])
}

/** Flip one tab's grid visibility; every other hidden tab keeps its place. */
export function toggleSessionGridHiddenTabId(
  hiddenTabIds: readonly string[],
  tabId: string
): string[] {
  return hiddenTabIds.includes(tabId)
    ? hiddenTabIds.filter((id) => id !== tabId)
    : [...hiddenTabIds, tabId]
}
