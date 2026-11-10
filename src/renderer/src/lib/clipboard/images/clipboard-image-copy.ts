import { translate } from '@/i18n/i18n'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../../../shared/clipboard-image'
import { blobToBase64, convertImageBlobToPng } from './image-blob-png'

export async function copyImageToClipboard(blob: Blob): Promise<void> {
  const png = await convertImageBlobToPng(blob)
  await window.api.ui.writeClipboardImage(`data:image/png;base64,${await blobToBase64(png)}`)
}

export function imageCopyFailedMessage(): string {
  return translate(
    'auto.components.editor.PanZoomImageDialog.copyPngFailed',
    'Could not copy image'
  )
}

/** Explains a refused image copy; IPC prefixes main's message, so match it anywhere. */
export function clipboardImageCopyErrorDescription(error: unknown): string | undefined {
  return error instanceof Error && error.message.includes(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
    ? translate(
        'components.native-chat.composer.copyImageTooLarge',
        'The image is too large to copy.'
      )
    : undefined
}
