import {
  comparePaletteRankedItems,
  paletteQualityRank,
  type PaletteRankedItem
} from './cmd-j-section-leadership'
import type { PaletteResultQualityClass } from './palette-match/match-quality'

export type CmdJTranscriptRankedItem = PaletteRankedItem & {
  qualityClass: PaletteResultQualityClass | null
  transcript?: { complete: boolean; ordinal: number }
}

function protectedOrdinary(item: CmdJTranscriptRankedItem): boolean {
  return (
    (item.rank?.destination ?? 3) <= 1 ||
    paletteQualityRank(item.qualityClass) <= paletteQualityRank('exact-evidence')
  )
}

function presentationBand(item: CmdJTranscriptRankedItem): number {
  if (protectedOrdinary(item)) {
    return 0
  }
  if (item.transcript?.complete) {
    return 1
  }
  return item.rank || !item.transcript ? 2 : 3
}

/** Cmd+J's four bands leave ordinary comparisons within each band intact. */
export function compareCmdJTranscriptRankedItems(
  a: CmdJTranscriptRankedItem,
  b: CmdJTranscriptRankedItem
): number {
  const destination = Math.min(a.rank?.destination ?? 3, 2) - Math.min(b.rank?.destination ?? 3, 2)
  if (destination) {
    return destination
  }
  const band = presentationBand(a)
  const difference = band - presentationBand(b)
  if (difference) {
    return difference
  }
  if (band === 1 || band === 3) {
    const ordinal = (a.transcript?.ordinal ?? 0) - (b.transcript?.ordinal ?? 0)
    return ordinal || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)
  }
  return comparePaletteRankedItems(a, b)
}

/** Keeps the ordinary quality distinctions used by section leadership. */
export function cmdJEffectiveQualityRank(
  qualityClass: PaletteResultQualityClass | null,
  complete = false
): number {
  const ordinary = paletteQualityRank(qualityClass)
  return complete ? Math.min(ordinary, paletteQualityRank('exact-evidence') + 0.5) : ordinary
}
