import { DragOverlay } from '@dnd-kit/core'
import { QueuedMessageCard, type QueuedMessageItem } from '../native-chat/QueuedMessageCard'

export function RoomQueueDragOverlay({
  item
}: {
  item: QueuedMessageItem | null
}): React.JSX.Element {
  return (
    <DragOverlay dropAnimation={null}>
      {item ? (
        <div className="pointer-events-none w-fit max-w-[min(40rem,80vw)] opacity-70">
          <QueuedMessageCard item={item} />
        </div>
      ) : null}
    </DragOverlay>
  )
}
