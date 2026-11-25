import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
}

/** The viewer's title as a file name, with an extension that matches the image's type. */
function imageDownloadFileName(title: string, type: string): string {
  const base = title.replace(/[/\\:*?"<>|]+/g, '-').trim() || 'image'
  const extension = EXTENSION_BY_TYPE[type]
  return extension && !/\.[a-z0-9]{2,5}$/i.test(base) ? `${base}.${extension}` : base
}

/** Saves the shown image as a file; the browser (or Electron's save dialog) picks where. */
export async function downloadImage(src: string, title: string): Promise<void> {
  try {
    const response = await fetch(src)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = imageDownloadFileName(title, blob.type)
    link.click()
    // The download has its own copy of the bytes once started.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) {
    toast.error(
      translate(
        'auto.components.editor.PanZoomImageDialog.downloadFailed',
        'Could not download the image'
      ),
      { description: error instanceof Error ? error.message : undefined }
    )
  }
}
