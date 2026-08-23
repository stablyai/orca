/** Why a cutout is not usable as a pet. Each maps to advice the user can act on. */
export type CutoutRejection =
  | 'background-not-separable'
  | 'subject-not-found'
  | 'subject-fragmented'
  | 'full-bleed'
  | 'no-character-shape'

export type CutoutBounds = { x0: number; y0: number; x1: number; y1: number }

export type CutoutVerdict =
  | { ok: true; bounds: CutoutBounds }
  | { ok: false; reason: CutoutRejection }

/** Where the mask came from. `alpha` means the image arrived with its own cutout,
 *  so someone already made these judgements and we do not overrule them. */
export type CutoutSource = 'alpha' | 'derived'

/** Starting points, gathered in one place because they will need tuning against
 *  real uploads. Every one is a fraction, never a pixel count, so they hold at
 *  any resolution. */
export const CUTOUT_LIMITS = {
  /** Above this the fill removed nothing — the background was not separable. */
  maxCoverage: 0.85,
  /** Below this nothing recognisable survived. */
  minCoverage: 0.03,
  /** The subject has to be mostly one piece, not a scatter of specks. */
  minLargestComponentShare: 0.6,
  /** How uniform a silhouette may be before it stops looking like a character.
   *  A rectangular chunk of un-removed photo scores 1: every row is the same
   *  width. Anything with a head, a neck or legs varies well below this. */
  maxUniformity: 0.9,
  alphaThreshold: 128
} as const

const OPAQUE = (mask: Uint8Array, i: number): boolean => mask[i] >= CUTOUT_LIMITS.alphaThreshold

/** Judges whether a cutout isolated a character well enough to build a pet from.
 *
 *  Rejecting is deliberate: a bad cutout produces a pet that is visibly broken in
 *  every frame, and there is no segmentation model here to rescue it. Better to
 *  refuse with advice than to save something the user will only delete. */
export function assessCutout(
  mask: Uint8Array,
  width: number,
  height: number,
  source: CutoutSource
): CutoutVerdict {
  const total = width * height
  let opaque = 0
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!OPAQUE(mask, y * width + x)) {
        continue
      }
      opaque++
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

  if (opaque === 0) {
    return { ok: false, reason: 'subject-not-found' }
  }
  const bounds = { x0, y0, x1, y1 }
  // Why: an image that arrived with alpha was cut out by a person or a tool that
  // had more to work with than a corner fill. Only emptiness is refusable there.
  if (source === 'alpha') {
    return { ok: true, bounds }
  }

  const coverage = opaque / total
  if (coverage > CUTOUT_LIMITS.maxCoverage) {
    return { ok: false, reason: 'background-not-separable' }
  }
  if (coverage < CUTOUT_LIMITS.minCoverage) {
    return { ok: false, reason: 'subject-not-found' }
  }

  const touchesEveryEdge = x0 === 0 && y0 === 0 && x1 === width - 1 && y1 === height - 1
  if (touchesEveryEdge) {
    return { ok: false, reason: 'full-bleed' }
  }

  if (largestComponent(mask, width, height) / opaque < CUTOUT_LIMITS.minLargestComponentShare) {
    return { ok: false, reason: 'subject-fragmented' }
  }

  if (uniformity(mask, width, bounds) > CUTOUT_LIMITS.maxUniformity) {
    return { ok: false, reason: 'no-character-shape' }
  }

  return { ok: true, bounds }
}

function largestComponent(mask: Uint8Array, width: number, height: number): number {
  const seen = new Uint8Array(width * height)
  let largest = 0
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || !OPAQUE(mask, start)) {
      continue
    }
    let size = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const at = stack.pop() as number
      size++
      const ax = at % width
      const ay = (at / width) | 0
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ]) {
        const nx = ax + dx
        const ny = ay + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue
        }
        const next = ny * width + nx
        if (seen[next] || !OPAQUE(mask, next)) {
          continue
        }
        seen[next] = 1
        stack.push(next)
      }
    }
    if (size > largest) {
      largest = size
    }
  }
  return largest
}

/** How close the silhouette is to a rectangle, as narrowest row over widest.
 *
 *  This deliberately does NOT claim to find a head: without face detection any
 *  "head" rule is a guess that big-headed characters fail. What it does catch is
 *  the actual failure — a rectangular slab of background the fill could not
 *  remove, where the character is not distinguishable at all. */
function uniformity(mask: Uint8Array, width: number, bounds: CutoutBounds): number {
  let narrowest = Number.POSITIVE_INFINITY
  let widest = 0
  for (let y = bounds.y0; y <= bounds.y1; y++) {
    let rowWidth = 0
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      if (OPAQUE(mask, y * width + x)) {
        rowWidth++
      }
    }
    if (rowWidth === 0) {
      continue
    }
    if (rowWidth < narrowest) {
      narrowest = rowWidth
    }
    if (rowWidth > widest) {
      widest = rowWidth
    }
  }
  return widest === 0 ? 1 : narrowest / widest
}
