import type { Tab } from '../tab-types'

type PinnedTab = Pick<Tab, 'id' | 'isPinned'>

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

/** A projected reorder changes current placement without replacing omitted canonical members. */
export function reorderProjectedTabOrder(
  order: string[],
  requestedOrder: readonly string[],
  movingTabId: string
): string[] {
  const currentIds = new Set(order)
  const requested = requestedOrder.filter((id) => currentIds.has(id))
  const positions = new Map(requested.map((id, index) => [id, index]))
  const visible = order.filter((id) => positions.has(id))
  if (visible.every((id, index) => id === requested[index])) {
    return order
  }
  const candidates = visible.flatMap((id) => {
    const position = positions.get(id)
    return id === movingTabId || position === undefined ? [] : [{ id, position }]
  })
  const lengths = candidates.map(() => 1)
  for (let i = candidates.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[j].position > candidates[i].position) {
        lengths[i] = Math.max(lengths[i], 1 + lengths[j])
      }
    }
  }
  let remaining = Math.max(0, ...lengths)
  let previousPosition = -1
  const anchors = new Set<string>()
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (candidate.position > previousPosition && lengths[i] === remaining) {
      anchors.add(candidate.id)
      previousPosition = candidate.position
      remaining--
    }
  }
  const result = order.filter((id) => !positions.has(id) || anchors.has(id))
  let successor: string | undefined
  for (const id of requested.toReversed()) {
    if (!anchors.has(id)) {
      result.splice(successor === undefined ? result.length : result.indexOf(successor), 0, id)
    }
    successor = id
  }
  return result
}

export function partitionPinnedTabOrder(
  tabOrder: string[],
  tabs: readonly PinnedTab[],
  movingTabId: string
): string[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const withoutMoving = dedupeTabOrder(tabOrder).filter((id) => id !== movingTabId)
  const pinnedIds = withoutMoving.filter((id) => tabById.get(id)?.isPinned)
  const unpinnedIds = withoutMoving.filter((id) => !tabById.get(id)?.isPinned)
  return [...pinnedIds, movingTabId, ...unpinnedIds]
}

export function applyTabOrderSortValues(tabs: Tab[], tabOrder: string[]): Tab[] {
  const orderMap = new Map(tabOrder.map((id, index) => [id, index]))
  return tabs.map((tab) => {
    const sortOrder = orderMap.get(tab.id)
    return sortOrder === undefined || sortOrder === tab.sortOrder ? tab : { ...tab, sortOrder }
  })
}

/**
 * Insert `tabId` after `anchorTabId` when both share a pin partition; otherwise at the end of the
 * new tab's partition. Siblings keep their relative order.
 */
export function insertTabIdIntoOrder(
  tabOrder: readonly string[],
  tabs: readonly PinnedTab[],
  tabId: string,
  isPinned: boolean,
  anchorTabId?: string
): string[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const order = dedupeTabOrder([...tabOrder]).filter((id) => id !== tabId)
  const firstUnpinnedIndex = order.findIndex((id) => !tabById.get(id)?.isPinned)
  const pinnedPrefixEnd = firstUnpinnedIndex === -1 ? order.length : firstUnpinnedIndex
  const anchorIndex = anchorTabId ? order.indexOf(anchorTabId) : -1
  const anchorIsPinned = anchorIndex !== -1 && tabById.get(order[anchorIndex])?.isPinned === true
  let index = isPinned ? pinnedPrefixEnd : order.length
  if (anchorIndex !== -1) {
    index = anchorIsPinned === isPinned ? anchorIndex + 1 : pinnedPrefixEnd
  }
  order.splice(index, 0, tabId)
  return order
}

export function isReplaceablePreviewContentType(contentType: Tab['contentType']): boolean {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}

export function canReplacePreviewContentType(
  incomingContentType: Tab['contentType'],
  existingContentType: Tab['contentType']
): boolean {
  if (isReplaceablePreviewContentType(incomingContentType)) {
    return isReplaceablePreviewContentType(existingContentType)
  }
  return existingContentType === incomingContentType
}

export type TabOrderMove = { tabId: string; index: number }

/**
 * A `moveTab` anchor for slot `index` of the order the window drew: the tab before it, or null
 * for first. Main places by it, so a tab only main holds cannot shift the move (ledger L193).
 */
export function tabOrderAnchor(order: readonly string[], index: number): string | null | undefined {
  return index <= 0 ? null : order[index - 1]
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

/**
 * `moveTab` steps (take the tab out, put it back at `index`) that turn `from` into `to`: one when a
 * single tab moved, else one per misplaced slot. None when the two orders hold different tabs.
 */
export function tabOrderMoves(from: readonly string[], to: readonly string[]): TabOrderMove[] {
  const held = new Set(from)
  if (held.size !== from.length || !sameOrder([...held].sort(), [...to].sort())) {
    return []
  }
  if (sameOrder(from, to)) {
    return []
  }
  for (const [index, tabId] of to.entries()) {
    const others = (order: readonly string[]) => order.filter((id) => id !== tabId)
    if (sameOrder(others(from), others(to))) {
      return [{ tabId, index }]
    }
  }
  const current = [...from]
  const moves: TabOrderMove[] = []
  for (const [index, tabId] of to.entries()) {
    if (current[index] !== tabId) {
      current.splice(current.indexOf(tabId), 1)
      current.splice(index, 0, tabId)
      moves.push({ tabId, index })
    }
  }
  return moves
}
