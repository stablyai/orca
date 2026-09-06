import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'
import type { QueuedMessageItem } from './QueuedMessageCard'
import { QueuedMessageList } from './QueuedMessageList'

export function QueuedMessageStack({
  items,
  editingMessageId,
  disabled,
  canSteer,
  onEdit,
  onEditInComposer,
  onRemove,
  onSteer,
  onRetry,
  onReorder,
  interrupted,
  onResume,
  imageLoadContext
}: {
  items: readonly QueuedMessageItem[]
  editingMessageId?: string | null
  disabled?: boolean
  canSteer?: boolean
  onEdit?: (id: string, text: string) => void
  onEditInComposer?: (item: QueuedMessageItem) => void
  onRemove?: (id: string) => void
  onSteer?: (id: string) => void
  onRetry?: (id: string) => void
  onReorder?: (ids: string[]) => void
  interrupted?: boolean
  onResume?: () => void
  imageLoadContext?: NativeChatImageLoadContext
}): React.JSX.Element | null {
  const visibleItems = editingMessageId
    ? items.filter((item) => item.id !== editingMessageId)
    : items
  const rows = visibleItems.map((item) => ({
    ...item,
    canSteer: Boolean(canSteer && item.state === 'pending'),
    dragDisabled: Boolean(editingMessageId)
  }))
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  if (!visibleItems.length) {
    return null
  }
  const dragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) {
      return
    }
    const from = rows.findIndex((item) => item.id === active.id)
    const to = rows.findIndex((item) => item.id === over.id)
    if (from !== -1 && to !== -1) {
      onReorder?.(arrayMove(rows, from, to).map((item) => item.id))
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <QueuedMessageList
        items={rows}
        disabled={disabled}
        interrupted={interrupted}
        onResume={onResume}
        onEdit={onEdit}
        onEditInComposer={onEditInComposer}
        onRemove={onRemove}
        onSteer={onSteer}
        onRetry={onRetry}
        imageLoadContext={imageLoadContext}
      />
    </DndContext>
  )
}
