import { useCallback } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { parseSharedRowId, SHARED_ZONE_ID } from './room-queue-state'

export function SharedQueueZone({
  children,
  refCallback
}: {
  children?: React.ReactNode
  refCallback?: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  const { setNodeRef: setDroppableNodeRef } = useDroppable({ id: SHARED_ZONE_ID })
  const { active, over } = useDndContext()
  const setNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      setDroppableNodeRef(element)
      refCallback?.(element)
    },
    [refCallback, setDroppableNodeRef]
  )
  const receiving = active !== null && parseSharedRowId(String(active.id)) === null
  const overId = over ? String(over.id) : null
  const targeted =
    receiving && Boolean(overId === SHARED_ZONE_ID || (overId && parseSharedRowId(overId)))
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative min-h-0 w-full rounded-md transition-[background-color,box-shadow,min-height] duration-200 motion-reduce:transition-none',
        targeted && 'bg-accent',
        receiving && 'ring-1 ring-inset ring-border',
        receiving && 'min-h-16'
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-xs text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none',
          receiving && !targeted ? 'opacity-100' : 'opacity-0'
        )}
      >
        {translate('rooms.queue.dropShared', 'Drop here to return to the room queue')}
      </span>
      <div className="w-full">{children}</div>
    </div>
  )
}
