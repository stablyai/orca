import { z } from 'zod'

import { MessageId, RoomId } from './rooms-schemas'

const TransferId = z.string().uuid()

const ArchiveChunk = z.string().max(600_000)

export const RoomsDeleteParams = z.object({ roomId: RoomId }).strict()

export const RoomsArchiveExportStartParams = z.object({ roomId: RoomId }).strict()

export const RoomsArchiveExportReadParams = z
  .object({ transferId: TransferId, offset: z.number().int().nonnegative() })
  .strict()

export const RoomsArchiveImportStartParams = z.object({ roomId: RoomId }).strict()

export const RoomsArchiveImportAppendParams = z
  .object({ transferId: TransferId, contentBase64: ArchiveChunk })
  .strict()

export const RoomsArchiveImportFinishParams = z.object({ transferId: TransferId }).strict()

export const RoomsArchiveTransferCancelParams = z.object({ transferId: TransferId }).strict()

export const RoomsUpdateParams = z
  .object({
    roomId: RoomId,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(4000).optional(),
    loopLimit: z.number().int().min(0).max(20).optional(),
    worktreeId: z.string().trim().min(1).max(1024).nullable().optional()
  })
  .strict()

export const RoomsRolesSaveParams = z
  .object({
    roleId: z.string().uuid().optional(),
    roomId: RoomId,
    name: z.string().trim().min(1).max(80),
    prompt: z.string().max(4000)
  })
  .strict()

export const RoomsRolesDeleteParams = z.object({ roleId: z.string().uuid() }).strict()

export const RoomsPinsSetParams = z
  .object({
    roomId: RoomId,
    messageId: MessageId,
    status: z.enum(['todo', 'done'])
  })
  .strict()

export const RoomsPinsRemoveParams = z.object({ roomId: RoomId, messageId: MessageId }).strict()
