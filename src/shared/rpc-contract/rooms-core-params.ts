import { z } from 'zod'

import {
  HarnessAgent,
  MessageId,
  ParticipantConnection,
  ParticipantId,
  ReaderKey,
  RoomId,
  RoomIdentity,
  RoomSubscription
} from './rooms-schemas'

const Unsubscribe = z.object({ subscriptionId: z.string().trim().min(1).max(256) }).strict()

export const RoomsListParams = z
  .object({
    projectId: z.string().trim().min(1).max(512)
  })
  .strict()

export const RoomsCreateParams = z
  .object({
    projectId: z.string().trim().min(1).max(512),
    worktreeId: z.string().trim().min(1).max(1024).nullable().optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4000).optional(),
    userIdentity: RoomIdentity.optional(),
    userDisplayName: z.string().trim().min(1).max(120).optional()
  })
  .strict()

export const RoomsSnapshotParams = z.object({ roomId: RoomId, readerKey: ReaderKey }).strict()

export const RoomsSubscribeParams = RoomSubscription

export const RoomsUnsubscribeParams = Unsubscribe

export const RoomsMessagesListParams = z
  .object({
    roomId: RoomId,
    beforeSequence: z.number().int().positive().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(100)
  })
  .strict()

export const RoomsMessagesSendParams = z
  .object({
    roomId: RoomId,
    body: z.string().max(262_144),
    replyToId: MessageId.nullable().optional(),
    mentions: z.array(RoomIdentity).max(50).optional(),
    attachmentUploadIds: z.array(z.string().uuid()).max(10).optional(),
    targetParticipantIds: z.array(z.string().uuid()).max(50).optional()
  })
  .strict()

export const RoomsMessagesUpdateParams = z
  .object({
    messageId: MessageId,
    body: z.string().min(1).max(262_144)
  })
  .strict()

export const RoomsMessagesDeleteParams = z.object({ messageId: MessageId }).strict()

export const RoomsReadParams = z
  .object({
    roomId: RoomId,
    readerKey: ReaderKey,
    sequence: z.number().int().nonnegative()
  })
  .strict()

export const RoomsParticipantsAddParams = z
  .object({
    roomId: RoomId,
    identity: RoomIdentity,
    displayName: z.string().trim().min(1).max(120),
    agent: HarnessAgent,
    roleId: z.string().uuid().nullable().optional(),
    connection: ParticipantConnection,
    machineStreaming: z.boolean().optional(),
    trusted: z.boolean().optional()
  })
  .strict()

export const RoomsParticipantsRemoveParams = z.object({ participantId: ParticipantId }).strict()

export const RoomsParticipantsRevealParams = z
  .object({
    participantId: ParticipantId,
    viewMode: z.enum(['terminal', 'chat'])
  })
  .strict()

export const RoomsParticipantsUpdateParams = z
  .object({
    participantId: ParticipantId,
    identity: RoomIdentity.optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    roleId: z.string().uuid().nullable().optional(),
    participation: z.enum(['active', 'paused']).optional()
  })
  .strict()

export const RoomsParticipantsCompactParams = z.object({ participantId: ParticipantId }).strict()

export const RoomsParticipantsControlParams = z
  .object({
    participantId: ParticipantId,
    command: z.string().trim().min(1).max(256)
  })
  .strict()

export const RoomsParticipantsConfigureParams = z
  .object({
    participantId: ParticipantId,
    model: z.string().trim().min(1).max(256).optional(),
    effort: z.string().trim().min(1).max(64).optional(),
    mode: z.string().trim().min(1).max(64).optional()
  })
  .strict()

export const RoomsDeliveriesRetryParams = z.object({ deliveryId: z.string().uuid() }).strict()
