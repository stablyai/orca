import type {
  TrelloAttachment,
  TrelloImageDownloadResult,
  TrelloUploadAttachmentArgs
} from '../../../shared/types'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

const REMOTE_TRELLO_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024

export async function uploadTrelloAttachmentThroughRuntime(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  args: TrelloUploadAttachmentArgs
): Promise<{ ok: true; attachment: TrelloAttachment } | { ok: false; error: string }> {
  let uploadId: string | undefined
  try {
    const start = await callRuntimeRpc<{ uploadId: string }>(
      target,
      'trello.startUpload',
      {
        cardId: args.cardId.trim(),
        name: args.name.trim(),
        mimeType: args.mimeType,
        expectedBase64Length: args.contentBase64.length
      },
      { timeoutMs: 30_000 }
    )
    uploadId = start.uploadId

    for (
      let offset = 0;
      offset < args.contentBase64.length;
      offset += REMOTE_TRELLO_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      await callRuntimeRpc<{ receivedBase64Length: number }>(
        target,
        'trello.appendUploadChunk',
        {
          uploadId,
          offset,
          contentBase64: args.contentBase64.slice(
            offset,
            offset + REMOTE_TRELLO_UPLOAD_CHUNK_BASE64_CHARS
          )
        },
        { timeoutMs: 30_000 }
      )
    }

    return await callRuntimeRpc<
      { ok: true; attachment: TrelloAttachment } | { ok: false; error: string }
    >(target, 'trello.commitUpload', { uploadId }, { timeoutMs: 60_000 })
  } catch (error) {
    if (uploadId) {
      await callRuntimeRpc(target, 'trello.abortUpload', { uploadId }, { timeoutMs: 5_000 }).catch(
        () => {}
      )
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Attachment upload failed.'
    }
  }
}

export async function downloadTrelloImageThroughRuntime(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  url: string
): Promise<TrelloImageDownloadResult> {
  let downloadId: string | undefined
  try {
    const start = await callRuntimeRpc<{
      downloadId: string
      contentType: string
      totalBase64Length: number
      chunkSize: number
    }>(target, 'trello.startDownload', { url }, { timeoutMs: 30_000 })
    downloadId = start.downloadId

    const chunks: string[] = []
    for (let offset = 0; offset < start.totalBase64Length; offset += start.chunkSize) {
      const length = Math.min(start.chunkSize, start.totalBase64Length - offset)
      const chunk = await callRuntimeRpc<{ contentBase64: string }>(
        target,
        'trello.readDownloadChunk',
        { downloadId, offset, length },
        { timeoutMs: 30_000 }
      )
      chunks.push(chunk.contentBase64)
    }

    return {
      ok: true,
      contentType: start.contentType,
      contentBase64: chunks.join('')
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Image download failed.'
    }
  } finally {
    if (downloadId) {
      await callRuntimeRpc(
        target,
        'trello.abortDownload',
        { downloadId },
        { timeoutMs: 5_000 }
      ).catch(() => {})
    }
  }
}
