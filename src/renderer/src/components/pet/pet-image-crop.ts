import type { RgbaImage } from './pet-image-cutout'

/** A rectangle in source-image pixels. */
export type CropRect = { x: number; y: number; width: number; height: number }

/** Snaps a rectangle to whole pixels inside the image, keeping at least one. */
export function clampCropRect(rect: CropRect, width: number, height: number): CropRect {
  const x = Math.min(Math.max(0, Math.round(rect.x)), Math.max(0, width - 1))
  const y = Math.min(Math.max(0, Math.round(rect.y)), Math.max(0, height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width), width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height), height - y))
  }
}

/** Narrows the pipeline's view of an upload to one rectangle.
 *
 *  This is the user's recourse when the background defeats the cutout: framing
 *  the character themselves is information no corner flood-fill can derive. */
export function cropImage(image: RgbaImage, rect: CropRect): RgbaImage {
  const box = clampCropRect(rect, image.width, image.height)
  if (box.x === 0 && box.y === 0 && box.width === image.width && box.height === image.height) {
    return image
  }
  const data = new Uint8ClampedArray(box.width * box.height * 4)
  for (let row = 0; row < box.height; row++) {
    const from = ((box.y + row) * image.width + box.x) * 4
    data.set(image.data.subarray(from, from + box.width * 4), row * box.width * 4)
  }
  return { data, width: box.width, height: box.height }
}
