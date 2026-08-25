import {
  paletteResultQualityClassRank,
  type PaletteResultQualityClass
} from './palette-match/match-quality'
import { comparePaletteDocumentRank } from './palette-match/palette-document'
import type { PaletteDocumentRank } from './palette-match/palette-document'

// Why a shared class and not raw scores: each section's score encodes its own list
// position, so only a small common vocabulary can say which section holds the
// better hit. Lower ranks lead.
export const NO_PALETTE_QUALITY_RANK = Number.MAX_SAFE_INTEGER

export function paletteQualityRank(
  qualityClass: PaletteResultQualityClass | null | undefined
): number {
  return qualityClass ? paletteResultQualityClassRank(qualityClass) : NO_PALETTE_QUALITY_RANK
}

export function bestPaletteQualityRank(
  values: readonly (PaletteResultQualityClass | null | undefined)[]
): number {
  let best = NO_PALETTE_QUALITY_RANK
  for (const value of values) {
    best = Math.min(best, paletteQualityRank(value))
  }
  return best
}

export type PaletteRankedItem = {
  rank: PaletteDocumentRank | null
  /** Existing smart-recency / list position, used only after match rank ties. */
  order: number
  id: string
}

/** Match rank first, then the section's own recency order, then a stable id. */
export function comparePaletteRankedItems(a: PaletteRankedItem, b: PaletteRankedItem): number {
  if (a.rank && b.rank) {
    const byRank = comparePaletteDocumentRank(a.rank, b.rank)
    if (byRank !== 0) {
      return byRank
    }
  } else if (a.rank !== b.rank) {
    return a.rank ? -1 : 1
  }
  if (a.order !== b.order) {
    return a.order - b.order
  }
  return a.id.localeCompare(b.id)
}

/** Ties prefer Open Tabs, matching the documented section-leadership rule. */
export function shouldOpenTabsLeadPaletteSections(args: {
  bestWorktreeQualityRank: number
  bestOpenTabQualityRank: number
}): boolean {
  return args.bestOpenTabQualityRank <= args.bestWorktreeQualityRank
}

/**
 * A decisive settings/action/project intent may lead *weaker* entity hits only.
 * An entity that matched its own visible name exactly is not weaker, so typing a
 * workspace's exact name never sinks it under a same-named settings pane.
 */
export function shouldIntentSectionLeadPaletteSections(args: {
  bestEntityQualityRank: number
  bestIntentQualityRank: number
}): boolean {
  if (args.bestEntityQualityRank <= paletteQualityRank('exact-visible')) {
    return false
  }
  return args.bestIntentQualityRank < args.bestEntityQualityRank
}
