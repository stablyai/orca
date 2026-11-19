import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { ActivityBarButton, type ActivityBarItem } from './activity-bar-buttons'

export function SortableActivityButton({
  item,
  active,
  onClick,
  statusIndicator,
  layout,
  compact
}: {
  layout: 'top' | 'side'
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  statusIndicator?: 'success' | 'failure' | 'pending' | 'neutral' | 'cancelled' | null
  compact?: boolean
}): React.JSX.Element {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition } = useSortable({
    id: item.id
  })
  return (
    <ActivityBarButton
      item={item}
      active={active}
      onClick={onClick}
      layout={layout}
      statusIndicator={statusIndicator}
      compact={compact}
      buttonProps={{
        ...listeners,
        ref: (node) => {
          setNodeRef(node)
          setActivatorNodeRef(node)
        },
        style: {
          transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
          transition
        }
      }}
    />
  )
}
