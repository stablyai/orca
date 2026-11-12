import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile
} from '@/lib/files/drop/browser-attachment-files'
import { decodeBase64Bytes, encodeBase64Bytes } from '@/lib/base64-bytes'
import {
  agentSessionPastedImageName,
  type AgentSessionAttachmentClipboardTarget,
  type AgentSessionAttachmentPathUploadResult
} from '../../../../shared/agent-session/agent-session-attachments'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { saveClipboardImageAsWebAgentSessionAttachment } from './web-agent-session-attachment-upload'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  RUNTIME_TEMP_UPLOAD_MAX_TOTAL_BYTES,
  runtimeTempUploadTotalReason,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR,
  assertClipboardImageByteLengthWithinLimit,
  assertNamedTempUploadKeptName,
  assertClipboardImageDimensionsWithinLimit,
  clipboardFormatsIncludeImage,
  clipboardImageThumbnailSize,
  type ClipboardImageThumbnail
} from '../../../../shared/clipboard-image'
import { withSniffedImageExtension } from '../../../../shared/image-file-signature'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../../../shared/clipboard-text'
import { blobToBase64, convertImageBlobToPng } from '@/lib/clipboard/images/image-blob-png'
import { copyClipboardTextViaExecCommand } from '../web-clipboard-copy-fallback'
import { callEnvironmentEnvelope, callRuntimeEnvelope } from './web-runtime-calls'

export const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS

export const MAX_CLIPBOARD_IMAGE_SOURCE_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES

export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024

export const CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024

export const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 30_000

export function assertClipboardImageBlobWithinLimit(blob: Blob): void {
  assertClipboardImageByteLengthWithinLimit(blob.size)
}

async function readClipboardImageBlob(): Promise<Blob | null> {
  const clipboard = navigator.clipboard as
    | (Clipboard & { read?: () => Promise<ClipboardItem[]> })
    | undefined
  if (!clipboard?.read) {
    return null
  }
  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (imageType) {
      return item.getType(imageType)
    }
  }
  return null
}

/** Decode once for a small composer preview while the full clipboard image uploads to the runtime. */
export async function readClipboardImageThumbnail(): Promise<ClipboardImageThumbnail | null> {
  const blob = await readClipboardImageBlob()
  if (!blob) {
    return null
  }
  assertClipboardImageBlobWithinLimit(blob)
  const bitmap = await createImageBitmap(blob)
  try {
    assertClipboardImageDimensionsWithinLimit(bitmap)
    const thumbnailSize = clipboardImageThumbnailSize(bitmap)
    const canvas = document.createElement('canvas')
    canvas.width = thumbnailSize.width
    canvas.height = thumbnailSize.height
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    context.drawImage(bitmap, 0, 0, thumbnailSize.width, thumbnailSize.height)
    return { dataUrl: canvas.toDataURL('image/png'), height: bitmap.height, width: bitmap.width }
  } finally {
    bitmap.close()
  }
}

export async function readClipboardImagePngBase64(): Promise<string | null> {
  const clipboard = navigator.clipboard as
    | (Clipboard & { read?: () => Promise<ClipboardItem[]> })
    | undefined
  if (!clipboard?.read) {
    return null
  }
  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (!imageType) {
      continue
    }
    const blob = await item.getType(imageType)
    assertClipboardImageBlobWithinLimit(blob)
    return blobToBase64(await convertImageBlobToPng(blob, { downscaleToFit: true }))
  }
  return null
}

export async function writeWebClipboardText(text: string): Promise<void> {
  await assertClipboardTextWriteWithinLimitWithYield(text)
  const clipboard = navigator.clipboard
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return
    } catch (error) {
      // Preserve the current user-activation turn for the synchronous fallback.
      if (copyClipboardTextViaExecCommand(text)) {
        return
      }
      throw error
    }
  }
  if (!copyClipboardTextViaExecCommand(text)) {
    throw new Error('Clipboard write is unavailable in this browser context')
  }
}

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

export async function writeWebClipboardImage(dataUrl: string): Promise<void> {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Clipboard image must be a PNG data URL')
  }
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
    throw new Error('Image clipboard is unavailable in this browser context')
  }
  const binary = atob(dataUrl.slice(PNG_DATA_URL_PREFIX.length))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  assertClipboardImageBlobWithinLimit(new Blob([bytes]))
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })
  ])
}

/** Save bytes in the paired server's temp folder, as a pasted image or, with `fileName`, under the file's own name. */
export async function saveClipboardImageAsTempFileInRuntime(
  contentBase64: string,
  args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
    /** Keeps a dropped file's own name in the server's temp folder. */
    fileName?: string
  }
): Promise<string> {
  if (contentBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
  const connectionId = args?.connectionId ?? null
  // Every call goes to the requested server, so a re-pair mid-upload fails instead of landing elsewhere.
  const environmentId = args?.runtimeEnvironmentId ?? null
  const envelope = <TResult>(method: string, params: unknown) =>
    environmentId
      ? callEnvironmentEnvelope<TResult>(
          environmentId,
          method,
          params,
          CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
        )
      : callRuntimeEnvelope<TResult>(method, params, CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS)
  const result = async <TResult>(method: string, params: unknown): Promise<TResult> => {
    const response = await envelope<TResult>(method, params)
    if (!response.ok) {
      throw Object.assign(new Error(response.error.message), { code: response.error.code })
    }
    return response.result
  }
  const startResponse = await envelope<{ uploadId: string }>('clipboard.startImageUpload', {
    expectedBase64Length: contentBase64.length,
    connectionId,
    ...(args?.fileName ? { fileName: args.fileName } : {})
  })
  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      // The single-frame method cannot carry a name; a named file must not land as an image.
      !args?.fileName &&
      contentBase64.length <= CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return result<string>('clipboard.saveImageAsTempFile', { contentBase64, connectionId })
    }
    throw new Error(startResponse.error.message)
  }

  const { uploadId } = startResponse.result
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      await result('clipboard.appendImageUploadChunk', {
        uploadId,
        offset,
        contentBase64: contentBase64.slice(
          offset,
          offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
        )
      })
    }
    const remotePath = await result<string>('clipboard.commitImageUpload', { uploadId })
    if (args?.fileName) {
      assertNamedTempUploadKeptName(remotePath)
    }
    return remotePath
  } catch (error) {
    // Why: after chunked paste holds server-side state, release the bounded slot on failure rather than wait for TTL cleanup.
    await result('clipboard.abortImageUpload', { uploadId }).catch(() => {})
    throw error
  }
}

export async function clipboardHasImage(): Promise<boolean | null> {
  if (!navigator.clipboard?.read) {
    return null
  }
  const items = await navigator.clipboard.read()
  return items.some((item) => clipboardFormatsIncludeImage(item.types))
}

export async function saveWebClipboardImageAsTempFile(args?: {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  forNativeChatDraft?: boolean
  forStructuredChat?: boolean
}) {
  if (!requireActiveEnvironmentOrNull()) {
    return null
  }
  const contentBase64 = await readClipboardImagePngBase64()
  if (!contentBase64) {
    return null
  }
  if (args?.forNativeChatDraft && args.forStructuredChat && !args.agentSessionAttachment) {
    return holdBrowserAttachmentFiles([
      new File(
        [decodeBase64Bytes(contentBase64)],
        agentSessionPastedImageName(Date.now(), createBrowserUuid()),
        { type: 'image/png' }
      )
    ])[0]
  }
  if (args?.agentSessionAttachment) {
    if (!args.runtimeEnvironmentId) {
      throw new Error('A chat attachment needs the server the chat runs on.')
    }
    return saveClipboardImageAsWebAgentSessionAttachment(contentBase64, {
      ...args.agentSessionAttachment,
      environmentId: args.runtimeEnvironmentId
    })
  }
  return saveClipboardImageAsTempFileInRuntime(contentBase64, args)
}

const TEMP_FILE_MAX_MEGABYTES = Math.floor(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES / (1024 * 1024))

/** Upload picked/dropped files to the paired server's temp folder for a terminal-backed chat, as desktop does. */
export async function uploadBrowserFilesToWebRuntimeTempFiles(args: {
  environmentId: string
  paths: readonly string[]
}): Promise<AgentSessionAttachmentPathUploadResult> {
  const result: AgentSessionAttachmentPathUploadResult = { uploaded: [], skipped: [], failed: [] }
  let sentBytes = 0
  for (const sourcePath of args.paths) {
    const file = readBrowserAttachmentFile(sourcePath)
    if (!file) {
      result.failed.push({ sourcePath, reason: 'Attach the file again.' })
      continue
    }
    if (file.size > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
      result.failed.push({
        sourcePath,
        reason: `'${file.name}' is over the ${TEMP_FILE_MAX_MEGABYTES} MB chat attachment limit`
      })
      continue
    }
    if (sentBytes + file.size > RUNTIME_TEMP_UPLOAD_MAX_TOTAL_BYTES) {
      result.failed.push({ sourcePath, reason: runtimeTempUploadTotalReason(file.name) })
      continue
    }
    sentBytes += file.size
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const path = await saveClipboardImageAsTempFileInRuntime(encodeBase64Bytes(bytes), {
        runtimeEnvironmentId: args.environmentId,
        // Like desktop staging: an extensionless image keeps an image name, so it lands as a chip.
        fileName: withSniffedImageExtension(file.name, bytes)
      })
      result.uploaded.push({ sourcePath, path })
    } catch (error) {
      result.failed.push({
        sourcePath,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}
