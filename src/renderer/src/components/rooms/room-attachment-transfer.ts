import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomAttachment } from '../../../../shared/rooms'
import { roomBlobBase64 } from './room-blob-base64'

export type PendingRoomAttachment = {
  uploadId: string
  fileName: string
  byteSize: number
}

export async function uploadRoomAttachment(
  target: RuntimeClientTarget,
  roomId: string,
  file: File,
  onProgress?: (completed: number, total: number) => void
): Promise<PendingRoomAttachment> {
  const transfer = await roomRpc<{ uploadId: string; chunkBytes: number }>(
    target,
    'rooms.attachments.upload.start',
    { roomId, fileName: file.name, byteSize: file.size }
  )
  try {
    let offset = 0
    while (offset < file.size) {
      const contentBase64 = await roomBlobBase64(file.slice(offset, offset + transfer.chunkBytes))
      const result = await roomRpc<{ nextOffset: number }>(
        target,
        'rooms.attachments.upload.append',
        { uploadId: transfer.uploadId, offset, contentBase64 }
      )
      offset = result.nextOffset
      onProgress?.(offset, file.size)
    }
    await roomRpc(target, 'rooms.attachments.upload.finish', { uploadId: transfer.uploadId })
    return { uploadId: transfer.uploadId, fileName: file.name, byteSize: file.size }
  } catch (error) {
    await cancelRoomAttachmentUpload(target, transfer.uploadId)
    throw error
  }
}

export async function cancelRoomAttachmentUpload(
  target: RuntimeClientTarget,
  uploadId: string
): Promise<void> {
  await roomRpc(target, 'rooms.attachments.upload.cancel', { uploadId }).catch(() => {})
}

export async function downloadRoomAttachment(
  target: RuntimeClientTarget,
  roomId: string,
  attachment: RoomAttachment
): Promise<string | null> {
  const source = await roomRpc<{
    transferId: string
    fileName: string
    byteLength: number
  }>(target, 'rooms.attachments.download.start', {
    roomId,
    attachmentId: attachment.id
  })
  let destinationTransferId: string | null = null
  try {
    const destination = await window.api.fs.startDownloadedFile({ suggestedName: source.fileName })
    if (destination.canceled) {
      return null
    }
    destinationTransferId = destination.transferId
    let offset = 0
    while (offset < source.byteLength) {
      const chunk = await roomRpc<{
        contentBase64: string
        nextOffset: number
        done: boolean
      }>(target, 'rooms.attachments.download.read', { transferId: source.transferId, offset })
      await window.api.fs.appendDownloadedFileChunk({
        transferId: destination.transferId,
        contentBase64: chunk.contentBase64
      })
      offset = chunk.nextOffset
      if (chunk.done) {
        break
      }
    }
    const result = await window.api.fs.finishDownloadedFile({ transferId: destination.transferId })
    destinationTransferId = null
    return result.destinationPath
  } finally {
    if (destinationTransferId) {
      await window.api.fs
        .cancelDownloadedFile({ transferId: destinationTransferId })
        .catch(() => {})
    }
    await roomRpc(target, 'rooms.attachments.download.cancel', {
      transferId: source.transferId
    }).catch(() => {})
  }
}
