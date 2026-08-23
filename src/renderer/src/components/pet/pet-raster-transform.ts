import type { RgbaImage } from './pet-image-cutout'

export type RasterTransform = {
  /** Point both rotation and scale act about, in destination coordinates. */
  pivotX?: number
  pivotY?: number
  rotateDeg?: number
  scaleX?: number
  scaleY?: number
  translateX?: number
  translateY?: number
  /** Half-open destination rectangle the draw may write to. Without one a
   *  rotated pose swings out of its sprite cell and over the neighbouring one. */
  clip?: { x0: number; y0: number; x1: number; y1: number }
}

export function blankImage(width: number, height: number): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

/** Draws `src` into `dst` under an affine transform, nearest-neighbour.
 *
 *  Inverse mapping — walk destination pixels and ask where each came from —
 *  because the forward direction leaves holes wherever the transform stretches.
 *  Nearest-neighbour rather than a filter: these are hard-edged sprites, and
 *  smoothing them produces halos the chroma pass then has to fight. */
export function drawTransformed(dst: RgbaImage, src: RgbaImage, t: RasterTransform): void {
  const rotate = ((t.rotateDeg ?? 0) * Math.PI) / 180
  const scaleX = t.scaleX ?? 1
  const scaleY = t.scaleY ?? 1
  const pivotX = t.pivotX ?? 0
  const pivotY = t.pivotY ?? 0
  const translateX = t.translateX ?? 0
  const translateY = t.translateY ?? 0
  if (scaleX === 0 || scaleY === 0) {
    return
  }

  // Forward is: translate ∘ pivot ∘ rotate ∘ scale. Inverting it lets each
  // destination pixel look up its own source, so no gaps appear when scaling up.
  const cos = Math.cos(rotate)
  const sin = Math.sin(rotate)

  const clip = t.clip
  const minX = Math.max(0, clip ? Math.ceil(clip.x0) : 0)
  const minY = Math.max(0, clip ? Math.ceil(clip.y0) : 0)
  const maxX = Math.min(dst.width, clip ? Math.ceil(clip.x1) : dst.width)
  const maxY = Math.min(dst.height, clip ? Math.ceil(clip.y1) : dst.height)

  for (let dy = minY; dy < maxY; dy++) {
    for (let dx = minX; dx < maxX; dx++) {
      const px = dx - translateX - pivotX
      const py = dy - translateY - pivotY
      const rx = px * cos + py * sin
      const ry = -px * sin + py * cos
      const sx = Math.round(rx / scaleX + pivotX)
      const sy = Math.round(ry / scaleY + pivotY)
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) {
        continue
      }
      const si = (sy * src.width + sx) * 4
      if (src.data[si + 3] < 128) {
        continue
      }
      const di = (dy * dst.width + dx) * 4
      dst.data[di] = src.data[si]
      dst.data[di + 1] = src.data[si + 1]
      dst.data[di + 2] = src.data[si + 2]
      dst.data[di + 3] = src.data[si + 3]
    }
  }
}
