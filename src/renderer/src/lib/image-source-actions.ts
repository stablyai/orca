import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { copyImageToClipboard } from './clipboard-image-copy'
import { blobToBase64 } from './image-blob-png'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../shared/clipboard-image'

export type ReadImageSource = () => Promise<Blob>

async function readImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src)
  if (!response.ok) {
    throw new Error(`Image request failed (HTTP ${response.status})`)
  }
  const blob = await response.blob()
  if (blob.type.split(';', 1)[0] === 'text/html') {
    throw new Error('The image URL returned a web page')
  }
  return blob
}

/** Capture revocable sources before a closing menu can release their cache lease. */
export function captureImageSource(src: string): ReadImageSource {
  if (/^https?:/i.test(src)) {
    return () => readImageBlob(src)
  }
  const image = readImageBlob(src)
  image.catch(() => {})
  return () => image
}

export async function copyImageSource(image: ReadImageSource): Promise<void> {
  try {
    await copyImageToClipboard(await image())
    toast.success(translate('components.native-chat.composer.imageCopied', 'Image copied'))
  } catch (error) {
    toast.error(
      translate('components.native-chat.composer.copyImageFailed', "Couldn't copy image"),
      {
        description:
          error instanceof Error && error.message === CLIPBOARD_IMAGE_TOO_LARGE_ERROR
            ? translate(
                'components.native-chat.composer.copyImageTooLarge',
                'The image is too large to copy.'
              )
            : undefined
      }
    )
  }
}

export function imageDownloadName(src: string, title: string, mime: string, path?: string): string {
  const imageExtension = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?)$/i
  let filename = path?.split(/[/\\]/).pop()
  if (!filename && /^https?:/i.test(src)) {
    try {
      filename = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '')
      if (!imageExtension.test(filename)) {
        filename = undefined
      }
    } catch {
      // Malformed URL escapes must not prevent saving the displayed bytes.
    }
  }
  if (filename && /\.[a-z0-9]+$/i.test(filename)) {
    return filename
  }
  if (imageExtension.test(title)) {
    return title.split(/[/\\]/).pop() ?? title
  }
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/tiff': 'tiff'
  }
  return `Image.${extensions[mime.split(';', 1)[0]] ?? 'img'}`
}

export async function saveImageSource(image: ReadImageSource, suggestedName: string) {
  return window.api.fs.saveDownloadedFile({
    suggestedName,
    content: await blobToBase64(await image()),
    encoding: 'base64'
  })
}
