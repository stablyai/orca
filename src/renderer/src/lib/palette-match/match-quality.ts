/** Per-token match strength, ordered best to worst. */
export const PALETTE_MATCH_QUALITIES = [
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix',
  'boundary-substring',
  'literal-substring',
  'compact',
  'typo'
] as const

export type PaletteMatchQuality = (typeof PALETTE_MATCH_QUALITIES)[number]

const QUALITY_RANK = new Map<PaletteMatchQuality, number>(
  PALETTE_MATCH_QUALITIES.map((quality, index) => [quality, index])
)

export function paletteMatchQualityRank(quality: PaletteMatchQuality): number {
  return QUALITY_RANK.get(quality) ?? PALETTE_MATCH_QUALITIES.length
}

export function isFuzzyPaletteMatchQuality(quality: PaletteMatchQuality): boolean {
  return quality === 'typo'
}

export function isExactPaletteMatchQuality(quality: PaletteMatchQuality): boolean {
  return quality === 'field-exact' || quality === 'word-exact'
}

export function isPrefixOrBoundaryPaletteMatchQuality(quality: PaletteMatchQuality): boolean {
  return quality === 'field-prefix' || quality === 'word-prefix' || quality === 'boundary-substring'
}

/**
 * Coarse cross-section strength used only to decide which palette section leads.
 * Kept small on purpose so sections never compare raw domain-specific scores.
 */
export const PALETTE_RESULT_QUALITY_CLASSES = [
  'exact-intent',
  'exact-visible',
  'visible-prefix',
  'exact-evidence',
  'partial-evidence',
  'fuzzy-evidence'
] as const

export type PaletteResultQualityClass = (typeof PALETTE_RESULT_QUALITY_CLASSES)[number]

const CLASS_RANK = new Map<PaletteResultQualityClass, number>(
  PALETTE_RESULT_QUALITY_CLASSES.map((value, index) => [value, index])
)

export function paletteResultQualityClassRank(value: PaletteResultQualityClass): number {
  return CLASS_RANK.get(value) ?? PALETTE_RESULT_QUALITY_CLASSES.length
}

/** Maps the worst token quality plus evidence usage onto the shared class. */
export function resolvePaletteResultQualityClass(args: {
  worstQuality: PaletteMatchQuality
  usesSupportingEvidence: boolean
  isContainerOnly?: boolean
}): PaletteResultQualityClass {
  const { worstQuality, usesSupportingEvidence, isContainerOnly } = args
  if (isFuzzyPaletteMatchQuality(worstQuality)) {
    return 'fuzzy-evidence'
  }
  if (isContainerOnly) {
    return isExactPaletteMatchQuality(worstQuality) ? 'exact-evidence' : 'partial-evidence'
  }
  if (usesSupportingEvidence) {
    return isExactPaletteMatchQuality(worstQuality) ? 'exact-evidence' : 'partial-evidence'
  }
  if (isExactPaletteMatchQuality(worstQuality)) {
    return 'exact-visible'
  }
  if (isPrefixOrBoundaryPaletteMatchQuality(worstQuality)) {
    return 'visible-prefix'
  }
  return 'partial-evidence'
}
