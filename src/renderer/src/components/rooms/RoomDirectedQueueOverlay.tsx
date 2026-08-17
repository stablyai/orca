import type { RoomMessage, RoomParticipant } from '../../../../shared/rooms'
import type { QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import { RoomDirectedQueueRow } from './RoomQueueRows'
import { RoomQueueSquareOverlay } from './RoomQueueSquare'
import type { RoomData } from './use-room-data'

export function RoomDirectedQueueOverlay({
  data,
  participant,
  items,
  supportsEdit,
  editing,
  editPending,
  closing,
  suppressExitId,
  report,
  onEdit,
  onClose,
  refCallback
}: {
  data: RoomData
  participant: RoomParticipant
  items: QueuedMessageItem[]
  supportsEdit: boolean
  editing: boolean
  editPending: boolean
  closing: boolean
  suppressExitId?: string | null
  report: (error: unknown) => void
  onEdit: (message: RoomMessage) => void
  onClose: () => void
  refCallback: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <RoomQueueSquareOverlay
      participant={participant}
      items={items}
      rows={(item) => (
        <RoomDirectedQueueRow
          data={data}
          item={item}
          participantId={participant.id}
          report={report}
          inlineEdit={!supportsEdit}
          onEditInComposer={supportsEdit && !editing && !editPending ? onEdit : undefined}
        />
      )}
      closing={closing}
      suppressExitId={suppressExitId}
      onClose={onClose}
      refCallback={refCallback}
    />
  )
}
