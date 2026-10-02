import { toast } from 'sonner'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { Room, RoomEvent } from '../../../../shared/rooms'
import { showRoomActionError } from './room-action-error'
import { closeRoomTabs } from './use-room-tabs'

export async function deleteRoomFromUi(input: {
  room: Pick<Room, 'id' | 'name'>
  target: RuntimeClientTarget
  confirm: ConfirmationDialogContextValue
  setDeleting: (deleting: boolean) => void
}): Promise<void> {
  const confirmed = await input.confirm({
    title: translate('rooms.delete.title', 'Delete “{{name}}”?', { name: input.room.name }),
    description: translate(
      'rooms.delete.description',
      'The room, messages, participants, attachments, and delivery state will be deleted. Participant chat sessions will remain in Agent Session History.'
    ),
    confirmLabel: translate('rooms.sidebar.deleteRoom', 'Delete room'),
    confirmVariant: 'destructive'
  })
  if (!confirmed) {
    return
  }
  input.setDeleting(true)
  try {
    await roomRpc(input.target, 'rooms.delete', { roomId: input.room.id })
    closeRoomTabs(input.room.id)
    toast.success(translate('rooms.delete.deleted', 'Room deleted'))
  } catch (error) {
    showRoomActionError(error)
  } finally {
    input.setDeleting(false)
  }
}

export function closeRoomTabsForEnd(event: RoomEvent, roomId: string): void {
  if (event.type === 'end' && event.reason === 'deleted') {
    closeRoomTabs(roomId)
  }
}
