import { clampCropRect, type CropRect } from './pet-image-crop'

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }

/** Turns a drag across the preview into a rectangle in source pixels.
 *
 *  The preview is a scaled copy, so the drag has to be read back through that
 *  scale before it means anything to the pipeline. */
export function rectFromDrag(start: Point, end: Point, display: Size, image: Size): CropRect {
  if (display.width <= 0 || display.height <= 0) {
    return { x: 0, y: 0, width: image.width, height: image.height }
  }
  const scaleX = image.width / display.width
  const scaleY = image.height / display.height
  const x0 = Math.min(start.x, end.x) * scaleX
  const y0 = Math.min(start.y, end.y) * scaleY
  const x1 = Math.max(start.x, end.x) * scaleX
  const y1 = Math.max(start.y, end.y) * scaleY
  return clampCropRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, image.width, image.height)
}
