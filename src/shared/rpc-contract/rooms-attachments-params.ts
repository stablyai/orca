import { z } from 'zod'

import { ROOM_ATTACHMENT_MAX_BYTES } from '../rooms'

import { RoomId } from './rooms-schemas'

const UploadId = z.string().uuid()

const TransferId = z.string().uuid()

export const RoomsAttachmentsUploadStartParams = z
  .object({
    roomId: RoomId,
    fileName: z.string().trim().min(1).max(240),
    byteSize: z.number().int().nonnegative().max(ROOM_ATTACHMENT_MAX_BYTES)
  })
  .strict()

export const RoomsAttachmentsUploadAppendParams = z
  .object({
    uploadId: UploadId,
    offset: z.number().int().nonnegative(),
    contentBase64: z.string().max(600_000)
  })
  .strict()

export const RoomsAttachmentsUploadFinishParams = z.object({ uploadId: UploadId }).strict()

export const RoomsAttachmentsUploadCancelParams = z.object({ uploadId: UploadId }).strict()

export const RoomsAttachmentsDownloadStartParams = z
  .object({ roomId: RoomId, attachmentId: z.string().uuid() })
  .strict()

export const RoomsAttachmentsDownloadReadParams = z
  .object({ transferId: TransferId, offset: z.number().int().nonnegative() })
  .strict()

export const RoomsAttachmentsDownloadCancelParams = z.object({ transferId: TransferId }).strict()
