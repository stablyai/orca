import type { RgbaImage } from './pet-image-cutout'

/** Canvas edge of the image pipeline.
 *
 *  Deliberately logic-free: everything that decides anything lives in the pure
 *  modules so it can be tested without a rasteriser. This file only moves pixels
 *  between a File, an `RgbaImage` and an encoded sheet. */

/** Guards against a decompression bomb — a small file can declare huge dimensions. */
export const MAX_SOURCE_PIXELS = 4096 * 4096

export async function decodeImageFile(file: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
      throw new Error('Image is too large to turn into a pet.')
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('Could not read the image.')
    }
    context.imageSmoothingEnabled = false
    context.drawImage(bitmap, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { data, width, height }
  } finally {
    bitmap.close()
  }
}

function toCanvas(image: RgbaImage): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not draw the generated sheet.')
  }
  // Why: `RgbaImage` allows any ArrayBufferLike, but ImageData insists on a plain
  // ArrayBuffer. Copy rather than cast — a SharedArrayBuffer really would fail here.
  const pixels = new Uint8ClampedArray(image.width * image.height * 4)
  pixels.set(image.data)
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0)
  return canvas
}

/** Encodes losslessly: the sheet is already quantised by the pipeline, and a
 *  lossy pass would reintroduce the halos the cutout just removed. */
export async function encodeSheetToWebp(sheet: RgbaImage): Promise<ArrayBuffer> {
  const blob = await toCanvas(sheet).convertToBlob({ type: 'image/webp', quality: 1 })
  return blob.arrayBuffer()
}

export async function sheetToDataUrl(sheet: RgbaImage): Promise<string> {
  const blob = await toCanvas(sheet).convertToBlob({ type: 'image/webp', quality: 1 })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not preview the generated sheet.'))
    reader.readAsDataURL(blob)
  })
}
