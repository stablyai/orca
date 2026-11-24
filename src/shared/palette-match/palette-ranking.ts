import { comparePaletteSemanticRank, type PaletteDocumentRank } from './palette-document'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export type PaletteSearchContext = { nowMs: number }

export type PaletteActivityRank = {
  ageBucket: number | null
  timestamp: number
}

export type PaletteEntityRankInput = {
  rank: PaletteDocumentRank
  activity: PaletteActivityRank
  position: number | readonly number[]
  identity: string
}

export function createPaletteSearchContext(nowMs: number): PaletteSearchContext {
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    throw new Error('Palette search context requires a finite positive nowMs')
  }
  return { nowMs }
}

export function preparePaletteActivity(
  value: number | null | undefined,
  context: PaletteSearchContext
): PaletteActivityRank {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return { ageBucket: null, timestamp: 0 }
  }
  const timestamp = Math.min(value as number, context.nowMs)
  const ageMs = context.nowMs - timestamp
  const ageBucket =
    ageMs < HOUR_MS
      ? 0
      : ageMs < DAY_MS
        ? 1
        : ageMs < WEEK_MS
          ? 2
          : 3 + Math.floor((ageMs - WEEK_MS) / WEEK_MS)
  return { ageBucket, timestamp }
}

/** Latest usable activity signal before evaluation-time future clamping. */
export function maxValidPaletteActivityTimestamp(
  values: readonly (number | null | undefined)[]
): number | null {
  let maximum: number | null = null
  for (const value of values) {
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      (maximum === null || value > maximum)
    ) {
      maximum = value
    }
  }
  return maximum
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Length-prefixing keeps identities collision-safe even when parts contain separators. */
export function encodePaletteIdentity(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('')
}

export function comparePaletteEntityRanks(
  a: PaletteEntityRankInput,
  b: PaletteEntityRankInput
): number {
  const semantic = comparePaletteSemanticRank(a.rank, b.rank)
  if (semantic !== 0) {
    return semantic
  }

  if (a.activity.ageBucket !== b.activity.ageBucket) {
    if (a.activity.ageBucket === null) {
      return 1
    }
    if (b.activity.ageBucket === null) {
      return -1
    }
    return a.activity.ageBucket - b.activity.ageBucket
  }
  if (a.rank.placement !== b.rank.placement) {
    return a.rank.placement - b.rank.placement
  }
  if (a.activity.timestamp !== b.activity.timestamp) {
    return b.activity.timestamp - a.activity.timestamp
  }
  const aPosition = typeof a.position === 'number' ? [a.position] : a.position
  const bPosition = typeof b.position === 'number' ? [b.position] : b.position
  const count = Math.max(aPosition.length, bPosition.length)
  for (let index = 0; index < count; index += 1) {
    const difference = (aPosition[index] ?? 0) - (bPosition[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return compareCodeUnits(a.identity, b.identity)
}
