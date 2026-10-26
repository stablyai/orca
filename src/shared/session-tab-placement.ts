import { insertTabIdIntoOrder, partitionPinnedTabOrder } from './workspace-layout/tab-order'

/** Call-local neighbors survive an anchor retiring while creation is awaited. */
export type CapturedSessionTabPlacement = { preceding: string[]; following: string[] }

export function captureSessionTabPlacement(
  order: readonly string[],
  afterTabId: string | null | undefined
): CapturedSessionTabPlacement | undefined {
  const index = afterTabId ? order.indexOf(afterTabId) : -1
  return index < 0
    ? undefined
    : {
        preceding: order.slice(0, index + 1),
        following: order.slice(index + 1)
      }
}

/** Apply only insertion to current order, keeping unrelated concurrent edits. */
export function placeSessionTabAtCapture(
  order: readonly string[],
  createdId: string,
  captured: CapturedSessionTabPlacement
): string[] {
  const next = order.filter((id) => id !== createdId)
  const present = new Set(next)
  const previous = captured.preceding.toReversed().find((id) => present.has(id))
  const following = captured.following.find((id) => present.has(id))
  const index =
    following !== undefined
      ? next.indexOf(following)
      : previous !== undefined
        ? next.indexOf(previous) + 1
        : Math.min(captured.preceding.length, next.length)
  next.splice(index, 0, createdId)
  return next
}

/** Captured placement uses the same pin partitions as an ordinary tab insertion. */
export function placeUnpinnedSessionTabAtCapture(
  order: readonly string[],
  tabs: readonly { id: string; isPinned?: boolean }[],
  createdId: string,
  captured: CapturedSessionTabPlacement
): string[] {
  const placed = placeSessionTabAtCapture(order, createdId, captured)
  const preceding = placed[placed.indexOf(createdId) - 1]
  return preceding
    ? insertTabIdIntoOrder(placed, tabs, createdId, false, preceding)
    : partitionPinnedTabOrder(placed, tabs, createdId)
}

export type SessionTabPlacementOptions = {
  afterParentGroup?: boolean
  captured?: CapturedSessionTabPlacement
}

/** Places a created tab after the anchor, or after its parent group when enabled. */
export function placeCreatedSessionTab<T extends { id: string; parentTabId?: string }>(
  tabs: readonly T[],
  created: T,
  afterTabId: string | null | undefined,
  options: SessionTabPlacementOptions = {}
): T[] {
  const next = tabs.filter((tab) => tab.id !== created.id)
  const anchor = afterTabId ? next.findIndex((tab) => tab.id === afterTabId) : -1
  if (anchor < 0) {
    if (options.captured) {
      const order = placeSessionTabAtCapture(
        next.map((tab) => tab.id),
        created.id,
        options.captured
      )
      const byId = new Map([...next, created].map((tab) => [tab.id, tab]))
      return order.flatMap((id) => {
        const tab = byId.get(id)
        return tab ? [tab] : []
      })
    }
    next.push(created)
    return next
  }
  let insertAfter = anchor
  const anchorParentTabId = next[anchor].parentTabId
  if (options.afterParentGroup && anchorParentTabId) {
    for (let index = anchor + 1; index < next.length; index += 1) {
      if (next[index].parentTabId === anchorParentTabId) {
        insertAfter = index
      }
    }
  }
  next.splice(insertAfter + 1, 0, created)
  return next
}
