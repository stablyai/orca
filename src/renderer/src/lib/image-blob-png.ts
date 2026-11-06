import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  encodeClipboardImageWithinLimit,
  type ClipboardImageDimensions
} from '../../../shared/clipboard-image'

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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Why: a file's type comes from its extension, so a WebP named .png must still be converted.
async function hasPngSignature(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer())
  return PNG_SIGNATURE.every((byte, index) => head[index] === byte)
}

function encodeImagePng(
  image: HTMLImageElement,
  { height, width }: ClipboardImageDimensions
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Clipboard image could not be decoded')
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((png) => {
      if (png) {
        resolve(png)
      } else {
        reject(new Error('Clipboard image could not be encoded as PNG'))
      }
    }, 'image/png')
  })
}

// Pastes shrink to fit the save limit; copies keep full size and fail instead of silently degrading.
export async function convertImageBlobToPng(
  blob: Blob,
  { downscaleToFit = false }: { downscaleToFit?: boolean } = {}
): Promise<Blob> {
  assertClipboardImageByteLengthWithinLimit(blob.size)
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    const pastedOverPixelCap = downscaleToFit && width * height > CLIPBOARD_IMAGE_MAX_PIXELS
    // Why: re-encoding a PNG costs time and can grow it past the clipboard size limit.
    if (!pastedOverPixelCap && (await hasPngSignature(blob))) {
      assertClipboardImageDimensionsWithinLimit({ width, height })
      return blob
    }
    if (!downscaleToFit) {
      assertClipboardImageDimensionsWithinLimit({ width, height })
      const png = await encodeImagePng(image, { width, height })
      assertClipboardImageByteLengthWithinLimit(png.size)
      return png
    }
    return await encodeClipboardImageWithinLimit(
      { width, height },
      (size) => encodeImagePng(image, size),
      (png) => png.size
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}
