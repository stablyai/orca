import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import { verticalListSortingStrategy, type SortingStrategy } from '@dnd-kit/sortable'
import type { QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import { parseSharedRowId, SHARED_ZONE_ID } from './room-queue-state'
import { roomQueuePointerForDrag, type RoomQueuePointer } from './room-queue-drag-targeting'

export type RoomSharedQueuePlacement = {
  overMessageId: string | null
  after: boolean
  index: number
}

export function roomSharedQueuePlacement(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  pointer: RoomQueuePointer | null,
  items: readonly QueuedMessageItem[]
): RoomSharedQueuePlacement | null {
  const overId = event.over ? String(event.over.id) : null
  const overMessageId = overId ? parseSharedRowId(overId) : null
  if (overMessageId) {
    const index = items.findIndex((item) => parseSharedRowId(item.id) === overMessageId)
    if (index === -1) {
      return null
    }
    const point = roomQueuePointerForDrag(event, pointer)
    const after = Boolean(point && point.y > event.over!.rect.top + event.over!.rect.height / 2)
    return { overMessageId, after, index: index + Number(after) }
  }
  return overId === SHARED_ZONE_ID
    ? { overMessageId: null, after: false, index: items.length }
    : null
}

export function projectRoomSharedQueueItems(
  items: readonly QueuedMessageItem[],
  active: QueuedMessageItem | null,
  placement: RoomSharedQueuePlacement | null
): readonly QueuedMessageItem[] {
  return active && parseSharedRowId(active.id) === null && placement ? [...items, active] : items
}

export function roomSharedQueueSortingStrategy(index: number): SortingStrategy {
  return (args) =>
    verticalListSortingStrategy({
      ...args,
      overIndex: Math.min(Math.max(index, 0), args.activeIndex)
    })
}
