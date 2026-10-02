import { z } from 'zod'
import { MessageId, ParticipantId, RoomId } from './rooms-schemas'

export const RoomsMessagesBeginQueueEditParams = z.object({ messageId: MessageId }).strict()

export const RoomsMessagesFinishQueueEditParams = z
      .object({
        messageId: MessageId,
        editToken: z.string().uuid(),
        body: z.string().max(262_144),
        mentions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
        retainedAttachmentIds: z.array(z.string().uuid()).max(10).optional(),
        attachmentUploadIds: z.array(z.string().uuid()).max(10).optional()
      })
      .strict()

export const RoomsMessagesCancelQueueEditParams = z.object({ messageId: MessageId, editToken: z.string().uuid() }).strict()

export const RoomsDeliveriesQueueParams = z.object({ roomId: RoomId }).strict()

export const RoomsMessagesRetargetParams = z.union([
      z.object({ messageId: MessageId, participantIds: z.array(ParticipantId).max(50) }).strict(),
      z.object({ messageId: MessageId, removeParticipantId: ParticipantId }).strict()
    ])

export const RoomsDeliveriesReorderParams = z.union([
      z
        .object({
          participantId: ParticipantId,
          deliveryIds: z.array(z.string().uuid()).max(200)
        })
        .strict(),
      z
        .object({
          participantId: ParticipantId,
          deliveryIds: z.array(z.string().uuid()).max(200),
          movedDeliveryId: z.string().uuid()
        })
        .strict(),
      z
        .object({
          participantId: ParticipantId,
          deliveryIds: z.array(z.string().uuid()).max(200),
          retargetMessageId: MessageId
        })
        .strict()
    ])

export const RoomsMessagesReorderQueueParams = z.union([
      z.object({ roomId: RoomId, messageIds: z.array(MessageId).max(200) }).strict(),
      z
        .object({
          roomId: RoomId,
          messageIds: z.array(MessageId).max(200),
          movedMessageId: MessageId
        })
        .strict(),
      z
        .object({
          roomId: RoomId,
          messageIds: z.array(MessageId).max(200),
          retargetMessageId: MessageId
        })
        .strict()
    ])

export const RoomsDeliveriesSteerParams = z.union([
      z.object({ deliveryId: z.string().uuid() }).strict(),
      z.object({ deliveryId: z.string().uuid(), group: z.literal(true) }).strict()
    ])
