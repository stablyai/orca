import type { RgbaImage } from './pet-image-cutout'
import type { PetLegRig } from './pet-rigs'

export type DetectedRig = { legs: [PetLegRig, PetLegRig] }

export const RIG_DETECTION = {
  /** Fraction of the subject's height searched for legs, measured from the feet. */
  searchBandShare: 0.35,
  /** A column counts as leg when it carries at least this share of the band. */
  minColumnFillShare: 0.35,
  /** Legs shorter than this share of the subject read as feet, not limbs. */
  minLegHeightShare: 0.12,
  /** Each leg must be at least this wide relative to the subject. */
  minLegWidthShare: 0.06,
  alphaThreshold: 128
} as const

/** Finds two legs in an arbitrary silhouette, or admits it cannot.
 *
 *  Returning null is the important half. A wrong rig animates a seam through the
 *  middle of something that has no legs, which looks like corruption; falling
 *  back to whole-body motion merely looks calm. Every threshold below exists to
 *  make the function say no more readily than yes. */
export function detectLegs(body: RgbaImage): DetectedRig | null {
  const bounds = subjectBounds(body)
  if (!bounds) {
    return null
  }
  const subjectHeight = bounds.y1 - bounds.y0 + 1
  const subjectWidth = bounds.x1 - bounds.x0 + 1
  const bandTop = Math.max(
    bounds.y0,
    bounds.y1 - Math.floor(subjectHeight * RIG_DETECTION.searchBandShare)
  )
  const bandHeight = bounds.y1 - bandTop + 1
  if (bandHeight < 2) {
    return null
  }

  // Columns carrying real mass through the band are leg candidates; the rest is
  // background or the odd protruding foot.
  const filled: boolean[] = []
  for (let x = bounds.x0; x <= bounds.x1; x++) {
    let count = 0
    for (let y = bandTop; y <= bounds.y1; y++) {
      if (isOpaque(body, x, y)) {
        count++
      }
    }
    filled.push(count / bandHeight >= RIG_DETECTION.minColumnFillShare)
  }

  const runs = fillRuns(filled, bounds.x0)
  // Why: exactly two. One is a pillar with no gap to swing about, three or more
  // is a fence or a fringe — neither is a pair of legs.
  if (runs.length !== 2) {
    return null
  }

  const minWidth = Math.max(1, subjectWidth * RIG_DETECTION.minLegWidthShare)
  const minHeight = Math.max(2, subjectHeight * RIG_DETECTION.minLegHeightShare)
  const legs = runs.map((run) => {
    const top = legTop(body, run, bounds.y1)
    return {
      box: [run.x0, top, run.x1 + 1, bounds.y1 + 1] as const,
      pivot: [Math.round((run.x0 + run.x1) / 2), top] as const,
      width: run.x1 - run.x0 + 1,
      height: bounds.y1 - top + 1
    }
  })
  if (legs.some((leg) => leg.width < minWidth || leg.height < minHeight)) {
    return null
  }

  return {
    legs: [
      { box: legs[0].box, pivot: legs[0].pivot, mirror: true },
      { box: legs[1].box, pivot: legs[1].pivot }
    ]
  }
}

function isOpaque(body: RgbaImage, x: number, y: number): boolean {
  return body.data[(y * body.width + x) * 4 + 3] >= RIG_DETECTION.alphaThreshold
}

function subjectBounds(body: RgbaImage): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = body.width
  let y0 = body.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < body.height; y++) {
    for (let x = 0; x < body.width; x++) {
      if (!isOpaque(body, x, y)) {
        continue
      }
      if (x < x0) {
        x0 = x
      }
      if (x > x1) {
        x1 = x
      }
      if (y < y0) {
        y0 = y
      }
      if (y > y1) {
        y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

function fillRuns(filled: boolean[], offsetX: number): { x0: number; x1: number }[] {
  const runs: { x0: number; x1: number }[] = []
  let start = -1
  filled.forEach((isFilled, index) => {
    if (isFilled && start < 0) {
      start = index
    } else if (!isFilled && start >= 0) {
      runs.push({ x0: offsetX + start, x1: offsetX + index - 1 })
      start = -1
    }
  })
  if (start >= 0) {
    runs.push({ x0: offsetX + start, x1: offsetX + filled.length - 1 })
  }
  return runs
}

/** Walks up from the feet to where the leg meets the body: the first row that
 *  spans wider than the leg is the hip, and the joint sits just under it. */
function legTop(body: RgbaImage, run: { x0: number; x1: number }, footY: number): number {
  const legWidth = run.x1 - run.x0 + 1
  for (let y = footY; y >= 0; y--) {
    let width = 0
    for (let x = run.x0; x <= run.x1; x++) {
      if (isOpaque(body, x, y)) {
        width++
      }
    }
    const outsideLeft = run.x0 > 0 && isOpaque(body, run.x0 - 1, y)
    const outsideRight = run.x1 + 1 < body.width && isOpaque(body, run.x1 + 1, y)
    if (width < legWidth || outsideLeft || outsideRight) {
      return y + 1
    }
  }
  return 0
}
