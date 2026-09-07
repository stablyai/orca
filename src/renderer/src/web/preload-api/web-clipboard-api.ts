import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  clipboardImageThumbnailSize,
  type ClipboardImageThumbnail
} from '../../../../shared/clipboard-image'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../../../shared/clipboard-text'
import { saveClipboardImageBase64ThroughRuntime } from '../../../../shared/clipboard-image-upload-protocol'
import { copyClipboardTextViaExecCommand } from '../web-clipboard-copy-fallback'
import { callRuntimeEnvelope } from './web-runtime-calls'

export const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS

export const MAX_CLIPBOARD_IMAGE_SOURCE_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES

export const MAX_CLIPBOARD_IMAGE_PIXELS = CLIPBOARD_IMAGE_MAX_PIXELS

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'))
    reader.readAsDataURL(blob)
  })
}

export function assertClipboardImageBlobWithinLimit(blob: Blob): void {
  assertClipboardImageByteLengthWithinLimit(blob.size)
}

export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  assertClipboardImageBlobWithinLimit(blob)
  const bitmap = await createImageBitmap(blob)
  try {
    assertClipboardImageDimensionsWithinLimit(bitmap)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      throw new Error('Clipboard image could not be decoded')
    }
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (!png) {
          reject(new Error('Clipboard image could not be encoded as PNG'))
          return
        }
        try {
          assertClipboardImageBlobWithinLimit(png)
        } catch (error) {
          reject(error)
          return
        }
        resolve(png)
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
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

/** Web counterpart of the main-process clipboard probe: decodes the clipboard
 *  image once and returns a small preview so the composer can show a chip while
 *  the full image is still being uploaded to the runtime. */
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
    const pngBlob = imageType === 'image/png' ? blob : await convertImageBlobToPng(blob)
    return blobToBase64(pngBlob)
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

export async function saveClipboardImageAsTempFileInRuntime(
  contentBase64: string,
  args?: { connectionId?: string | null; runtimeEnvironmentId?: string | null }
): Promise<string> {
  if (contentBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
  return saveClipboardImageBase64ThroughRuntime(
    (method, params, timeoutMs) => callRuntimeEnvelope(method, params, timeoutMs),
    contentBase64,
    args?.connectionId ?? null
  )
}
