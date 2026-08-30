import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'

/**
 * What "published" means for every id the mobile snapshot cross-references.
 *
 * Group ids resolve by equality. Tab ids do not: a terminal occupies its group under the parent
 * tab id while publishing one row per pane, so `tabGroups[].tabOrder` names `term-a` and `tabs[]`
 * carries `term-a::<leafId>`. Both are the published identity of the same tab — the client's
 * `buildHostToLocalTabIdMap` keys terminals by surface id *and* `parentTabId` for exactly that
 * reason — so the rule is that a group may only name a tab the client can resolve, not one whose
 * id appears verbatim in `tabs`.
 */

export function collectLayoutGroupIds(node: unknown, into: string[] = []): string[] {
  if (!node || typeof node !== 'object') {
    return into
  }
  const candidate = node as { type?: string; groupId?: string; first?: unknown; second?: unknown }
  if (candidate.type === 'leaf' && candidate.groupId) {
    into.push(candidate.groupId)
    return into
  }
  collectLayoutGroupIds(candidate.first, into)
  collectLayoutGroupIds(candidate.second, into)
  return into
}

/** Every tab id the client can resolve from this snapshot: row ids, plus terminal parent tab ids. */
function resolvablePublishedTabIds(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): Set<string> {
  const resolvable = new Set<string>()
  for (const tab of snapshot?.tabs ?? []) {
    resolvable.add(tab.id)
    if (tab.type === 'terminal') {
      resolvable.add(tab.parentTabId)
    }
  }
  return resolvable
}

/** Published ids that name a tab group the snapshot never published — empty is the invariant. */
export function danglingGroupRefs(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): (string | null)[] {
  const publishedGroupIds = new Set((snapshot?.tabGroups ?? []).map((group) => group.id))
  return [
    snapshot?.activeGroupId ?? null,
    ...collectLayoutGroupIds(snapshot?.tabGroupLayout)
  ].filter((groupId) => groupId !== null && !publishedGroupIds.has(groupId))
}

/**
 * Published groups the published layout gives no pane — empty is the invariant.
 *
 * Not the mirror of `danglingGroupRefs`: a group is content and the layout is placement, so this
 * only holds because the host layout spans every group (`layoutSpanningGroups` at hydration). It is
 * here to catch the publisher minting a group id of its own that no layout could ever place.
 */
export function unplacedPublishedGroupIds(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): string[] {
  if (!snapshot?.tabGroupLayout) {
    return []
  }
  const placed = new Set(collectLayoutGroupIds(snapshot.tabGroupLayout))
  return (snapshot.tabGroups ?? [])
    .map((group) => group.id)
    .filter((groupId) => !placed.has(groupId))
}

/** Published ids that name a tab the client cannot resolve in `tabs` — empty is the invariant. */
export function danglingTabRefs(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): (string | null)[] {
  const resolvable = resolvablePublishedTabIds(snapshot)
  const referenced: (string | null)[] = [snapshot?.activeTabId ?? null]
  for (const group of snapshot?.tabGroups ?? []) {
    referenced.push(...group.tabOrder, ...(group.recentTabIds ?? []), group.activeTabId)
  }
  return referenced.filter((tabId) => tabId !== null && !resolvable.has(tabId))
}
