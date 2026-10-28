import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
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

export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  assertClipboardImageByteLengthWithinLimit(blob.size)
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    assertClipboardImageDimensionsWithinLimit({ width, height })
    // Why: re-encoding a PNG costs time and can grow it past the clipboard size limit.
    if (await hasPngSignature(blob)) {
      return blob
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      throw new Error('Clipboard image could not be decoded')
    }
    context.drawImage(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (!png) {
          reject(new Error('Clipboard image could not be encoded as PNG'))
          return
        }
        try {
          assertClipboardImageByteLengthWithinLimit(png.size)
        } catch (error) {
          reject(error)
          return
        }
        resolve(png)
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
