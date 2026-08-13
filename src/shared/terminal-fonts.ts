export const DEFAULT_TERMINAL_FONT_WEIGHT = 500
export const TERMINAL_FONT_WEIGHT_MIN = 100
export const TERMINAL_FONT_WEIGHT_MAX = 900
export const TERMINAL_FONT_WEIGHT_STEP = 100
const DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 700
const FALLBACK_REGULAR_FACE = 400

export type TerminalFontWeightRaster = {
  weight: number
  ink: number
  sum: number
  advance: number
}

export function normalizeTerminalFontWeight(fontWeight: number | null | undefined): number {
  const numericFontWeight = typeof fontWeight === 'number' ? fontWeight : Number.NaN

  if (!Number.isFinite(numericFontWeight)) {
    return DEFAULT_TERMINAL_FONT_WEIGHT
  }

  return Math.min(
    TERMINAL_FONT_WEIGHT_MAX,
    Math.max(TERMINAL_FONT_WEIGHT_MIN, Math.round(numericFontWeight))
  )
}

function uniqueSortedFaces(faces: readonly number[]): number[] {
  return [
    ...new Set(
      faces.map((face) => normalizeTerminalFontWeight(face)).filter((face) => Number.isFinite(face))
    )
  ].sort((left, right) => left - right)
}

function nearestFace(target: number, faces: readonly number[]): number {
  return faces.reduce((best, face) =>
    Math.abs(face - target) < Math.abs(best - target) ? face : best
  )
}

function pickClusterRepresentative(weights: readonly number[]): number {
  if (weights.includes(FALLBACK_REGULAR_FACE)) {
    return FALLBACK_REGULAR_FACE
  }
  if (weights.includes(DEFAULT_TERMINAL_FONT_WEIGHT_BOLD)) {
    return DEFAULT_TERMINAL_FONT_WEIGHT_BOLD
  }
  return Math.min(...weights)
}

/** Collapse identical rasters into the CSS weights that first produce each face. */
export function clusterTerminalFontFaces(rasters: readonly TerminalFontWeightRaster[]): number[] {
  const groups = new Map<string, number[]>()
  for (const raster of rasters) {
    if (!Number.isFinite(raster.weight) || !Number.isFinite(raster.ink)) {
      continue
    }
    const key = `${raster.ink}:${raster.sum}:${raster.advance}`
    const group = groups.get(key)
    if (group) {
      group.push(raster.weight)
    } else {
      groups.set(key, [raster.weight])
    }
  }

  return [...groups.values()]
    .map(pickClusterRepresentative)
    .filter((weight) => Number.isFinite(weight))
    .sort((left, right) => left - right)
}

function resolveAgainstAvailableFaces(
  requested: number,
  faces: readonly number[]
): { fontWeight: number; fontWeightBold: number } {
  const sorted = uniqueSortedFaces(faces)
  if (sorted.length === 0) {
    // Why: two-face families (Menlo, Consolas, Cascadia Mono) raster 600–900
    // identically. Arithmetic +200 would pick a pair inside that one face.
    if (requested >= DEFAULT_TERMINAL_FONT_WEIGHT_BOLD - 100) {
      return {
        fontWeight: FALLBACK_REGULAR_FACE,
        fontWeightBold: DEFAULT_TERMINAL_FONT_WEIGHT_BOLD
      }
    }
    return {
      fontWeight: requested,
      fontWeightBold: Math.min(
        TERMINAL_FONT_WEIGHT_MAX,
        Math.max(DEFAULT_TERMINAL_FONT_WEIGHT_BOLD, requested + 200)
      )
    }
  }

  const onlyFace = sorted[0]
  if (sorted.length === 1 && onlyFace !== undefined) {
    return { fontWeight: onlyFace, fontWeightBold: onlyFace }
  }

  const regularCandidates = sorted.slice(0, -1)
  const regular = nearestFace(requested, regularCandidates)
  const heavier = sorted.filter((face) => face > regular)
  const desiredBold = Math.min(
    TERMINAL_FONT_WEIGHT_MAX,
    Math.max(DEFAULT_TERMINAL_FONT_WEIGHT_BOLD, requested + 200)
  )
  return {
    fontWeight: regular,
    fontWeightBold: nearestFace(desiredBold, heavier)
  }
}

export function resolveTerminalFontWeights(
  fontWeight: number | null | undefined,
  availableFaces?: readonly number[]
): {
  fontWeight: number
  fontWeightBold: number
} {
  return resolveAgainstAvailableFaces(normalizeTerminalFontWeight(fontWeight), availableFaces ?? [])
}
