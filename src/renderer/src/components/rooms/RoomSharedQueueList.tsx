import { useMemo } from 'react'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomMessage } from '../../../../shared/rooms'
import { SortableQueuedMessageCard, type QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import { QueuedMessageList } from '../native-chat/QueuedMessageList'
import { RoomSharedQueueRow } from './RoomQueueRows'
import { showRoomActionError } from './room-action-error'
import { roomSharedQueueSortingStrategy } from './room-shared-queue-placement'
import { parseSharedRowId } from './room-queue-state'
import type { RoomData } from './use-room-data'

export function RoomSharedQueueList({
  data,
  items,
  supportsEdit,
  editing,
  editPending,
  projectedIndex,
  suppressExitId,
  onEdit
}: {
  data: RoomData
  items: readonly QueuedMessageItem[]
  supportsEdit: boolean
  editing: boolean
  editPending: boolean
  projectedIndex: number | null
  suppressExitId?: string | null
  onEdit: (message: RoomMessage) => void
}): React.JSX.Element {
  const sortingStrategy = useMemo(
    () => (projectedIndex === null ? undefined : roomSharedQueueSortingStrategy(projectedIndex)),
    [projectedIndex]
  )
  return (
    <QueuedMessageList
      items={items}
      sortingStrategy={sortingStrategy}
      suppressExitId={suppressExitId}
      interrupted={data.snapshot?.workState === 'stopped'}
      onResume={() =>
        void roomRpc(data.target, 'rooms.work.resume', { roomId: data.roomId }).catch(
          showRoomActionError
        )
      }
      renderItem={(item) => {
        const messageId = parseSharedRowId(item.id)
        if (!messageId) {
          return (
            <div aria-hidden className="invisible">
              <SortableQueuedMessageCard item={item} hideWhileDragging droppableDisabled />
            </div>
          )
        }
        return (
          <RoomSharedQueueRow
            data={data}
            item={item}
            report={showRoomActionError}
            inlineEdit={!supportsEdit}
            onEditInComposer={
              supportsEdit && !editing && !editPending
                ? () => {
                    const message = data.messages.find((candidate) => candidate.id === messageId)
                    if (message) {
                      onEdit(message)
                    }
                  }
                : undefined
            }
          />
        )
      }}
    />
  )
}
