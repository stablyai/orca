import { blobToBase64, convertImageBlobToPng } from './image-blob-png'

export async function copyImageToClipboard(blob: Blob): Promise<void> {
  const png = await convertImageBlobToPng(blob)
  await window.api.ui.writeClipboardImage(`data:image/png;base64,${await blobToBase64(png)}`)
}
