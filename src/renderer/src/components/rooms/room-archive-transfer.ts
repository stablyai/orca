import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { roomBlobBase64 } from './room-blob-base64'

type ExportStart = {
  transferId: string
  fileName: string
  byteLength: number
  chunkBytes: number
}

export async function exportRoomArchive(
  target: RuntimeClientTarget,
  roomId: string,
  onProgress?: (completed: number, total: number) => void
): Promise<string | null> {
  const source = await roomRpc<ExportStart>(target, 'rooms.archive.export.start', { roomId })
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
      }>(target, 'rooms.archive.export.read', { transferId: source.transferId, offset })
      await window.api.fs.appendDownloadedFileChunk({
        transferId: destination.transferId,
        contentBase64: chunk.contentBase64
      })
      offset = chunk.nextOffset
      onProgress?.(offset, source.byteLength)
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
    await roomRpc(target, 'rooms.archive.transfer.cancel', {
      transferId: source.transferId
    }).catch(() => {})
  }
}

export async function importRoomArchive(
  target: RuntimeClientTarget,
  roomId: string,
  file: File,
  onProgress?: (completed: number, total: number) => void
): Promise<void> {
  const source = await roomRpc<{ transferId: string; chunkBytes: number }>(
    target,
    'rooms.archive.import.start',
    { roomId }
  )
  try {
    for (let offset = 0; offset < file.size; offset += source.chunkBytes) {
      const contentBase64 = await roomBlobBase64(file.slice(offset, offset + source.chunkBytes))
      await roomRpc(target, 'rooms.archive.import.append', {
        transferId: source.transferId,
        contentBase64
      })
      onProgress?.(Math.min(offset + source.chunkBytes, file.size), file.size)
    }
    await roomRpc(target, 'rooms.archive.import.finish', { transferId: source.transferId })
  } catch (error) {
    await roomRpc(target, 'rooms.archive.transfer.cancel', {
      transferId: source.transferId
    }).catch(() => {})
    throw error
  }
}
