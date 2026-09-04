import React, { memo, useCallback } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { SessionGridCard } from './SessionGridCard'
import { cn } from '@/lib/utils'
import type { SessionGridCardActions } from './SessionGridSlots'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

type SortableSessionGridCardProps = {
  item: SessionGridItem
  isActive: boolean
  /** False while the card is staged for mount: the shell renders, the terminal does not. */
  previewMounted: boolean
  actions: SessionGridCardActions
}

// Memoized so a scroll or title tick on the page does not re-render every mounted terminal.
export const SortableSessionGridCard = memo(function SortableSessionGridCard({
  item,
  isActive,
  previewMounted,
  actions
}: SortableSessionGridCardProps): React.JSX.Element {
  const { tabId } = item
  const onFocus = useCallback(() => actions.onFocus(tabId), [actions, tabId])
  // The whole item: maximizing needs the pane key too, to focus and ack the leaf on screen.
  const onMaximize = useCallback(() => actions.onMaximize(item), [actions, item])
  const onClose = useCallback(() => actions.onClose(tabId), [actions, tabId])
  const onToggleHidden = useCallback(() => actions.onToggleHidden(tabId), [actions, tabId])
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tabId
  })

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition: transition || undefined,
    zIndex: isDragging ? 50 : undefined
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('h-full w-full min-h-0 min-w-0', isDragging && 'opacity-30')}
    >
      <SessionGridCard
        item={item}
        isActive={isActive}
        previewMounted={previewMounted}
        isDragging={isDragging}
        dragHandleProps={{ ...attributes, ...listeners }}
        onFocus={onFocus}
        onMaximize={onMaximize}
        onClose={onClose}
        onToggleHidden={onToggleHidden}
      />
    </div>
  )
})
