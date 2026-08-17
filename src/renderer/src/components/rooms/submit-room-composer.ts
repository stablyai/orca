import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomMessage } from '../../../../shared/rooms'
import type { RoomComposerAttachment } from './RoomAttachments'
import { getRoomContinueDeliveryIds } from './room-composer-continue-deliveries'
import type { RoomQueueComposerEdit } from './room-queue-composer-edit'
import { resolveRoomComposerMentions } from './RoomComposerSuggestions'
import type { RoomData } from './use-room-data'

export async function submitRoomComposer(input: {
  data: RoomData
  text: string
  attachments: RoomComposerAttachment[]
  editing: RoomQueueComposerEdit | null
  reply: RoomMessage | null
  targetParticipantIds: string[] | null
}): Promise<boolean> {
  const text = input.text.trim()
  const uploadIds = input.attachments.flatMap((attachment) =>
    attachment.source === 'upload' ? [attachment.uploadId] : []
  )
  const mentions = resolveRoomComposerMentions(text, input.data.snapshot?.participants ?? [])
  if (input.editing) {
    await roomRpc(input.data.target, 'rooms.messages.finishQueueEdit', {
      messageId: input.editing.message.id,
      editToken: input.editing.editToken,
      body: text,
      mentions,
      retainedAttachmentIds: input.attachments.flatMap((attachment) =>
        attachment.source === 'existing' ? [attachment.attachmentId] : []
      ),
      attachmentUploadIds: uploadIds
    })
    return true
  }
  const isContinue = text.toLocaleLowerCase() === '/continue' && input.attachments.length === 0
  const supportsRoomWork = input.data.snapshot?.workState !== undefined
  const continueDeliveryIds =
    isContinue && !supportsRoomWork
      ? getRoomContinueDeliveryIds(input.data.messages, Object.values(input.data.deliveries))
      : []
  if (isContinue && !supportsRoomWork && continueDeliveryIds.length === 0) {
    toast.error(translate('rooms.composer.noPausedLoop', 'No paused agent loop in this room'))
    return false
  }
  if (isContinue) {
    if (supportsRoomWork) {
      const { resumed } = await roomRpc<{ resumed: number }>(
        input.data.target,
        'rooms.work.resume',
        {
          roomId: input.data.roomId
        }
      )
      if (resumed === 0 && input.data.snapshot?.workState !== 'stopped') {
        throw new Error(
          translate('rooms.composer.noPausedLoop', 'No paused agent loop in this room')
        )
      }
    } else {
      await Promise.all(
        continueDeliveryIds.map((deliveryId) =>
          roomRpc(input.data.target, 'rooms.deliveries.retry', { deliveryId })
        )
      )
    }
    return true
  }
  await roomRpc(input.data.target, 'rooms.messages.send', {
    roomId: input.data.roomId,
    body: text,
    replyToId: input.reply?.id ?? null,
    mentions,
    attachmentUploadIds: uploadIds,
    ...(input.data.snapshot?.deliveryQueueVersion === 1 && input.targetParticipantIds
      ? { targetParticipantIds: input.targetParticipantIds }
      : {})
  })
  return true
}
