import type { CutoutBounds } from './pet-cutout-quality'
import type { RgbaImage } from './pet-image-cutout'
import type { PetRig } from './pet-rigs'

export type ResampleTarget = {
  frame: { width: number; height: number }
  /** Row the subject's feet land on; it is exclusive, like a floor surface. */
  floorY: number
  /** Share of the width the subject may span, leaving air at the sides. */
  maxWidthShare?: number
}

const DEFAULT_MAX_WIDTH_SHARE = 0.9

/** The line a pet's feet rest on: the bottom of its leg boxes. */
export function petFloorY(rig: PetRig): number {
  return Math.max(...rig.legs.map((leg) => leg.box[3]))
}

/** Fits a cut-out subject into a pet's frame, standing on the floor line.
 *
 *  Nearest-neighbour on purpose: the pets have hard silhouette edges, and
 *  smoothing an upload against them makes it read as a photo pasted onto a
 *  drawing. Aspect ratio is preserved — squashing a face to fill the frame is
 *  worse than leaving air. */
export function resampleSubject(
  image: RgbaImage,
  mask: Uint8Array,
  bounds: CutoutBounds,
  target: ResampleTarget
): RgbaImage {
  const { width: fw, height: fh } = target.frame
  const out = new Uint8ClampedArray(fw * fh * 4)

  const srcW = bounds.x1 - bounds.x0 + 1
  const srcH = bounds.y1 - bounds.y0 + 1
  const maxW = fw * (target.maxWidthShare ?? DEFAULT_MAX_WIDTH_SHARE)
  // Why: the headroom is what sits ABOVE the floor, not the whole frame — a pet
  // standing on a high floor line has less room, and must shrink rather than
  // sink through it.
  const maxH = Math.max(1, target.floorY)
  const scale = Math.min(maxW / srcW, maxH / srcH)

  const drawW = Math.max(1, Math.round(srcW * scale))
  const drawH = Math.max(1, Math.round(srcH * scale))
  const originX = Math.round((fw - drawW) / 2)
  const originY = target.floorY - drawH

  for (let dy = 0; dy < drawH; dy++) {
    const ty = originY + dy
    if (ty < 0 || ty >= fh) {
      continue
    }
    const sy = bounds.y0 + Math.min(srcH - 1, Math.floor((dy * srcH) / drawH))
    for (let dx = 0; dx < drawW; dx++) {
      const tx = originX + dx
      if (tx < 0 || tx >= fw) {
        continue
      }
      const sx = bounds.x0 + Math.min(srcW - 1, Math.floor((dx * srcW) / drawW))
      const sp = sy * image.width + sx
      if (mask[sp] < 128) {
        continue
      }
      const si = sp * 4
      const ti = (ty * fw + tx) * 4
      out[ti] = image.data[si]
      out[ti + 1] = image.data[si + 1]
      out[ti + 2] = image.data[si + 2]
      // Why not 255: an upload that arrived with its own alpha was cut out by
      // someone with more to work with than a corner fill, and hardening its
      // feathered edge is the one thing that makes it look pasted on.
      out[ti + 3] = image.data[si + 3]
    }
  }

  return { data: out, width: fw, height: fh }
}
