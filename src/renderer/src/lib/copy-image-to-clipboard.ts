import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { blobToBase64, convertImageBlobToPng } from '@/lib/image-blob-png'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../shared/clipboard-image'

/** Copies an image to the system clipboard as PNG and reports the result in a toast. */
export async function copyImageToClipboard(readImage: () => Promise<Blob>): Promise<void> {
  try {
    const png = await convertImageBlobToPng(await readImage())
    await window.api.ui.writeClipboardImage(`data:image/png;base64,${await blobToBase64(png)}`)
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
